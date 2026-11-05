import type { AuditLog } from "../audit.js";
import { randomPassword, randomToken } from "../crypto.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import type { Host, ServiceStatus } from "../host/host.js";
import { queryInfo, type A2sInfo } from "../game/a2s.js";
import type { ConfigService } from "./configs.js";
import type { InstanceFiles } from "./instance-files.js";
import type { PresetStore } from "./presets.js";
import type { ServerRecord, ServerStore } from "./store.js";
import {
  CreateServerSchema,
  DuplicateServerSchema,
  UpdateServerSchema,
  portProblem,
  slugify,
  type CreateServerInput,
  type DuplicateServerInput,
  type UpdateServerInput,
} from "./validation.js";

/** Serialises long operations (game updates) against server actions. */
export class OperationGate {
  busy: string | null = null;

  assertFree(): void {
    if (this.busy) throw conflict(`Not possible right now: ${this.busy} is in progress.`);
  }
}

export interface Actor {
  id: number;
  can: (permission: "server.rawargs" | "server.delete") => boolean;
}

/** What the browser sees for a server. */
export interface ServerView {
  id: number;
  slug: string;
  name: string;
  presetId: number | null;
  presetName: string | null;
  port: number;
  cpu: number;
  map: string;
  gameType: number;
  gameMode: number;
  maxPlayers: number;
  password: string;
  gsltSet: boolean;
  gsltHint: string | null;
  extraArgs: string;
  autostart: boolean;
  createdAt: string;
  status: ServiceStatus;
  live: A2sInfo | null;
}

export type ControlAction = "start" | "stop" | "restart" | "kill";

export class ServerService {
  constructor(
    private readonly store: ServerStore,
    private readonly presets: PresetStore,
    private readonly files: InstanceFiles,
    private readonly configs: ConfigService,
    private readonly host: Host,
    private readonly audit: AuditLog,
    private readonly gate: OperationGate,
  ) {}

  // ------------------------------------------------------------- reading

  async list(): Promise<ServerView[]> {
    return Promise.all(this.store.list().map((s) => this.view(s)));
  }

  async get(id: number): Promise<ServerView> {
    return this.view(this.require(id));
  }

  require(id: number): ServerRecord {
    const s = this.store.byId(id);
    if (!s) throw notFound("Server not found.");
    return s;
  }

