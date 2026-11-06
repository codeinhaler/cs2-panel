import type { Db } from "../db.js";

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
export const BUILTIN_PRESETS: Omit<Preset, "id">[] = [
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
});

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

  list(): Preset[] {
    return (this.db.prepare("SELECT * FROM presets ORDER BY builtin DESC, id").all() as unknown as PresetRow[]).map(toPreset);
  }

  byId(id: number): Preset | null {
    const row = this.db.prepare("SELECT * FROM presets WHERE id = ?").get(id) as PresetRow | undefined;
    return row ? toPreset(row) : null;
  }
}
