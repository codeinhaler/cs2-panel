import { promises as fs } from "node:fs";
import path from "node:path";
import type { AuditLog } from "../audit.js";
import type { Db } from "../db.js";
import { badRequest, conflict, notFound } from "../errors.js";
import type { RconExec } from "../game/rcon.js";
import { exists } from "../servers/instance-files.js";
import type { InstanceFiles } from "../servers/instance-files.js";
import type { OperationGate, ServerService } from "../servers/service.js";
import type { ServerRecord } from "../servers/store.js";
import { slugify } from "../servers/validation.js";
import { extractArchive, isPreservedConfig, listFiles, mapArchiveFiles } from "./archive.js";
import { CATALOG, catalogEntry, dependencyOrder, type CatalogEntry, type DatabaseSettings } from "./catalog.js";
import type { PluginRelease, PluginSources } from "./sources.js";

interface InstallRow {
  id: number;
  server_id: number;
  plugin_id: string;
  name: string;
  version: string;
  asset: string;
  files: string;
  installed_at: string;
  installed_by: number | null;
  removed_at: string | null;
  installer_name?: string | null;
}

export interface PluginStatus {
  id: string;
  name: string;
  description: string;
  homepage: string | null;
  requires: string[];
  custom: boolean;
  installed: { version: string; installedAt: string; installedBy: string | null } | null;
  /** Installed plugins that need this one. */
  dependents: string[];
  /** Earlier version available for rollback. */
  previousVersion: string | null;
  latest: string | null;
  latestError: string | null;
  library: boolean;
  /** Set if the plugin can use the shared database: what that gives you. */
  databaseBenefit: string | null;
}

export interface HealthReport {
  reachable: boolean;
  error: string | null;
  metamodLoaded: boolean;
  cssharpLoaded: boolean;
  metamodOutput: string;
  cssharpOutput: string;
}

interface Prepared {
  id: string;
  name: string;
  version: string;
  asset: string;
  extractDir: string;
  mapping: Map<string, string>;
}

export interface PluginInstallSnapshot {
  pluginId: string;
  name: string;
  version: string;
  asset: string;
  files: string;
  installedAt: string;
}

export class PluginService {
  private busy = new Set<number>();
  /** Run after plugin files change on a server (overlay unmounted), e.g. to write the ban list. */
  readonly afterApply: ((server: ServerRecord, pluginIds: string[]) => Promise<void>)[] = [];

  constructor(
    private readonly db: Db,
    private readonly sources: PluginSources,
    private readonly servers: ServerService,
    private readonly files: InstanceFiles,
    private readonly audit: AuditLog,
    private readonly gate: OperationGate,
    private readonly rcon: RconExec,
    private readonly workDir: string,
    private readonly database: DatabaseSettings | undefined,
  ) {}

  get databaseConfigured(): boolean {
    return !!this.database;
  }

  // ------------------------------------------------------------- reading

  private current(serverId: number): InstallRow[] {
    return this.db
      .prepare(
        `SELECT p.*, u.display_name AS installer_name FROM plugin_installs p LEFT JOIN users u ON u.id = p.installed_by
         WHERE p.server_id = ? AND p.removed_at IS NULL ORDER BY p.id`,
      )
      .all(serverId) as unknown as InstallRow[];
  }

  private currentOne(serverId: number, pluginId: string): InstallRow | undefined {
    return this.current(serverId).find((r) => r.plugin_id === pluginId);
  }

  installedIds(serverId: number): string[] {
    return this.current(serverId).map((r) => r.plugin_id);
  }

  private previousVersion(serverId: number, pluginId: string, currentVersion: string | undefined): InstallRow | undefined {
    const rows = this.db
      .prepare("SELECT * FROM plugin_installs WHERE server_id = ? AND plugin_id = ? ORDER BY id DESC")
      .all(serverId, pluginId) as unknown as InstallRow[];
    return rows.find((r) => r.version !== currentVersion && r.removed_at !== null);
  }

  /** Server settings that stop installed plugins from working properly. */
  async warnings(serverId: number): Promise<string[]> {
    const s = this.servers.require(serverId);
    const out: string[] = [];
    if (this.installedIds(serverId).includes("counterstrikesharp")) {
      const cfg = await fs.readFile(path.join(this.files.cfgDir(s.slug), "server.cfg"), "utf8").catch(() => "");
      const lines = cfg.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").trim());
      const last = lines.filter((l) => /^sv_hibernate_when_empty\s/.test(l)).at(-1);
      if (last && !/\s"?0"?$/.test(last)) {
        out.push(
          "This server hibernates when empty (sv_hibernate_when_empty 1 in cfg/server.cfg). That pauses CounterStrikeSharp plugins, so their commands may not exist until someone joins. Set it to 0 in Config files.",
        );
      }
    }
    return out;
  }

