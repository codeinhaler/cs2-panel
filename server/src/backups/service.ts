import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { AuditLog } from "../audit.js";
import { lastSlot } from "../automation/restarts.js";
import type { Db } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import type { GameUpdater } from "../game/updater.js";
import type { Host } from "../host/host.js";
import type { PluginInstallSnapshot, PluginService } from "../plugins/service.js";
import type { ExecConfigService } from "../servers/exec-configs.js";
import type { OperationGate, ServerService } from "../servers/service.js";
import type { ServerRecord } from "../servers/store.js";
import type { Settings } from "../settings.js";

export type BackupTrigger = "manual" | "nightly" | "before-restore";

export interface BackupInfo {
  /** "server/<slug>/<file>" or "panel/<file>"; what the API uses to point at a backup. */
  id: string;
  kind: "server" | "panel";
  file: string;
  serverId: number | null;
  serverName: string | null;
  sizeBytes: number;
  createdAt: string;
  createdBy: string | null;
  trigger: BackupTrigger;
}

export interface BackupSettings {
  /** Nightly backups of every server and the panel's database. */
  enabled: boolean;
  /** "HH:MM", the panel host's local time. */
  time: string;
  /** How many nightly backups to keep per server (and of the database); manual ones stay until deleted. */
  keep: number;
}

const DEFAULT_SETTINGS: BackupSettings = { enabled: true, time: "04:30", keep: 7 };
const SERVER_FILE_RE = /^[a-z0-9][a-z0-9-]{0,31}-\d{8}-\d{6}\.tar\.gz$/;
const PANEL_FILE_RE = /^panel-\d{8}-\d{6}\.db$/;
const ID_RE = /^(?:server\/([a-z0-9][a-z0-9-]{0,31})\/([^/]+)|panel\/([^/]+))$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** What the panel stores next to each archive, so a restore also puts back what the panel knows. */
interface Sidecar {
  serverId: number | null;
  serverName: string | null;
  createdAt: string;
  createdBy: string | null;
  trigger: BackupTrigger;
  plugins?: PluginInstallSnapshot[];
  execConfigs?: string[];
}

