import path from "node:path";
import { promises as fs } from "node:fs";
import type { AuditLog } from "../audit.js";
import { badRequest } from "../errors.js";
import type { RconExec } from "../game/rcon.js";
import type { Host } from "../host/host.js";
import type { Settings } from "../settings.js";
import type { ConfigService } from "./configs.js";
import { SHARED_CFG, writeAtomic, type InstanceFiles } from "./instance-files.js";
import type { ServerService } from "./service.js";
import type { ServerRecord } from "./store.js";

/** Settings that apply to every server, unless a server opts out. */
export interface SharedConfig {
  /** Put in front of every server's name, e.g. "[Sune] ". */
  hostnamePrefix: string;
  /** sv_tags: comma-separated words that show in the server browser. */
  tags: string;
  /** Any cvars, one per line, as in a cfg file. A server's own server.cfg overrides them. */
  cvars: string;
  /** Servers that don't use the shared settings. */
  excluded: number[];
}

const DEFAULTS: SharedConfig = { hostnamePrefix: "", tags: "", cvars: "", excluded: [] };

const BLOCK_START = "// ---- cs2-panel: shared settings for all servers (change them on the Shared settings page) ----";
const BLOCK_END = "// ---- end of cs2-panel block ----";

/**
 * Commands the shared list may not contain: the panel sets these itself (passwords,
 * hostname, token, game mode), and map or shutdown commands would hit every server
 * on every map start.
 */
const BLOCKED = new Set([
  "rcon_password",
  "sv_password",
  "hostname",
  "sv_setsteamaccount",
  "game_type",
  "game_mode",
  "map",
  "changelevel",
  "host_workshop_map",
  "host_workshop_collection",
  "quit",
  "exit",
  "killserver",
  "restart",
]);

/** Checks the cvar list; returns it with Windows line endings removed. */
export function validateCvars(text: string): string {
  if (text.length > 16 * 1024) throw badRequest("The shared cvars are too long (16 kB at most).");
  const clean = text.replace(/\r\n?/g, "\n");
  clean.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) return;
    for (const part of line.split(";")) {
      const cmd = part.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (BLOCKED.has(cmd)) {
        throw badRequest(
          `Line ${i + 1}: ${cmd} can't be in the shared settings${["map", "changelevel", "host_workshop_map", "host_workshop_collection"].includes(cmd) ? " (it would run on every map start)" : " (the panel sets it)"}.`,
        );
      }
    }
  });
  return clean.trim() ? `${clean.trim()}\n` : "";
}

/** server.cfg with the shared block at the top (added once, kept in place). */
export function withSharedBlock(content: string): string {
  if (content.includes(BLOCK_START)) return content;
  const block = `${BLOCK_START}\nexec ${SHARED_CFG.replace(/\.cfg$/, "")}\n${BLOCK_END}\n`;
  return content.trim() ? `${block}\n${content}` : block;
}

/** server.cfg without the shared block (for presets; new servers get the block by themselves). */
export function withoutSharedBlock(content: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start < 0 || end < start) return content;
  return (content.slice(0, start) + content.slice(end + BLOCK_END.length)).replace(/^\s+/, "");
}

export class SharedConfigService {
  constructor(
    private readonly settings: Settings,
    private readonly servers: ServerService,
    private readonly configs: ConfigService,
    private readonly files: InstanceFiles,
    private readonly host: Host,
    private readonly rcon: RconExec,
    private readonly audit: AuditLog,
  ) {}

  get(): SharedConfig {
    return { ...DEFAULTS, ...this.settings.get<Partial<SharedConfig>>("shared.config", {}) };
  }

  uses(serverId: number): boolean {
    return !this.get().excluded.includes(serverId);
  }

  hostnameFor(s: ServerRecord): string {
    const c = this.get();
    return this.uses(s.id) && c.hostnamePrefix ? `${c.hostnamePrefix}${s.name}` : s.name;
  }

  async set(input: SharedConfig, actorId: number): Promise<{ config: SharedConfig; liveOn: string[] }> {
    const hostnamePrefix = input.hostnamePrefix.replace(/[\r\n]/g, "");
    if (hostnamePrefix.length > 32) throw badRequest("Keep the hostname prefix to 32 characters.");
    if (/["\\;]/.test(hostnamePrefix)) throw badRequest("The hostname prefix can't contain \", \\ or ;.");
    const tags = input.tags.trim();
    if (tags.length > 128 || !/^[A-Za-z0-9_\-, ]*$/.test(tags)) throw badRequest("Tags are words separated by commas (letters, numbers, - and _).");
    const known = new Set(this.servers.listRecords().map((s) => s.id));
    const config: SharedConfig = {
      hostnamePrefix,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .join(","),
      cvars: validateCvars(input.cvars),
      excluded: [...new Set(input.excluded)].filter((id) => known.has(id)),
    };
    const before = this.get();
    this.settings.set("shared.config", config);
    this.audit.record(actorId, "shared.update", null, { hostnamePrefix: config.hostnamePrefix, tags: config.tags, excluded: config.excluded.length });
    const liveOn = await this.applyAll(actorId, before);
    return { config, liveOn };
  }

  /** The shared cfg file for one server. */
  fileContent(serverId: number): string {
    const c = this.get();
    const head = `// ${SHARED_CFG}: written by cs2-panel from the Shared settings page. Edits here are overwritten.\n// It runs at the top of server.cfg, so anything server.cfg sets wins over these.\n`;
    if (!this.uses(serverId)) return `${head}// This server doesn't use the shared settings.\n`;
    return `${head}${c.tags ? `sv_tags "${c.tags}"\n` : ""}${c.cvars}`;
  }

  /** Writes the shared file, makes sure server.cfg runs it, and refreshes the hostname. */
  async applyTo(s: ServerRecord, actorId: number | null): Promise<void> {
    const cfgDir = path.join(await this.files.liveDir(s.slug), "game", "csgo", "cfg");
    await fs.mkdir(cfgDir, { recursive: true, mode: 0o2775 });
    await writeAtomic(path.join(cfgDir, SHARED_CFG), this.fileContent(s.id), 0o664);
    const cur = await this.configs.readCurrent(s, "cfg/server.cfg");
    const next = withSharedBlock(cur?.content ?? "");
    if (next !== (cur?.content ?? "")) await this.configs.save(s, "cfg/server.cfg", next, actorId, "Runs the shared settings at the top");
    await this.servers.refreshGeneratedCfg(s);
  }

  /** Applies to every server; running ones take the new hostname and settings right away. */
  private async applyAll(actorId: number, before: SharedConfig): Promise<string[]> {
    const liveOn: string[] = [];
    for (const s of this.servers.listRecords()) {
      await this.applyTo(s, actorId);
      if ((await this.host.serviceStatus(s.slug)).state !== "active") continue;
      const tagsGone = before.tags && (!this.uses(s.id) || !this.get().tags) ? '; sv_tags ""' : "";
      try {
        await this.rcon(
          { port: s.port, password: s.rconPassword, timeoutMs: 4000 },
          `hostname "${this.hostnameFor(s)}"${tagsGone}; exec ${SHARED_CFG.replace(/\.cfg$/, "")}`,
        );
        liveOn.push(s.name);
      } catch {
        /* the files are written; it picks them up on its next map or start */
      }
    }
    return liveOn;
  }
}