  async overview(serverId: number, refresh = false): Promise<PluginStatus[]> {
    this.servers.require(serverId);
    const current = this.current(serverId);
    const installed = new Map(current.map((r) => [r.plugin_id, r]));
    const lookups = await Promise.all(
      CATALOG.map(async (e) => {
        try {
          const rel = await this.sources.releases(e, refresh);
          return { latest: (rel.find((r) => !r.prerelease && r.asset) ?? rel[0])?.version ?? null, error: null };
        } catch (err) {
          return { latest: null, error: (err as Error).message };
        }
      }),
    );
    const requiresOf = (id: string) => catalogEntry(id)?.requires ?? [];
    const statusFor = (id: string, base: Omit<PluginStatus, "installed" | "dependents" | "previousVersion">): PluginStatus => {
      const row = installed.get(id);
      return {
        ...base,
        installed: row ? { version: row.version, installedAt: row.installed_at, installedBy: row.installer_name ?? null } : null,
        dependents: current.filter((r) => requiresOf(r.plugin_id).includes(id)).map((r) => r.name),
        previousVersion: row ? (this.previousVersion(serverId, id, row.version)?.version ?? null) : null,
      };
    };
    const list = CATALOG.map((e, i) =>
      statusFor(e.id, {
        id: e.id,
        name: e.name,
        description: e.description,
        homepage: e.homepage,
        requires: e.requires,
        custom: false,
        latest: lookups[i]!.latest,
        latestError: lookups[i]!.error,
        library: !!e.library,
        databaseBenefit: e.database?.benefit ?? null,
      }),
    );
    for (const r of current.filter((r) => r.plugin_id.startsWith("custom:"))) {
      list.push(
        statusFor(r.plugin_id, {
          id: r.plugin_id,
          name: r.name,
          description: "Uploaded by hand.",
          homepage: null,
          requires: [],
          custom: true,
          latest: null,
          latestError: null,
          library: false,
          databaseBenefit: null,
        }),
      );
    }
    return list;
  }

  async versions(pluginId: string): Promise<PluginRelease[]> {
    const entry = catalogEntry(pluginId);
    if (!entry) throw notFound("Unknown plugin.");
    return this.sources.releases(entry, true);
  }

  // ------------------------------------------------------------- changes

  private async lock<T>(serverId: number, fn: () => Promise<T>): Promise<T> {
    this.gate.assertFree();
    if (this.busy.has(serverId)) throw conflict("Another plugin change is already running for this server.");
    this.busy.add(serverId);
    try {
      return await fn();
    } finally {
      this.busy.delete(serverId);
    }
  }

  /** Installs or updates a catalog plugin, installing missing dependencies first. */
  /** A plugin change is running for this server right now (it may be restarting). */
  isBusy(serverId: number): boolean {
    return this.busy.has(serverId);
  }

  /** The installed version of a plugin, or null. */
  installedVersion(serverId: number, pluginId: string): string | null {
    return this.currentOne(serverId, pluginId)?.version ?? null;
  }

  /** The newest version the panel can install (for the bridge: the one in this panel release). */
  async latestVersion(pluginId: string): Promise<string | null> {
    const entry = catalogEntry(pluginId);
    if (!entry) return null;
    const rel = await this.sources.releases(entry).catch(() => []);
    return (rel.find((r) => !r.prerelease && r.asset) ?? null)?.version ?? null;
  }

  /** actorId null: the panel did it by itself (automatic bridge update). */
  async install(serverId: number, pluginId: string, version: string | undefined, actorId: number | null) {
    const entry = catalogEntry(pluginId);
    if (!entry) throw notFound("Unknown plugin.");
    return this.lock(serverId, async () => {
      const server = this.servers.require(serverId);
      const have = new Set(this.installedIds(serverId));
      const from = this.currentOne(serverId, pluginId)?.version ?? null;
      const plan = [...dependencyOrder(pluginId).filter((d) => !have.has(d)), pluginId];
      // Companions (the panel's own bridge) come along with the plugin they belong to.
      for (const id of [...plan]) {
        for (const c of CATALOG.filter((e) => e.companionOf === id && !have.has(e.id) && !plan.includes(e.id))) {
          if ((await this.sources.releases(c).catch(() => [])).some((r) => r.asset)) plan.push(c.id);
        }
      }
      const prepared: Prepared[] = [];
      try {
        for (const id of plan) {
          const e = catalogEntry(id)!;
          const release = await this.pickRelease(e, id === pluginId ? version : undefined);
          prepared.push(await this.prepare(e.id, e.name, release, e.looseDir));
        }
        const { restarted } = await this.apply(server, prepared, actorId);
        const summary = prepared.map((p) => ({ id: p.id, version: p.version }));
        this.audit.record(actorId, have.has(pluginId) ? "plugin.update" : "plugin.install", serverId, {
          plugin: entry.name,
          version: prepared.at(-1)!.version,
          alsoInstalled: prepared.slice(0, -1).map((p) => `${p.name} ${p.version}`),
          restarted,
          ...(actorId === null ? { automatic: true, from } : {}),
        });
        return { installed: summary, restarted };
      } finally {
        await this.cleanup(prepared);
      }
    });
  }