export class BackupService {
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly host: Host,
    private readonly servers: ServerService,
    private readonly plugins: PluginService,
    private readonly execConfigs: ExecConfigService,
    private readonly gate: OperationGate,
    private readonly updater: GameUpdater,
    private readonly audit: AuditLog,
    /** cs2Root/backups: server archives live in servers/<slug>/. */
    private readonly cs2Backups: string,
    /** dataDir/backups: copies of the panel's database. */
    private readonly panelBackups: string,
  ) {}

  config(): BackupSettings {
    return { ...DEFAULT_SETTINGS, ...this.settings.get<Partial<BackupSettings>>("backup.settings", {}) };
  }

  setConfig(next: BackupSettings, actorId: number): BackupSettings {
    if (!TIME_RE.test(next.time)) throw badRequest("Enter the time as HH:MM, like 04:30.");
    if (!Number.isInteger(next.keep) || next.keep < 1 || next.keep > 60) throw badRequest("Keep between 1 and 60 backups.");
    const clean = { enabled: !!next.enabled, time: next.time, keep: next.keep };
    this.settings.set("backup.settings", clean);
    // Changing the time shouldn't fire a backup for a slot that already passed today.
    this.settings.set("backup.handled", lastSlot(clean.time, new Date())?.toISOString() ?? null);
    this.audit.record(actorId, "backup.settings", null, { ...clean });
    return clean;
  }

  private userName(id: number | null): string | null {
    if (!id) return null;
    return (this.db.prepare("SELECT COALESCE(display_name, steam_id) AS n FROM users WHERE id = ?").get(id) as { n: string } | undefined)?.n ?? null;
  }

  // ------------------------------------------------------------------ list

  async list(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = [];
    const serversDir = path.join(this.cs2Backups, "servers");
    for (const slug of await readdirSafe(serversDir)) {
      for (const file of await readdirSafe(path.join(serversDir, slug))) {
        if (!SERVER_FILE_RE.test(file)) continue;
        out.push(await this.info("server", path.join(serversDir, slug, file), `server/${slug}/${file}`, file));
      }
    }
    for (const file of await readdirSafe(this.panelBackups)) {
      if (!PANEL_FILE_RE.test(file)) continue;
      out.push(await this.info("panel", path.join(this.panelBackups, file), `panel/${file}`, file));
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async info(kind: "server" | "panel", full: string, id: string, file: string): Promise<BackupInfo> {
    const st = await fs.stat(full);
    const side = await this.sidecar(full);
    return {
      id,
      kind,
      file,
      serverId: side?.serverId ?? null,
      serverName: side?.serverName ?? null,
      sizeBytes: st.size,
      createdAt: side?.createdAt ?? st.mtime.toISOString(),
      createdBy: side?.createdBy ?? null,
      trigger: side?.trigger ?? "manual",
    };
  }

  private async sidecar(full: string): Promise<Sidecar | null> {
    try {
      return JSON.parse(await fs.readFile(`${full}.json`, "utf8")) as Sidecar;
    } catch {
      return null;
    }
  }

  /** The file behind an id, refusing anything outside the backup folders. */
  resolve(id: string): { kind: "server" | "panel"; full: string; slug: string | null; file: string } {
    const m = ID_RE.exec(id);
    if (!m) throw badRequest("Unknown backup.");
    if (m[1]) {
      if (!SERVER_FILE_RE.test(m[2]!)) throw badRequest("Unknown backup.");
      return { kind: "server", full: path.join(this.cs2Backups, "servers", m[1], m[2]!), slug: m[1], file: m[2]! };
    }
    if (!PANEL_FILE_RE.test(m[3]!)) throw badRequest("Unknown backup.");
    return { kind: "panel", full: path.join(this.panelBackups, m[3]!), slug: null, file: m[3]! };
  }

  async open(id: string): Promise<{ stream: NodeJS.ReadableStream; file: string; size: number }> {
    const r = this.resolve(id);
    const st = await fs.stat(r.full).catch(() => null);
    if (!st) throw notFound("Backup not found.");
    return { stream: createReadStream(r.full), file: r.file, size: st.size };
  }

  async delete(id: string, actorId: number | null): Promise<void> {
    const r = this.resolve(id);
    await fs.rm(r.full).catch(() => {
      throw notFound("Backup not found.");
    });
    await fs.rm(`${r.full}.json`, { force: true });
    if (actorId !== null) this.audit.record(actorId, "backup.delete", null, { file: r.file });
  }

  // ---------------------------------------------------------------- create

  async backupServer(s: ServerRecord, actorId: number | null, trigger: BackupTrigger): Promise<BackupInfo> {
    const file = await this.host.backupServer(s.slug);
    const full = path.join(this.cs2Backups, "servers", s.slug, file);
    const side: Sidecar = {
      serverId: s.id,
      serverName: s.name,
      createdAt: new Date().toISOString(),
      createdBy: this.userName(actorId),
      trigger,
      plugins: this.plugins.snapshotInstalls(s.id),
      execConfigs: this.execConfigs.get(s.id),
    };
    await fs.writeFile(`${full}.json`, JSON.stringify(side, null, 2), { mode: 0o640 });
    this.audit.record(actorId, "backup.create", s.id, { file, trigger });
    return this.info("server", full, `server/${s.slug}/${file}`, file);
  }

  /** A consistent copy of the panel's database, taken while it runs. */
  async backupPanel(actorId: number | null, trigger: BackupTrigger): Promise<BackupInfo> {
    await fs.mkdir(this.panelBackups, { recursive: true, mode: 0o750 });
    let file = `panel-${stamp(new Date())}.db`;
    // Two copies within one second (only ever in tests) get the next second's name.
    for (let i = 1; await exists(path.join(this.panelBackups, file)); i++) file = `panel-${stamp(new Date(Date.now() + i * 1000))}.db`;
    const full = path.join(this.panelBackups, file);
    this.db.prepare("VACUUM INTO ?").run(full);
    await fs.chmod(full, 0o640);
    const side: Sidecar = { serverId: null, serverName: null, createdAt: new Date().toISOString(), createdBy: this.userName(actorId), trigger };
    await fs.writeFile(`${full}.json`, JSON.stringify(side, null, 2), { mode: 0o640 });
    this.audit.record(actorId, "backup.create", null, { file, trigger });
    return this.info("panel", full, `panel/${file}`, file);
  }

  // --------------------------------------------------------------- restore

  /**
   * Puts a server's files back as they were in a backup, plus its plugin list and
   * configs to run. Settings like port and name stay as they are now. A backup of
   * the current state is taken first, and the server restarts if it was running.
   */
  async restore(id: string, actorId: number): Promise<{ safetyBackup: string; restarted: boolean }> {
    const r = this.resolve(id);
    if (r.kind !== "server") throw badRequest("The panel's database is restored with deploy/restore-db.sh on the server, not from here.");
    if (!(await exists(r.full))) throw notFound("Backup not found.");
    const side = await this.sidecar(r.full);
    const s = this.servers.listRecords().find((x) => x.slug === r.slug && (side?.serverId == null || x.id === side.serverId));
    if (!s) throw badRequest("The server this backup belongs to no longer exists.");
    this.gate.assertFree();
    if (this.updater.job.state === "running") throw badRequest("Wait for the CS2 update to finish.");

    const safety = await this.backupServer(s, actorId, "before-restore");
    const { restarted } = await this.gate.run(`restoring ${s.name}`, () =>
      this.servers.withUnmounted(s, { restart: true }, async () => {
        await this.host.restoreServer(s.slug, r.file);
        if (side?.plugins) this.plugins.restoreInstalls(s.id, side.plugins, actorId);
      }),
    );
    if (side?.execConfigs) await this.execConfigs.set(s, side.execConfigs, actorId).catch(() => undefined);
    this.audit.record(actorId, "backup.restore", s.id, { file: r.file, safetyBackup: safety.file });
    return { safetyBackup: safety.file, restarted };
  }

  // ----------------------------------------------------------------- nightly

  /** Called every minute by the scheduler. */
  async tick(now = new Date()): Promise<void> {
    const cfg = this.config();
    if (!cfg.enabled || this.running) return;
    const slot = lastSlot(cfg.time, now);
    if (!slot) return;
    const handled = this.settings.get<string | null>("backup.handled", null);
    if (handled && Date.parse(handled) >= slot.getTime()) return;
    // Missed by more than six hours (panel was off): wait for tomorrow.
    if (now.getTime() - slot.getTime() > 6 * 3_600_000) {
      this.settings.set("backup.handled", slot.toISOString());
      return;
    }
    if (this.gate.busy || this.updater.job.state === "running") return; // try again next minute
    this.settings.set("backup.handled", slot.toISOString());
    this.running = this.nightly(cfg.keep).finally(() => {
      this.running = null;
    });
    await this.running;
  }

  private async nightly(keep: number): Promise<void> {
    try {
      await this.backupPanel(null, "nightly");
    } catch (e) {
      this.audit.record(null, "backup.failed", null, { what: "panel database", error: (e as Error).message });
    }
    for (const s of this.servers.listRecords()) {
      try {
        await this.backupServer(s, null, "nightly");
      } catch (e) {
        this.audit.record(null, "backup.failed", s.id, { what: s.name, error: (e as Error).message });
      }
    }
    await this.prune(keep);
  }

  /** Keeps the newest `keep` nightly backups per server and of the database. */
  private async prune(keep: number): Promise<void> {
    const groups = new Map<string, BackupInfo[]>();
    for (const b of await this.list()) {
      if (b.trigger !== "nightly") continue;
      const key = b.kind === "panel" ? "panel" : b.id.split("/")[1]!;
      groups.set(key, [...(groups.get(key) ?? []), b]);
    }
    for (const list of groups.values()) {
      for (const old of list.slice(keep)) await this.delete(old.id, null).catch(() => undefined);
    }
  }

  /** Waits for a running nightly backup (tests). */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
