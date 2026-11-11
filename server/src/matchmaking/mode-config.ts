// A lobby's own config (e.g. 1v1 rules), run by the bridge after every map load of a match.

/** The file the panel writes on the match server, under game/csgo/cfg/. */
export const MATCH_CFG = "cs2panel_match.cfg";

/**
 * Commands the match handles itself. Lines with these are left out, because they would end the
 * warmup hold, restart the match, change the map, fight the password or bot settings, and so on.
 */
const IGNORED = [
  /^mp_warmup_(end|start|pausetimer)$/,
  /^mp_restartgame$/,
  /^mp_match_end_(restart|changelevel)$/,
  /^sv_password$/,
  /^rcon_password$/,
  /^bot_/,
  /^(map|changelevel|host_workshop_map|host_workshop_collection|ds_workshop_changelevel)$/,
  /^(game_type|game_mode|exec|quit|exit|kickid|kick|banid|writeid|hostname)$/,
];

export interface CleanedConfig {
  /** What the server runs: one command per line. */
  text: string;
  /** Commands that were left out, in order of first appearance. */
  ignored: string[];
}

/** Strips comments and the commands the match handles itself. Lines with ";" are split into commands. */
export function cleanModeConfig(raw: string): CleanedConfig {
  const kept: string[] = [];
  const ignored: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    for (const part of line.replace(/\/\/.*$/, "").split(";")) {
      const cmd = part.trim();
      if (!cmd) continue;
      const name = cmd.split(/\s+/)[0]!.toLowerCase();
      if (IGNORED.some((r) => r.test(name))) {
        if (!ignored.includes(name)) ignored.push(name);
      } else kept.push(cmd);
    }
  }
  return { text: kept.join("\n"), ignored };
}

/** Rounds needed to win when the config sets mp_maxrounds (with clinching, as CS2 does by default). */
export function winRoundsFromConfig(raw: string): number | null {
  let max: number | null = null;
  for (const cmd of cleanModeConfig(raw).text.split("\n")) {
    const m = /^mp_maxrounds\s+"?(\d+)"?$/i.exec(cmd);
    if (m) max = Number(m[1]);
  }
  return max && max > 0 ? Math.floor(max / 2) + 1 : null;
}

/** Default rules for the 1v1 lobby: a fast first-to-16 aim duel (90-second rounds) with full money every round. */
export const DUEL_CONFIG = `// 1v1 aim duel
mp_autoteambalance 0
mp_limitteams 0
mp_autokick 0

// First to 16 (30 rounds), no halftime or overtime
mp_maxrounds 30
mp_match_can_clinch 1
mp_overtime_enable 0
mp_halftime 0
mp_freezetime 2
mp_round_restart_delay 2
mp_roundtime 1.5
mp_roundtime_defuse 1.5
mp_roundtime_hostage 1.5
mp_ignore_round_win_conditions 0
mp_respawn_on_death_ct 0
mp_respawn_on_death_t 0

// Same equipment and money every round
mp_startmoney 16000
mp_maxmoney 16000
mp_afterroundmoney 16000
mp_free_armor 2
mp_buy_anywhere 1
mp_buytime 15
sv_infinite_ammo 0

// Other rules
sv_allow_votes 0
sv_cheats 0
`;

/** Earlier built-in 1v1 configs: a saved copy of one of these is replaced by the current default. */
export const OLD_DUEL_CONFIGS = [
  `// 1v1 aim duel
mp_autoteambalance 0
mp_limitteams 0
mp_autokick 0

// First to 16 (30 rounds), no halftime or overtime
mp_maxrounds 30
mp_match_can_clinch 1
mp_overtime_enable 0
mp_halftime 0
mp_freezetime 2
mp_round_restart_delay 2
mp_roundtime 10
mp_roundtime_defuse 10
mp_roundtime_hostage 10
mp_ignore_round_win_conditions 0
mp_respawn_on_death_ct 0
mp_respawn_on_death_t 0

// Same equipment and money every round
mp_startmoney 16000
mp_maxmoney 16000
mp_afterroundmoney 16000
mp_free_armor 2
mp_buy_anywhere 1
mp_buytime 15
sv_infinite_ammo 0

// Other rules
sv_allow_votes 0
sv_cheats 0
`,
  `// 1v1 aim duel
mp_autoteambalance 0
mp_limitteams 0
mp_autokick 0

// First to 16 (30 rounds), no halftime or overtime
mp_maxrounds 30
mp_match_can_clinch 1
mp_overtime_enable 0
mp_halftime 0
mp_freezetime 2
mp_round_restart_delay 2
mp_roundtime 1
mp_roundtime_defuse 1
mp_roundtime_hostage 1
mp_ignore_round_win_conditions 0
mp_respawn_on_death_ct 0
mp_respawn_on_death_t 0

// Same equipment and money every round
mp_startmoney 16000
mp_maxmoney 16000
mp_afterroundmoney 16000
mp_free_armor 2
mp_buy_anywhere 1
mp_buytime 15
sv_infinite_ammo 0

// Other rules
sv_allow_votes 0
sv_cheats 0
`,
];
