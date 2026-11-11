import { z } from "zod";
import type { Db } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { validateExecConfigs } from "./exec-configs.js";
import { parseMapSpec } from "./map-spec.js";

export interface Preset {
  id: number;
  key: string;
  name: string;
  description: string;
  builtin: boolean;
  gameType: number;
  gameMode: number;
  defaultMap: string;
  maxPlayers: number;
  /** Relative to game/csgo/cfg → file content. */
  configFiles: Record<string, string>;
  /** cfg files (relative to cfg/) run on every map start. */
  execConfigs: string[];
}

const serverCfg = (title: string, extra: string) => `// server.cfg — created by cs2-panel from the "${title}" preset.
// Edit freely; earlier versions are kept in the panel's config history.
// The hostname, server password and RCON password are set by the panel
// in cs2panel_generated.cfg. Setting them here would override the panel.

sv_cheats 0
sv_lan 0
// Hibernating while empty pauses the game loop, which also pauses
// CounterStrikeSharp plugins (e.g. admin commands never get registered).
sv_hibernate_when_empty 0
sv_allow_votes 1
${extra}`;

/** Built-in presets for CS2's stock game modes. Seeded on startup. */
export const BUILTIN_PRESETS: Omit<Preset, "id" | "execConfigs">[] = [
  {
    key: "casual",
    name: "Casual",
    description: "Stock casual mode: relaxed rules, no friendly fire.",
    builtin: true,
    gameType: 0,
    gameMode: 0,
    defaultMap: "de_dust2",
    maxPlayers: 20,
    configFiles: { "server.cfg": serverCfg("Casual", "") },
  },
  {
    key: "competitive",
    name: "Competitive",
    description: "Stock 5v5 competitive rules.",
    builtin: true,
    gameType: 0,
    gameMode: 1,
    defaultMap: "de_mirage",
    maxPlayers: 10,
    configFiles: { "server.cfg": serverCfg("Competitive", "mp_autokick 0\n") },
  },
  {
    key: "wingman",
    name: "Wingman",
    description: "Stock 2v2 wingman mode.",
    builtin: true,
    gameType: 0,
    gameMode: 2,
    defaultMap: "de_inferno",
    maxPlayers: 4,
    configFiles: { "server.cfg": serverCfg("Wingman", "") },
  },
  {
    key: "armsrace",
    name: "Arms Race",
    description: "Stock arms race (gun game).",
    builtin: true,
    gameType: 1,
    gameMode: 0,
    defaultMap: "ar_shoots",
    maxPlayers: 10,
    configFiles: { "server.cfg": serverCfg("Arms Race", "") },
  },
  {
    key: "deathmatch",
    name: "Deathmatch",
    description: "Stock deathmatch.",
    builtin: true,
    gameType: 1,
    gameMode: 2,
    defaultMap: "de_dust2",
    maxPlayers: 16,
    configFiles: { "server.cfg": serverCfg("Deathmatch", "") },
  },
];

interface PresetRow {
  id: number;
  key: string;
  name: string;
  description: string;
  builtin: number;
  game_type: number;
  game_mode: number;
  default_map: string;
  max_players: number;
  config_files: string;
  exec_configs?: string;
}

const toPreset = (r: PresetRow): Preset => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  builtin: r.builtin === 1,
  gameType: r.game_type,
  gameMode: r.game_mode,
  defaultMap: r.default_map,
  maxPlayers: r.max_players,
  configFiles: JSON.parse(r.config_files) as Record<string, string>,
  execConfigs: JSON.parse(r.exec_configs ?? "[]") as string[],
});

const CFG_NAME_RE = /^[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+)*\.cfg$/;