  /** Reinstalls the version that was installed before the current one. */
  async rollback(serverId: number, pluginId: string, actorId: number) {
    return this.lock(serverId, async () => {
      const server = this.servers.require(serverId);
      const cur = this.currentOne(serverId, pluginId);
      if (!cur) throw badRequest("That plugin isn't installed.");
      const prev = this.previousVersion(serverId, pluginId, cur.version);
      if (!prev) throw badRequest("There's no earlier version to go back to.");
      const release: PluginRelease = { version: prev.version, publishedAt: null, prerelease: false, asset: { name: prev.asset, url: "", size: null } };
      const entry = catalogEntry(pluginId);
      // Prefer the cached archive; fall back to the source if it still offers that version.
      let resolved = release;
      if (entry) {
        const fromSource = (await this.sources.releases(entry).catch(() => [])).find((r) => r.version === prev.version && r.asset);
        if (fromSource) resolved = fromSource;
      }
      const prepared = [await this.prepare(pluginId, cur.name, resolved, entry?.looseDir ?? customDir(pluginId))];
      try {
        const { restarted } = await this.apply(server, prepared, actorId);
        this.audit.record(actorId, "plugin.rollback", serverId, { plugin: cur.name, from: cur.version, to: prev.version, restarted });
        return { version: prev.version, restarted };
      } finally {
        await this.cleanup(prepared);
      }
    });
  }

  async uninstall(serverId: number, pluginId: string, actorId: number) {
    return this.lock(serverId, async () => {
      const server = this.servers.require(serverId);
      const cur = this.currentOne(serverId, pluginId);
      if (!cur) throw badRequest("That plugin isn't installed.");
      const dependents = this.current(serverId).filter((r) => (catalogEntry(r.plugin_id)?.requires ?? []).includes(pluginId));
      if (dependents.length) throw badRequest(`Remove ${dependents.map((d) => d.name).join(", ")} first; it needs ${cur.name}.`);
      const { restarted } = await this.servers.withUnmounted(server, { restart: true }, async () => {
        await this.removeFiles(server, JSON.parse(cur.files) as string[]);
        this.db.prepare("UPDATE plugin_installs SET removed_at = datetime('now') WHERE id = ?").run(cur.id);
        await this.files.regenerateGameinfo(server.slug);
      });
      this.audit.record(actorId, "plugin.remove", serverId, { plugin: cur.name, version: cur.version, restarted });
      return { restarted };
    });
  }

  /** Installs an archive uploaded by the Owner. */
  async installUpload(serverId: number, fileName: string, data: Buffer, actorId: number) {
    if (!/\.(zip|tar\.gz|tgz)$/i.test(fileName)) throw badRequest("Upload a .zip or .tar.gz file.");
    if (data.length === 0) throw badRequest("The file is empty.");
    const base = fileName.replace(/\.(zip|tar\.gz|tgz)$/i, "").replace(/[-_ ]v?\d[\w.]*$/, "");
    const name =
      base
        .replace(/[^\w .-]/g, "")
        .trim()
        .slice(0, 48) || "Custom plugin";
    const pluginId = `custom:${slugify(name)}`;
    if (catalogEntry(pluginId.slice(7))) throw badRequest(`${name} is in the catalog; install it from there instead.`);
    return this.lock(serverId, async () => {
      const server = this.servers.require(serverId);
      const version = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      const archive = await this.sources.storeUpload(pluginId.replace(":", "_"), version, fileName, data);
      const release: PluginRelease = { version, publishedAt: null, prerelease: false, asset: { name: path.basename(archive), url: "", size: data.length } };
      const prepared = [await this.prepareFromArchive(pluginId, name, release, archive, customDir(pluginId))];
      try {
        const { restarted } = await this.apply(server, prepared, actorId);
        this.audit.record(actorId, "plugin.upload", serverId, { plugin: name, file: fileName, files: prepared[0]!.mapping.size, restarted });
        return { pluginId, name, version, restarted };
      } finally {
        await this.cleanup(prepared);
      }
    });
  }

