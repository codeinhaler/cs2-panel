import type { AuditLog } from "../audit.js";
import type { Db } from "../db.js";
import { badRequest } from "../errors.js";
import type { ConfigService } from "./configs.js";
import type { ServerRecord } from "./store.js";

/**
 * Extra cfg files a server runs on every map start. CS2 runs the game mode's
 * gamemode_<mode>_server.cfg after the mode's own defaults on each map load, so
 * the panel keeps a small block of exec lines at the end of that file.
 */
const BLOCK_START = "// ---- cs2-panel: configs to run on every map start (change them in the server's Settings) ----";
const BLOCK_END = "// ---- end of cs2-panel block ----";
const MAX_CONFIGS = 10;
const NAME_RE = /^[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+)*\.cfg$/;

const MODE_FILES: Record<string, string> = {
  "0/0": "gamemode_casual_server.cfg",
  "0/1": "gamemode_competitive_server.cfg",
  "0/2": "gamemode_competitive2v2_server.cfg",
  "1/0": "gamemode_armsrace_server.cfg",
  "1/1": "gamemode_demolition_server.cfg",
  "1/2": "gamemode_deathmatch_server.cfg",
  "3/0": "gamemode_custom_server.cfg",
};

/** The cfg file (relative to cfg/) where the exec lines go for a game mode. */
export function modeServerCfg(gameType: number, gameMode: number): string {
  return MODE_FILES[`${gameType}/${gameMode}`] ?? "server.cfg";
}

/** Checks a list of cfg names (relative to cfg/), returning it cleaned. */
export function validateExecConfigs(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const name = raw.trim().replace(/^cfg\//, "");
    if (!name) continue;
    if (!NAME_RE.test(name)) throw badRequest(`"${raw}" isn't a cfg file name like practice.cfg.`);
    if (name === "server.cfg" || /^gamemode_.*_server\.cfg$/.test(name) || name === "cs2panel_generated.cfg") {
      throw badRequest(`${name} already runs by itself; pick another file.`);
    }
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > MAX_CONFIGS) throw badRequest(`Pick at most ${MAX_CONFIGS} configs.`);
  return out;
}

/** content with the panel block replaced by lines (or removed when empty). */
export function withBlock(content: string, configs: string[]): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  let rest = content;
  if (start >= 0 && end > start) rest = content.slice(0, start) + content.slice(end + BLOCK_END.length);
  rest = rest.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  if (configs.length === 0) return rest ? `${rest}\n` : "";
  const block = [BLOCK_START, ...configs.map((c) => `exec ${c.replace(/\.cfg$/, "")}`), BLOCK_END].join("\n");
  return `${rest ? `${rest}\n\n` : ""}${block}\n`;
}

export class ExecConfigService {
  constructor(
    private readonly db: Db,
    private readonly configs: ConfigService,
    private readonly audit: AuditLog,
  ) {}

  get(serverId: number): string[] {
    const row = this.db.prepare("SELECT exec_configs FROM servers WHERE id = ?").get(serverId) as { exec_configs: string } | undefined;
    try {
      const v = JSON.parse(row?.exec_configs ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  /** A duplicated server runs the same configs (its files are copied along). */
  copy(fromId: number, toId: number): void {
    this.db.prepare("UPDATE servers SET exec_configs = (SELECT exec_configs FROM servers WHERE id = ?) WHERE id = ?").run(fromId, toId);
  }

  async set(s: ServerRecord, list: string[], actorId: number | null): Promise<string[]> {
    const clean = validateExecConfigs(list);
    for (const name of clean) {
      if (!(await this.configs.readCurrent(s, `cfg/${name}`))) throw badRequest(`This server has no cfg/${name}. Create it on the Config files tab first.`);
    }
    this.db.prepare("UPDATE servers SET exec_configs = ? WHERE id = ?").run(JSON.stringify(clean), s.id);
    await this.apply(s, actorId);
    this.audit.record(actorId, "server.exec_configs", s.id, { configs: clean });
    return clean;
  }

  /**
   * Writes the block into the current game mode's _server.cfg and removes it
   * from the other modes' files (e.g. after the game mode changed).
   */
  async apply(s: ServerRecord, actorId: number | null): Promise<void> {
    const list = this.get(s.id);
    const target = modeServerCfg(s.gameType, s.gameMode);
    for (const file of new Set([...Object.values(MODE_FILES), "server.cfg"])) {
      const rel = `cfg/${file}`;
      const current = await this.configs.readCurrent(s, rel);
      const before = current?.content ?? "";
      const after = withBlock(before, file === target ? list : []);
      if (after === before || (!current && !after)) continue;
      await this.configs.save(
        s,
        rel,
        after,
        actorId,
        file === target ? "Configs to run on every map start" : "Moved the panel's configs to run to another game mode's file",
      );
    }
  }
}