  private async view(s: ServerRecord): Promise<ServerView> {
    const status = await this.host.serviceStatus(s.slug);
    const live = status.state === "active" ? await queryInfo(s.port) : null;
    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      presetId: s.presetId,
      presetName: s.presetId ? (this.presets.byId(s.presetId)?.name ?? null) : null,
      port: s.port,
      cpu: s.cpu,
      map: s.map,
      gameType: s.gameType,
      gameMode: s.gameMode,
      maxPlayers: s.maxPlayers,
      password: s.password ?? "",
      gsltSet: !!s.gsltToken,
      gsltHint: s.gsltToken ? `…${s.gsltToken.slice(-4)}` : null,
      extraArgs: s.extraArgs,
      autostart: s.autostart,
      createdAt: s.createdAt,
      status,
      live,
    };
  }

  /** Ports in use by servers, for the "pick a port" form. */
  usedPorts(): { serverId: number; name: string; port: number }[] {
    return this.store.list().map((s) => ({ serverId: s.id, name: s.name, port: s.port }));
  }

  /** Suggested CPU core: the least-used one, keeping the last core for the panel and OS. */
  suggestCpu(): number {
    const cores = Math.max(1, this.host.cpuCount() - 1);
    const usage = new Array<number>(cores).fill(0);
    for (const s of this.store.list()) if (s.cpu < cores) usage[s.cpu]!++;
    return usage.indexOf(Math.min(...usage));
  }

  async checkPort(port: number, excludeId?: number): Promise<string | null> {
    const others = this.store.list().filter((s) => s.id !== excludeId);
    const problem = portProblem(port, others);
    if (problem) return problem;
    if (await this.host.isPortInUse(port)) return `Port ${port} is already in use by another program on this machine.`;
    return null;
  }

  // ------------------------------------------------------------- writing

  async create(raw: unknown, actor: Actor): Promise<ServerView> {
    this.gate.assertFree();
    const input: CreateServerInput = CreateServerSchema.parse(raw);
    if (input.extraArgs && !actor.can("server.rawargs")) throw forbidden("Only the Owner can set extra launch arguments.");
    const preset = this.presets.byId(input.presetId);
    if (!preset) throw badRequest("Unknown game mode preset.");

    const slug = input.slug ?? slugify(input.name);
    if (this.store.slugTaken(slug)) throw conflict(`The short name "${slug}" is already used by another server.`);
    const portIssue = await this.checkPort(input.port);
    if (portIssue) throw badRequest(portIssue);
    const cpu = input.cpu ?? this.suggestCpu();
    if (cpu >= this.host.cpuCount()) throw badRequest(`This machine has CPU cores 0–${this.host.cpuCount() - 1}.`);
    if (input.startNow && !(await this.files.baseInstalled())) {
      throw badRequest("CS2 isn't installed yet. Install it from the Game update page first, or create the server without starting it.");
    }

    const record = {
      slug,
      name: input.name,
      presetId: preset.id,
      port: input.port,
      cpu,
      map: input.map ?? preset.defaultMap,
      gameType: preset.gameType,
      gameMode: preset.gameMode,
      maxPlayers: input.maxPlayers ?? preset.maxPlayers,
      password: input.password || null,
      gsltToken: input.gsltToken || null,
      rconPassword: randomPassword(),
      bridgeToken: randomToken(),
      extraArgs: input.extraArgs,
      autostart: input.autostart,
    };

    const id = this.store.insert(record);
    let mounted = false;
    try {
      await this.files.createDirs(slug);
      await this.files.writeCfgFiles(slug, preset.configFiles);
      const created = this.require(id);
      await this.writeLaunchFiles(created);
      if (await this.files.baseInstalled()) {
        await this.host.cs2ctl("mount", slug);
        mounted = true;
      }
      if (input.autostart) await this.host.cs2ctl("enable", slug);
      if (input.startNow) await this.host.cs2ctl("start", slug);
    } catch (err) {
      // Undo everything so no half-made server is left behind.
      try {
        if (mounted) await this.host.cs2ctl("archive", slug);
        else await this.files.removeUnmounted(slug);
      } catch {
        /* best effort */
      }
      this.store.purge(id);
      throw badRequest(`Creating the server failed: ${(err as Error).message}`);
    }

    this.audit.record(actor.id, "server.create", id, { slug, port: record.port, preset: preset.name, map: record.map });
    return this.get(id);
  }

  async update(id: number, raw: unknown, actor: Actor): Promise<{ server: ServerView; restartRequired: boolean }> {
    this.gate.assertFree();
    const input: UpdateServerInput = UpdateServerSchema.parse(raw);
    const s = this.require(id);
    const before = { ...s };
    const status = await this.host.serviceStatus(s.slug);
    const running = status.state === "active" || status.state === "activating";

    if (input.extraArgs !== undefined && input.extraArgs !== s.extraArgs && !actor.can("server.rawargs")) {
      throw forbidden("Only the Owner can change extra launch arguments.");
    }
    if (input.port !== undefined && input.port !== s.port) {
      if (running) throw badRequest("Stop the server before changing its port.");
      const issue = await this.checkPort(input.port, id);
      if (issue) throw badRequest(issue);
      s.port = input.port;
    }
    if (input.cpu !== undefined) {
      if (input.cpu >= this.host.cpuCount()) throw badRequest(`This machine has CPU cores 0–${this.host.cpuCount() - 1}.`);
      s.cpu = input.cpu;
    }
    let preset = null;
    if (input.presetId !== undefined && input.presetId !== s.presetId) {
      preset = this.presets.byId(input.presetId);
      if (!preset) throw badRequest("Unknown game mode preset.");
      s.presetId = preset.id;
      s.gameType = preset.gameType;
      s.gameMode = preset.gameMode;
    }
    if (input.name !== undefined) s.name = input.name;
    if (input.map !== undefined) s.map = input.map;
    if (input.maxPlayers !== undefined) s.maxPlayers = input.maxPlayers;
    if (input.password !== undefined) s.password = input.password || null;
    if (input.gsltToken !== undefined) s.gsltToken = input.gsltToken || null;
    if (input.extraArgs !== undefined) s.extraArgs = input.extraArgs;
    if (input.autostart !== undefined && input.autostart !== s.autostart) {
      await this.host.cs2ctl(input.autostart ? "enable" : "disable", s.slug);
      s.autostart = input.autostart;
    }

    this.store.update(s);
    await this.writeLaunchFiles(s);

    if (input.applyPresetConfigs) {
      const p = preset ?? (s.presetId ? this.presets.byId(s.presetId) : null);
      if (!p) throw badRequest("This server has no preset to take config files from.");
      for (const [rel, content] of Object.entries(p.configFiles)) {
        await this.configs.save(s, `cfg/${rel}`, content, actor.id, `Applied preset "${p.name}"`);
      }
    }

    const changed = Object.keys(input).filter(
      (k) => k !== "applyPresetConfigs" && (before as unknown as Record<string, unknown>)[k] !== (s as unknown as Record<string, unknown>)[k],
    );
    this.audit.record(actor.id, "server.update", id, {
      changed: changed.map((k) => (k === "password" || k === "gsltToken" ? `${k} (hidden)` : k)),
      appliedPresetConfigs: !!input.applyPresetConfigs,
    });
    const launchKeys = ["presetId", "map", "maxPlayers", "port", "cpu", "gsltToken", "password", "name", "extraArgs"];
    return { server: await this.view(s), restartRequired: running && changed.some((k) => launchKeys.includes(k)) };
  }

  async duplicate(sourceId: number, raw: unknown, actor: Actor): Promise<ServerView> {
    this.gate.assertFree();
    const input: DuplicateServerInput = DuplicateServerSchema.parse(raw);
    const src = this.require(sourceId);
    const slug = input.slug ?? slugify(input.name);
    if (this.store.slugTaken(slug)) throw conflict(`The short name "${slug}" is already used by another server.`);
    const issue = await this.checkPort(input.port);
    if (issue) throw badRequest(issue);

    const id = this.store.insert({
      ...src,
      slug,
      name: input.name,
      port: input.port,
      cpu: this.suggestCpu(),
      gsltToken: input.gsltToken || null,
      rconPassword: randomPassword(),
      bridgeToken: randomToken(),
    });
    let mounted = false;
    try {
      await this.files.createDirs(slug);
      await this.files.copyFrom(src.slug, slug);
      await this.writeLaunchFiles(this.require(id));
      if (await this.files.baseInstalled()) {
        await this.host.cs2ctl("mount", slug);
        mounted = true;
      }
      if (src.autostart) await this.host.cs2ctl("enable", slug);
    } catch (err) {
      try {
        if (mounted) await this.host.cs2ctl("archive", slug);
        else await this.files.removeUnmounted(slug);
      } catch {
        /* best effort */
      }
      this.store.purge(id);
      throw badRequest(`Duplicating the server failed: ${(err as Error).message}`);
    }
    this.audit.record(actor.id, "server.duplicate", id, { from: src.name, fromId: src.id, slug, port: input.port });
    return this.get(id);
  }

  async delete(id: number, confirmSlug: unknown, actor: Actor): Promise<void> {
    this.gate.assertFree();
    if (!actor.can("server.delete")) throw forbidden("Only the Owner can delete servers.");
    const s = this.require(id);
    if (confirmSlug !== s.slug) throw badRequest(`Type the server's short name "${s.slug}" to confirm.`);
    const out = await this.host.cs2ctl("archive", s.slug);
    this.store.markDeleted(id);
    this.audit.record(actor.id, "server.delete", id, { slug: s.slug, name: s.name, port: s.port, archive: out.trim() });
  }

  async control(id: number, action: ControlAction, actor: Actor): Promise<ServerView> {
    // A force stop must work even while something else is in progress.
    if (action !== "kill") this.gate.assertFree();
    const s = this.require(id);
    const starting = action === "start" || action === "restart";
    if (starting && !(await this.files.baseInstalled())) {
      throw badRequest("CS2 isn't installed yet. Install it from the Game update page first.");
    }
    if (starting) {
      // Make sure the launch files match the current settings before starting.
      await this.writeLaunchFiles(s);
      await this.files.regenerateGameinfo(s.slug);
    }
    try {
      await this.host.cs2ctl(action, s.slug);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    this.audit.record(actor.id, `server.${action}`, id);
    return this.view(s);
  }

  private async writeLaunchFiles(s: ServerRecord): Promise<void> {
    await this.files.writeLaunchEnv(s.slug, s);
    await this.files.writeGeneratedCfg(s.slug, { hostname: s.name, password: s.password, rconPassword: s.rconPassword });
  }
}