  /** Copies another server's plugin records (Duplicate copies the files themselves). */
  /** The plugin records a backup keeps, so a restore can put the Plugins tab back as it was. */
  snapshotInstalls(serverId: number): PluginInstallSnapshot[] {
    return this.current(serverId).map((r) => ({
      pluginId: r.plugin_id,
      name: r.name,
      version: r.version,
      asset: r.asset,
      files: r.files,
      installedAt: r.installed_at,
    }));
  }

  /** Replaces a server's plugin records with the ones from a backup (its files are restored separately). */
  restoreInstalls(serverId: number, rows: PluginInstallSnapshot[], actorId: number | null): void {
    this.db.prepare("UPDATE plugin_installs SET removed_at = datetime('now') WHERE server_id = ? AND removed_at IS NULL").run(serverId);
    for (const r of rows) {
      this.db
        .prepare("INSERT INTO plugin_installs (server_id, plugin_id, name, version, asset, files, installed_at, installed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(serverId, r.pluginId, r.name, r.version, r.asset, r.files, r.installedAt, actorId);
    }
  }

  copyInstalls(fromServerId: number, toServerId: number): void {
    for (const r of this.current(fromServerId)) {
      this.db
        .prepare("INSERT INTO plugin_installs (server_id, plugin_id, name, version, asset, files, installed_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(toServerId, r.plugin_id, r.name, r.version, r.asset, r.files, r.installed_by);
    }
  }

  // ------------------------------------------------------------- health

  /** Asks the running server, over RCON, whether Metamod and CounterStrikeSharp loaded. */
  async health(serverId: number): Promise<HealthReport> {
    const s = this.servers.require(serverId);
    const report: HealthReport = { reachable: false, error: null, metamodLoaded: false, cssharpLoaded: false, metamodOutput: "", cssharpOutput: "" };
    try {
      report.metamodOutput = (await this.rcon({ port: s.port, password: s.rconPassword, timeoutMs: 4000 }, "meta list")).trim();
      report.reachable = true;
      report.metamodLoaded = report.metamodOutput !== "" && !/unknown command/i.test(report.metamodOutput);
      report.cssharpLoaded = report.metamodLoaded && /counterstrikesharp/i.test(report.metamodOutput);
      if (report.cssharpLoaded) {
        report.cssharpOutput = (await this.rcon({ port: s.port, password: s.rconPassword, timeoutMs: 4000 }, "css_plugins list")).trim();
      }
    } catch (e) {
      report.error = (e as Error).message;
    }
    return report;
  }

  /** One-line health summary per server, for the CS2 update log. */
  async healthLines(servers: ServerRecord[]): Promise<string[]> {
    const lines: string[] = [];
    for (const s of servers) {
      const ids = this.installedIds(s.id);
      if (!ids.includes("metamod")) continue;
      const h = await this.health(s.id);
      if (!h.reachable) lines.push(`  ${s.name}: WARNING could not check plugins (${h.error})`);
      else if (!h.metamodLoaded) lines.push(`  ${s.name}: WARNING Metamod did not load. Plugins are not running.`);
      else if (ids.includes("counterstrikesharp") && !h.cssharpLoaded)
        lines.push(`  ${s.name}: WARNING CounterStrikeSharp did not load. It may need an update for this CS2 version.`);
      else lines.push(`  ${s.name}: plugins loaded`);
    }
    return lines;
  }

  // ------------------------------------------------------------- internals

  private async pickRelease(entry: CatalogEntry, version: string | undefined): Promise<PluginRelease> {
    const releases = await this.sources.releases(entry);
    const usable = releases.filter((r) => r.asset);
    const release = version ? usable.find((r) => r.version === version) : (usable.find((r) => !r.prerelease) ?? usable[0]);
    if (!release) {
      throw badRequest(version ? `${entry.name} ${version} has no Linux download.` : `Couldn't find a Linux download for ${entry.name}.`);
    }
    return release;
  }

  private async prepare(id: string, name: string, release: PluginRelease, looseDir?: string): Promise<Prepared> {
    let archive: string;
    try {
      archive = await this.sources.download(id.replace(":", "_"), release);
    } catch (e) {
      throw badRequest(`Downloading ${name} failed: ${(e as Error).message}`);
    }
    return this.prepareFromArchive(id, name, release, archive, looseDir);
  }

  private async prepareFromArchive(id: string, name: string, release: PluginRelease, archive: string, looseDir?: string): Promise<Prepared> {
    const extractDir = await fs.mkdtemp(path.join(await this.ensureWorkDir(), "extract-"));
    try {
      await extractArchive(archive, extractDir);
    } catch (e) {
      await fs.rm(extractDir, { recursive: true, force: true });
      throw badRequest(`Unpacking ${name} failed: ${(e as Error).message}`);
    }
    const mapping = mapArchiveFiles(await listFiles(extractDir), looseDir);
    if (mapping.size === 0) {
      await fs.rm(extractDir, { recursive: true, force: true });
      throw badRequest(`${name}'s archive doesn't contain anything the panel knows where to put.`);
    }
    return { id, name, version: release.version, asset: path.basename(archive), extractDir, mapping };
  }

  private async ensureWorkDir(): Promise<string> {
    await fs.mkdir(this.workDir, { recursive: true });
    return this.workDir;
  }

  private async cleanup(prepared: Prepared[]): Promise<void> {
    for (const p of prepared) await fs.rm(p.extractDir, { recursive: true, force: true });
  }

  /** Writes prepared plugins into the server's layer with the overlay down, then restarts it if it was running. */
  private async apply(server: ServerRecord, prepared: Prepared[], actorId: number | null) {
    return this.servers.withUnmounted(server, { restart: true }, async () => {
      for (const p of prepared) await this.applyOne(server, p, actorId);
      await this.files.regenerateGameinfo(server.slug);
      for (const hook of this.afterApply)
        await hook(
          server,
          prepared.map((p) => p.id),
        );
    });
  }

  private async applyOne(server: ServerRecord, p: Prepared, actorId: number | null): Promise<void> {
    const csgo = path.join(this.files.upperDir(server.slug), "game", "csgo");
    const prev = this.currentOne(server.id, p.id);
    const newFiles = new Set(p.mapping.values());
    if (prev) {
      // Files the old version had and the new one doesn't.
      await this.removeFiles(
        server,
        (JSON.parse(prev.files) as string[]).filter((f) => !newFiles.has(f)),
      );
    }
    for (const [src, dest] of p.mapping) {
      const target = path.join(csgo, dest);
      if (isPreservedConfig(dest) && (await exists(target))) continue;
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o2775 });
      await fs.cp(path.join(p.extractDir, src), target, { force: true });
      const mode = (await fs.stat(target)).mode;
      await fs.chmod(target, (mode & 0o777) | 0o664);
    }
    await this.configureDatabase(p.id, csgo);
    if (prev) this.db.prepare("UPDATE plugin_installs SET removed_at = datetime('now') WHERE id = ?").run(prev.id);
    this.db
      .prepare("INSERT INTO plugin_installs (server_id, plugin_id, name, version, asset, files, installed_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(server.id, p.id, p.name, p.version, p.asset, JSON.stringify([...newFiles].sort()), actorId);
  }

  /** Deletes plugin files (never config files), then empty folders left behind. Overlay must be down. */
  private async removeFiles(server: ServerRecord, rels: string[]): Promise<void> {
    await this.files.assertUnmounted(server.slug);
    const csgo = path.join(this.files.upperDir(server.slug), "game", "csgo");
    const dirs = new Set<string>();
    for (const rel of rels) {
      if (!rel.startsWith("addons/") || rel.split("/").includes("..") || isPreservedConfig(rel)) continue;
      await fs.rm(path.join(csgo, rel), { force: true });
      for (let d = path.posix.dirname(rel); d !== "addons" && d !== "."; d = path.posix.dirname(d)) dirs.add(d);
    }
    // Deepest first, so parents are empty by the time we reach them.
    for (const d of [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)) {
      await fs.rmdir(path.join(csgo, d)).catch(() => undefined);
    }
  }

  /** Writes the shared database settings into the plugin's config, if it declares one. */
  private async configureDatabase(pluginId: string, csgo: string): Promise<void> {
    const integration = catalogEntry(pluginId)?.database;
    if (!integration || !this.database) return;
    const file = path.join(csgo, integration.configFile);
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      /* first install: the plugin fills in its other defaults */
    }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o2775 });
    await fs.writeFile(file, JSON.stringify(integration.apply(config, this.database), null, 2) + "\n", { mode: 0o660 });
  }
}

function customDir(pluginId: string): string {
  return `plugins/${pluginId.replace(/^custom:/, "")}`;
}