/** What an admin can set on a custom preset. */
export const PresetInputSchema = z.object({
  name: z.string().trim().min(1, "Give the preset a name.").max(40),
  description: z.string().trim().max(200).default(""),
  gameType: z.number().int().min(0).max(10),
  gameMode: z.number().int().min(0).max(10),
  defaultMap: z
    .string()
    .trim()
    .max(80)
    .refine((v) => parseMapSpec(v) !== null, "Enter a map name like de_dust2, or a Workshop map or collection."),
  maxPlayers: z.number().int().min(2).max(64),
  configFiles: z
    .record(z.string(), z.string().max(256 * 1024))
    .refine((o) => Object.keys(o).length <= 20, "A preset can hold at most 20 config files.")
    .refine(
      (o) => Object.keys(o).every((k) => CFG_NAME_RE.test(k) && k !== "cs2panel_generated.cfg"),
      "Config file names must look like server.cfg or practice.cfg.",
    ),
  execConfigs: z.array(z.string().max(100)).max(10).default([]),
});
export type PresetInput = z.infer<typeof PresetInputSchema>;

export class PresetStore {
  constructor(private readonly db: Db) {}

  /** Inserts or refreshes the built-in presets. */
  seed(): void {
    const upsert = this.db.prepare(`
      INSERT INTO presets (key, name, description, builtin, game_type, game_mode, default_map, max_players, config_files)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET name = excluded.name, description = excluded.description,
        builtin = 1, game_type = excluded.game_type, game_mode = excluded.game_mode,
        default_map = excluded.default_map, max_players = excluded.max_players, config_files = excluded.config_files`);
    for (const p of BUILTIN_PRESETS) {
      upsert.run(p.key, p.name, p.description, p.gameType, p.gameMode, p.defaultMap, p.maxPlayers, JSON.stringify(p.configFiles));
    }
  }

  create(raw: unknown, actorId: number): Preset {
    const p = this.check(raw);
    const r = this.db
      .prepare(
        `INSERT INTO presets (key, name, description, builtin, game_type, game_mode, default_map, max_players, config_files, exec_configs, created_by, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        p.name,
        p.description,
        p.gameType,
        p.gameMode,
        p.defaultMap,
        p.maxPlayers,
        JSON.stringify(p.configFiles),
        JSON.stringify(p.execConfigs),
        actorId,
      );
    return this.byId(Number(r.lastInsertRowid))!;
  }

  update(id: number, raw: unknown): Preset {
    const existing = this.byId(id);
    if (!existing) throw notFound("Preset not found.");
    if (existing.builtin) throw badRequest("Built-in presets can't be changed. Make a copy instead.");
    const p = this.check(raw, id);
    this.db
      .prepare(
        `UPDATE presets SET name = ?, description = ?, game_type = ?, game_mode = ?, default_map = ?, max_players = ?,
           config_files = ?, exec_configs = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(p.name, p.description, p.gameType, p.gameMode, p.defaultMap, p.maxPlayers, JSON.stringify(p.configFiles), JSON.stringify(p.execConfigs), id);
    return this.byId(id)!;
  }

  /** Servers made from the preset keep their settings and files; they just no longer point at it. */
  delete(id: number): { serversUsing: number } {
    const existing = this.byId(id);
    if (!existing) throw notFound("Preset not found.");
    if (existing.builtin) throw badRequest("Built-in presets can't be deleted.");
    const using = (this.db.prepare("SELECT COUNT(*) AS n FROM servers WHERE preset_id = ? AND deleted_at IS NULL").get(id) as { n: number }).n;
    this.db.prepare("UPDATE servers SET preset_id = NULL WHERE preset_id = ?").run(id);
    this.db.prepare("DELETE FROM presets WHERE id = ?").run(id);
    return { serversUsing: using };
  }

  private check(raw: unknown, id?: number): PresetInput {
    const p = PresetInputSchema.parse(raw);
    p.execConfigs = validateExecConfigs(p.execConfigs);
    const clash = this.db.prepare("SELECT id FROM presets WHERE lower(name) = lower(?) AND id IS NOT ?").get(p.name, id ?? null) as { id: number } | undefined;
    if (clash) throw badRequest(`There's already a preset called "${p.name}".`);
    return p;
  }

  list(): Preset[] {
    return (this.db.prepare("SELECT * FROM presets ORDER BY builtin DESC, id").all() as unknown as PresetRow[]).map(toPreset);
  }

  byId(id: number): Preset | null {
    const row = this.db.prepare("SELECT * FROM presets WHERE id = ?").get(id) as PresetRow | undefined;
    return row ? toPreset(row) : null;
  }
}
