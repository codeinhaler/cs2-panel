import { promises as fs } from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { z } from "zod";
import type { AuditLog } from "../audit.js";
import type { Db } from "../db.js";
import type { SecretBox } from "../crypto.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import type { Host } from "../host/host.js";
import type { RconExec } from "../game/rcon.js";
import { gameModeLine } from "../servers/commands.js";
import { parseMapSpec } from "../servers/map-spec.js";
import { writeAtomic, type InstanceFiles } from "../servers/instance-files.js";
import type { ServerService } from "../servers/service.js";
import type { ServerRecord } from "../servers/store.js";
import type { Settings } from "../settings.js";
import { choosePlayers, rankSplits, type Split } from "./balance.js";
import { LeetifyClient, leetifyProfileUrl } from "./leetify.js";
import { workshopBlocks, type WorkshopInfo } from "../game/workshop.js";
import { DEFAULT_LOOK, LookSchema, type ImageKind, type SiteImages } from "./look.js";
import type { MmPlayer, MmPlayerStore } from "./players.js";
import { DUEL_CONFIG, MATCH_CFG, OLD_DUEL_CONFIGS, cleanModeConfig, winRoundsFromConfig } from "./mode-config.js";

/** Where the bridge reads the current match, relative to game/csgo. */
export const MATCH_FILE = "addons/counterstrikesharp/configs/plugins/Cs2PanelBridge/match.json";

/** Premier's scale. */
export const MAX_RATING = 40_000;

/**
 * FACEIT Elo → Premier, provisional: FACEIT's level bands (level 1 from 100 Elo … level 10 from 2001)
 * laid against Premier's colour tiers (grey < 5,000 … gold 30,000+). An estimate, not measured;
 * editable on the Matchmaking page.
 */
export const FACEIT_TABLE: [number, number][] = [
  [100, 1000],
  [500, 5000],
  [750, 7500],
  [900, 9000],
  [1050, 10500],
  [1200, 12000],
  [1350, 13500],
  [1530, 15000],
  [1750, 17000],
  [2000, 19500],
  [2500, 24000],
  [3000, 28000],
  [3500, 31000],
];

/** Piecewise straight lines through the table; beyond its ends, the nearest end's slope. */
export function faceitToPremier(elo: number, table: [number, number][]): number {
  const t = table.length >= 2 ? table : FACEIT_TABLE;
  let i = t.findIndex((p) => elo <= p[0]);
  if (i === -1) i = t.length - 1;
  if (i === 0) i = 1;
  const [x0, y0] = t[i - 1]!;
  const [x1, y1] = t[i]!;
  const v = x1 === x0 ? y1 : y0 + ((elo - x0) * (y1 - y0)) / (x1 - x0);
  return Math.max(0, Math.min(MAX_RATING, Math.round(v)));
}

/** Used for players nobody knows a rating for, when no one else in the match has one either. */
const FALLBACK_RATING = 10_000;
/** A lobby member whose page hasn't checked in for this long has closed it. */
const PRESENCE_MS = 90_000;
/** Teams nobody starts are dropped after this long. */
const DRAFT_MS = 5 * 60_000;
/** A ready server nobody is on is given back after this long. */
const IDLE_MATCH_MS = 10 * 60_000;
/** The scoreboard stays up this long after the match before the server is unlocked. */
const RELEASE_AFTER_MS = 15_000;
/** Finished matches stay on the page this long. */
const KEEP_ENDED_MS = 30 * 60_000;
const POLL_MS = 10_000;

export const DEFAULT_MAPS = ["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train"];

/**
 * The lobbies players can pick. 1v1 runs in Wingman mode (short halves, small maps).
 * Fixed teams: players pick their own team instead of the panel balancing them.
 */
export const MODES = ["competitive", "wingman", "duel", "fixed5", "fixed2"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_INFO: Record<Mode, { label: string; teamSize: number; gameType: number; gameMode: number; fixed: boolean }> = {
  competitive: { label: "Competitive", teamSize: 5, gameType: 0, gameMode: 1, fixed: false },
  wingman: { label: "Wingman", teamSize: 2, gameType: 0, gameMode: 2, fixed: false },
  duel: { label: "1v1", teamSize: 1, gameType: 0, gameMode: 2, fixed: false },
  fixed5: { label: "Fixed teams 5v5", teamSize: 5, gameType: 0, gameMode: 1, fixed: true },
  fixed2: { label: "Fixed teams 2v2", teamSize: 2, gameType: 0, gameMode: 2, fixed: true },
};

/** Bot difficulty (bot_difficulty 0–3) and the rating it counts as when balancing. */
export const BOT_LEVELS = [
  { label: "Easy", rating: 3000 },
  { label: "Normal", rating: 6000 },
  { label: "Hard", rating: 9000 },
  { label: "Expert", rating: 12000 },
] as const;
export const BOT_ID = "BOT";

/** Rounds a team needs to win, per mode (MR12 and MR8). */
const WIN_ROUNDS: Record<Mode, number> = { competitive: 13, wingman: 9, duel: 9, fixed5: 13, fixed2: 9 };
/** Nobody joins once a team is this close to winning. */
const LATE_JOIN_CUTOFF = 2;

const MapList = z
  .array(z.string().trim().min(1).max(80))
  .max(20)
  .refine(
    (maps) => maps.every((m) => ["stock", "workshop"].includes(parseMapSpec(m)?.kind ?? "")),
    "Each map must be a map name like de_mirage or a Workshop map (workshop:ID). Collections can't be voted on.",
  );
const ModeSettings = z.object({
  enabled: z.boolean(),
  maps: MapList,
  /** Run on the match server after every map load (e.g. 1v1 rules). Empty: the game mode's own rules. */
  config: z.string().max(20_000, "The config is too long (20,000 characters at most).").default(""),
  /** Players get the weapons they bought back after dying (the bridge gives them on respawn). */
  keepWeapons: z.boolean().default(false),
  /** The servers this lobby's matches run on. Missing in settings saved before per-lobby servers: then all match servers. */
  serverIds: z.array(z.number().int().positive()).max(20).optional(),
});
const DiscordChannel = z
  .string()
  .trim()
  .max(200)
  .regex(
    /^$|^https:\/\/((ptb|canary)\.)?discord\.com\/channels\/\d+\/\d+\/?$/,
    "Paste the voice channel's link (right-click the channel in Discord → Copy Link).",
  );

export const MatchmakingSettingsSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
  title: z.string().trim().min(1).max(60),
  serverIds: z.array(z.number().int().positive()).max(20),
  modes: z
    .object({
      competitive: ModeSettings,
      wingman: ModeSettings,
      duel: ModeSettings,
      // Added later: missing in older settings and clients.
      fixed5: ModeSettings.default({ enabled: false, maps: DEFAULT_MAPS, config: "", keepWeapons: false }),
      fixed2: ModeSettings.default({ enabled: false, maps: ["de_inferno", "de_nuke", "de_overpass", "de_vertigo"], config: "", keepWeapons: false }),
    })
    .refine((m) => MODES.some((k) => m[k].enabled), "Open at least one lobby.")
    .refine((m) => MODES.every((k) => !m[k].enabled || m[k].maps.length > 0), "Every open lobby needs at least one map."),
  botDifficulty: z.number().int().min(0).max(3),
  /** FACEIT Elo (from Leetify) next to Premier: how it counts for balancing, and the Elo → Premier table. */
  faceit: z
    .object({
      blend: z.enum(["average", "faceit", "premier", "off"]),
      table: z
        .array(z.tuple([z.number().int().min(0).max(10_000), z.number().int().min(0).max(MAX_RATING)]))
        .min(2)
        .max(30)
        .refine(
          (t) => t.every((p, i) => i === 0 || (p[0] > t[i - 1]![0] && p[1] >= t[i - 1]![1])),
          "The FACEIT table must go up: Elo and Premier both increasing.",
        ),
    })
    .default({ blend: "average", table: FACEIT_TABLE }),
  look: LookSchema.default(DEFAULT_LOOK),
  /** Discord voice channels per match server (Team 1 / Team 2), and an invite for people not on the Discord yet. */
  discord: z
    .object({
      invite: z
        .string()
        .trim()
        .max(200)
        .regex(/^$|^https:\/\/(discord\.gg|(www\.)?discord\.com\/invite)\/[\w-]+\/?$/, "The invite must be a link like https://discord.gg/abc123."),
      channels: z.record(z.string().regex(/^\d+$/), z.object({ a: DiscordChannel, b: DiscordChannel })),
      /** One voice channel for everyone on the casual servers (each casual server can have its own instead). */
      casual: DiscordChannel.default(""),
      /** One voice channel for everyone in 1v1 matches, instead of a channel per team (a server can override it). */
      duel: DiscordChannel.default(""),
      /** Optional own 1v1 channel per server (by server ID); without one, the server uses `duel`. */
      duelServers: z.record(z.string().regex(/^\d+$/), DiscordChannel).default({}),
      /** Optional own channel per casual server (by server ID); without one, it uses `casual`. */
      casualServers: z.record(z.string().regex(/^\d+$/), DiscordChannel).default({}),
    })
    .default({ invite: "", channels: {}, casual: "", duel: "", duelServers: {}, casualServers: {} }),
  /** Servers anyone can just join from the site: no sign-in, no teams made, no veto. */
  casual: z
    .object({
      name: z.string().trim().min(1, "Give the casual card a name.").max(40),
      serverIds: z.array(z.number().int().positive()).max(5),
    })
    .default({ name: "Casual", serverIds: [] }),
  /** Address players connect to; empty means the same address they opened the site with. */
  gameAddress: z
    .string()
    .trim()
    .max(253)
    .regex(/^$|^[A-Za-z0-9.-]+$/, "Enter a host name or IP address, without a port."),
  vetoSeconds: z.number().int().min(10).max(120),
});
export type MatchmakingSettings = z.infer<typeof MatchmakingSettingsSchema>;

export const DEFAULT_SETTINGS: MatchmakingSettings = {
  enabled: false,
  port: 8090,
  title: "CS night",
  serverIds: [],
  modes: {
    competitive: { enabled: true, maps: DEFAULT_MAPS, config: "", keepWeapons: false },
    wingman: { enabled: true, maps: ["de_inferno", "de_nuke", "de_overpass", "de_vertigo"], config: "", keepWeapons: false },
    duel: { enabled: true, maps: ["de_inferno", "de_nuke", "de_vertigo"], config: DUEL_CONFIG, keepWeapons: true },
    fixed5: { enabled: false, maps: DEFAULT_MAPS, config: "", keepWeapons: false },
    fixed2: { enabled: false, maps: ["de_inferno", "de_nuke", "de_overpass", "de_vertigo"], config: "", keepWeapons: false },
  },
  botDifficulty: 1,
  faceit: { blend: "average", table: FACEIT_TABLE },
  look: DEFAULT_LOOK,
  casual: { name: "Casual", serverIds: [] },
  discord: { invite: "", channels: {}, casual: "", duel: "", duelServers: {}, casualServers: {} },
  gameAddress: "",
  vetoSeconds: 30,
};

export type RatingSource = "admin" | "leetify" | "self" | "none" | "bot";
export interface RatingView {
  /** On the Premier scale; what the team balancer uses. */
  value: number | null;
  /** Shown instead of the number when FACEIT is the stronger rating ("FACEIT 9 · 1,850"). */
  badge?: string | null;
  source: RatingSource;
  /** Why Leetify has nothing, when it doesn't. */
  note: string | null;
  /** True while Leetify hasn't answered yet. */
  pending?: boolean;
}

export interface Member {
  steamId: string;
  name: string;
  avatarUrl: string | null;
  rating: RatingView;
  /** What balancing used: the rating, or a stand-in for players without one. */
  effective: number;
}

type TeamKey = "a" | "b";
type Side = "ct" | "t";
export type MatchPhase = "veto" | "side" | "starting" | "live" | "over" | "cancelled" | "abandoned";

interface Ban {
  map: string;
  by: TeamKey;
  auto: boolean;
}

interface Match {
  id: number;
  mode: Mode;
  /** The bot filling in for a missing player, and which team it's on. */
  bot: TeamKey | null;
  teamA: Member[];
  teamB: Member[];
  captainA: string;
  captainB: string;
  phase: MatchPhase;
  pool: string[];
  bans: Ban[];
  turn: TeamKey;
  deadline: number | null;
  map: string | null;
  sideA: Side | null;
  sidePicker: TeamKey | null;
  serverId: number;
  password: string;
  status: string;
  error: string | null;
  readyAt: number | null;
  lastConnectedAt: number | null;
  connected: number;
  bridgePhase: string | null;
  score: { a: number; b: number } | null;
  pollFailures: number;
  polling: boolean;
  createdAt: number;
  overAt: number | null;
  endedAt: number | null;
  /** The server's lock and password have been taken off again. */
  released: boolean;
  /** Each captain's vote on letting people join mid-match. Closed only when both say no. */
  lateJoinVotes: { a: boolean; b: boolean };
  /** Each captain's vote on the bot playing (when there is one). Left out only when both say no. */
  botVotes: { a: boolean; b: boolean };
}

/**
 * A match server waiting to be cleaned up after a match: everyone kicked, no match in the bridge, its own
 * password back. Kept in mm_cleanup too, so it survives a panel restart. The server isn't used for another
 * match until the cleanup has run and been checked.
 */
interface Cleanup {
  serverId: number;
  reason: string;
  attempts: number;
  lastError: string | null;
  nextAt: number;
  running: boolean;
  /** Something touched the server while the cleanup ran (e.g. a launch that was cancelled): run it again. */
  again: boolean;
}

/** Retries after a failed cleanup: 5 s, 10 s, 20 s … at most 5 minutes apart. */
export const cleanupDelay = (attempts: number) => Math.min(5_000 * 2 ** Math.max(attempts - 1, 0), 5 * 60_000);
const INACTIVE_MATCH = { version: 1, active: false, players: [] };

interface LobbyEntry {
  steamId: string;
  mode: Mode;
  ready: boolean;
  readySince: number;
  joinedAt: number;
  lastSeen: number;
  sitOuts: number;
  /** Fixed teams: the team the player picked (null: waiting for a spot). */
  team?: TeamKey | null;
}

interface Draft {
  id: number;
  mode: Mode;
  /** Includes the bot, when there is one. */
  players: Member[];
  splits: Split[];
  index: number;
  createdAt: number;
}

// ------------------------------------------------------------- what browsers see

export interface LobbyView {
  steamId: string;
  name: string;
  avatarUrl: string | null;
  rating: RatingView;
  leetifyUrl: string;
  status: "ready" | "away" | "in-match";
  sitOuts: number;
  mode: Mode;
  /** Fixed teams: the team they picked. */
  team: TeamKey | null;
}

export interface TeamsView {
  teamA: Member[];
  teamB: Member[];
  sumA: number;
  sumB: number;
  avgA: number;
  avgB: number;
  gap: number;
}

export interface DraftView extends TeamsView {
  id: number;
  mode: Mode;
  option: number;
  options: number;
}

export interface MatchView extends TeamsView {
  id: number;
  mode: Mode;
  modeLabel: string;
  phase: MatchPhase;
  captainA: string;
  captainB: string;
  pool: string[];
  bans: Ban[];
  remaining: string[];
  turn: TeamKey | null;
  deadline: number | null;
  map: string | null;
  sideA: Side | null;
  sidePicker: TeamKey | null;
  serverName: string | null;
  status: string;
  error: string | null;
  connected: number;
  expected: number;
  warmup: boolean;
  score: { a: number; b: number } | null;
  createdAt: number;
  endedAt: number | null;
  /** Only for players in the match. */
  join: { port: number; password: string } | null;
  /** The bot filling a short team: which team, whether it plays, and the captains' votes. */
  bots: { team: TeamKey; on: boolean; votes: { a: boolean; b: boolean }; counts: { a: number; b: number } } | null;
  /** The viewer's own team's Discord voice channel. */
  discord: { channel: string; invite: string | null } | null;
  /** Mid-match joins: open unless both captains voted no. */
  lateJoins: { open: boolean; votes: { a: boolean; b: boolean } };
  /** For a viewer not in the match: the team they'd join, or why they can't. */
  canJoin: { team: TeamKey | null; reason: string | null } | null;
}

/** A match as the Discord bot needs it. */
export interface VoiceMatchInfo {
  id: number;
  mode: Mode;
  serverId: number;
  teams: { a: string[]; b: string[] };
}

export interface CasualView {
  id: number;
  name: string;
  map: string | null;
  players: number;
  maxPlayers: number;
  online: boolean;
  port: number;
  /** Shown to everyone on the site (Sune's choice). */
  password: string;
  /** Its Discord voice channel: its own, or the casual servers' shared one. */
  discord?: { channel: string; invite: string | null } | null;
}

export interface StateView {
  title: string;
  enabled: boolean;
  me: {
    steamId: string;
    name: string;
    avatarUrl: string | null;
    rating: RatingView;
    selfRating: number | null;
    inLobby: boolean;
    /** Which lobby they're in. */
    mode: Mode | null;
    ready: boolean;
    leetifyUrl: string;
  } | null;
  lobbies: {
    mode: Mode;
    label: string;
    teamSize: number;
    fixed: boolean;
    maps: string[];
    players: number;
    ready: number;
    freeServers: number;
    matchServers: number;
  }[];
  /** The viewer's Fixed teams lobby: captains, start votes and whether it can start. */
  fixed: FixedView | null;
  lobby: LobbyView[];
  drafts: DraftView[];
  matches: MatchView[];
  /** Uploaded images, as URLs on the matchmaking site. */
  look: { icon: string | null; banner: string | null; layout: "classic" | "board"; language: "en" | "da" };
  /** Servers anyone can join, shown even to people who aren't signed in. */
  casual: { name: string; servers: CasualView[]; discord: { channel: string; invite: string | null } | null };
  /** Steam's names for Workshop maps, by "workshop:ID". */
  mapNames: Record<string, string>;
  freeServers: number;
  /** Why each match server is or isn't free. */
  serverStates: { name: string; state: string; label: string }[];
  /** Servers set up for matches (in the pool, with the bridge), busy or not. */
  matchServers: number;
  now: number;
}

export interface FixedView {
  mode: Mode;
  captainA: string | null;
  captainB: string | null;
  votes: { a: boolean; b: boolean };
  /** Both teams full: anyone on a team can start. */
  full: boolean;
  /** Why it can't start yet, if it can't. */
  reason: string | null;
}

export interface MatchmakingDeps {
  db: Db;
  settings: Settings;
  box: SecretBox;
  players: MmPlayerStore;
  servers: ServerService;
  hasBridge: (serverId: number) => boolean;
  /** A plugin is being installed or updated on the server (it may be restarting). */
  pluginBusy?: (serverId: number) => boolean;
  files: InstanceFiles;
  host: Host;
  rcon: RconExec;
  /** People on a server right now, if known. */
  humans: (serverId: number) => number | null;
  isBanned: (steamId: string) => boolean;
  audit: AuditLog;
  images: SiteImages;
  /** What Steam says about a Workshop map. */
  workshop: (id: string) => Promise<WorkshopInfo>;
  fetchFn: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Picks a random index below n (tests replace it). */
  random?: (n: number) => number;
}

const ACTIVE: MatchPhase[] = ["veto", "side", "starting", "live"];
const humans = (team: Member[]) => team.filter((p) => p.steamId !== BOT_ID);
const botCount = (team: Member[]) => team.filter((p) => p.steamId === BOT_ID).length;
/** The team playing with bot(s) (the one with more, if both): what "the bot's team" means for joins and votes. */
const botTeamOf = (m: { teamA: Member[]; teamB: Member[] }): TeamKey | null => {
  const [a, b] = [botCount(m.teamA), botCount(m.teamB)];
  return a === 0 && b === 0 ? null : a >= b ? "a" : "b";
};
/** People who should be on the server (the bot doesn't count). */
const expected = (m: { teamA: Member[]; teamB: Member[] }) => humans(m.teamA).length + humans(m.teamB).length;
const isActive = (m: Match) => ACTIVE.includes(m.phase);
const MATCH_MARKER = "CS2PANEL_MATCH ";

export class Matchmaking {
  readonly leetify: LeetifyClient;
  private lobby = new Map<string, LobbyEntry>();
  private drafts = new Map<Mode, Draft>();
  private matches: Match[] = [];
  private nextDraftId = 1;
  private timer: NodeJS.Timeout | null = null;
  private lastPoll = 0;
  /** Match servers whose cleanup hasn't been done and checked yet, by server ID. */
  private cleanups = new Map<number, Cleanup>();
  /** Workshop map titles from Steam, by "workshop:ID". */
  private mapTitles = new Map<string, string>();
  private imageVersions: Record<ImageKind, number | null> = { icon: null, banner: null };
  /** Called after settings change, so the public site can start, stop or move. */
  onSettingsChanged: () => Promise<void> = async () => undefined;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: (n: number) => number;

  constructor(private readonly d: MatchmakingDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = d.random ?? ((n) => randomInt(n));
    this.leetify = new LeetifyClient(d.fetchFn, () => this.leetifyKey(), this.now);
  }

  // ------------------------------------------------------------- settings

  config(): MatchmakingSettings {
    const stored = this.d.settings.get<Partial<MatchmakingSettings> & { maps?: string[] }>("matchmaking", {});
    const { maps: legacyMaps, ...rest } = stored;
    const modes = { ...DEFAULT_SETTINGS.modes };
    for (const k of MODES) if (stored.modes?.[k]) modes[k] = { ...DEFAULT_SETTINGS.modes[k], ...stored.modes[k] };
    // Before each lobby had its own servers, every lobby used all the match servers.
    for (const k of MODES) if (!modes[k].serverIds) modes[k] = { ...modes[k], serverIds: [...((rest as { serverIds?: number[] }).serverIds ?? [])] };
    // A saved copy of an earlier built-in 1v1 config follows the current default.
    if (OLD_DUEL_CONFIGS.includes(modes.duel.config)) modes.duel = { ...modes.duel, config: DUEL_CONFIG };
    // Before lobbies there was one map pool, for Competitive.
    if (!stored.modes && legacyMaps?.length) modes.competitive = { ...modes.competitive, enabled: true, maps: legacyMaps };
    return {
      ...DEFAULT_SETTINGS,
      ...rest,
      modes,
      look: { ...DEFAULT_LOOK, ...(stored.look ?? {}) },
      casual: { ...DEFAULT_SETTINGS.casual, ...(stored.casual ?? {}) },
      discord: { ...DEFAULT_SETTINGS.discord, ...(stored.discord ?? {}) },
    };
  }

  /** Lobbies that are open, in display order. */
  openModes(c: MatchmakingSettings = this.config()): Mode[] {
    return MODES.filter((m) => c.modes[m].enabled && c.modes[m].maps.length > 0);
  }

  private leetifyKey(): string | null {
    try {
      return this.d.box.openOptional(this.d.settings.get<string | null>("matchmaking.leetifyKey", null));
    } catch {
      return null;
    }
  }

  leetifyKeyHint(): string | null {
    const key = this.leetifyKey();
    return key ? `…${key.slice(-4)}` : null;
  }

  /**
   * Takes a Workshop map out of a lobby's pool and deletes its downloaded files from every server,
   * unless something still uses it: another lobby, a casual map cycle or a server's own map.
   */
  async removeWorkshopMap(id: string, mode: Mode, actorId: number): Promise<{ deleted: number; keptBecause: string[] }> {
    if (!/^\d{3,20}$/.test(id)) throw badRequest("That's not a Workshop ID.");
    const map = `workshop:${id}`;
    const c = this.config();
    const stored = this.d.settings.get<MatchmakingSettings | null>("matchmaking", null);
    if (stored?.modes?.[mode]) {
      stored.modes[mode].maps = stored.modes[mode].maps.filter((m) => m !== map);
      this.d.settings.set("matchmaking", stored);
    }
    const keptBecause: string[] = [];
    for (const other of MODES) if (other !== mode && c.modes[other].maps.includes(map)) keptBecause.push(`the ${MODE_INFO[other].label} lobby`);
    const servers = this.d.db.prepare("SELECT id, slug, name FROM servers").all() as { id: number; slug: string; name: string }[];
    for (const s of servers) {
      const row = this.d.db.prepare("SELECT map, map_cycle FROM servers WHERE id = ?").get(s.id) as
        { map: string | null; map_cycle: string | null } | undefined;
      if (row?.map === map) keptBecause.push(`${s.name}'s map`);
      if (row?.map_cycle && row.map_cycle.includes(`"${map}"`)) keptBecause.push(`${s.name}'s map cycle`);
    }
    let deleted = 0;
    if (!keptBecause.length) {
      for (const s of servers) {
        for (const base of [this.d.files.upperDir(s.slug), this.d.files.mergedDir(s.slug)]) {
          const dir = path.join(base, "game", "bin", "linuxsteamrt64", "steamapps", "workshop", "content", "730", id);
          try {
            await fs.access(dir);
            await fs.rm(dir, { recursive: true, force: true });
            deleted++;
            break;
          } catch {
            /* not downloaded here */
          }
        }
      }
    }
    this.d.audit.record(actorId, "matchmaking.workshop.remove", null, {
      map: id,
      lobby: MODE_INFO[mode].label,
      deleted,
      ...(keptBecause.length ? { kept: keptBecause.join(", ") } : {}),
    });
    return { deleted, keptBecause };
  }

  async saveConfig(raw: unknown, leetifyKey: string | null | undefined, actorId: number): Promise<MatchmakingSettings> {
    const next = MatchmakingSettingsSchema.parse(raw);
    const known = new Set(this.d.servers.listRecords().map((s) => s.id));
    next.casual.serverIds = [...new Set(next.casual.serverIds)].filter((id) => known.has(id));
    // Each lobby's servers; a casual server is never used for matches. All of them together are the match servers.
    for (const m of MODES) {
      // Sent without per-lobby servers (an older page or script): the lobby uses the shared list.
      next.modes[m].serverIds = [...new Set(next.modes[m].serverIds ?? next.serverIds)].filter((id) => known.has(id) && !next.casual.serverIds.includes(id));
    }
    next.serverIds = [...new Set(MODES.flatMap((m) => next.modes[m].serverIds!))];
    // Discord links by server ID: drop deleted servers and empty fields. Servers that are only unticked keep theirs.
    const live = (id: string) => known.has(Number(id));
    next.discord.channels = Object.fromEntries(Object.entries(next.discord.channels).filter(([id, v]) => live(id) && (v.a || v.b)));
    next.discord.duelServers = Object.fromEntries(Object.entries(next.discord.duelServers ?? {}).filter(([id, v]) => live(id) && v));
    next.discord.casualServers = Object.fromEntries(Object.entries(next.discord.casualServers ?? {}).filter(([id, v]) => live(id) && v));
    for (const id of next.casual.serverIds) {
      if (this.matches.some((m) => m.serverId === id && (isActive(m) || !m.released)) || this.cleanups.has(id)) {
        throw badRequest(`${this.d.servers.require(id).name} is running a match right now. Make it casual when the match is over.`);
      }
    }
    for (const m of MODES) next.modes[m].maps = [...new Set(next.modes[m].maps)];
    // Same check as on a server's page: no removed, missing, private or non-CS2 Workshop maps.
    const workshopIds = [...new Set(MODES.flatMap((m) => next.modes[m].maps))].map((x) => parseMapSpec(x)).filter((x) => x?.kind === "workshop");
    for (const spec of workshopIds) {
      const info = await this.d.workshop(spec!.id);
      if (workshopBlocks(info.status)) throw badRequest(`Workshop map ${spec!.id}: ${info.message}`);
      if (info.title) this.mapTitles.set(`workshop:${spec!.id}`, info.title);
    }
    const before = this.config();
    this.d.settings.set("matchmaking", next);
    if (leetifyKey !== undefined) {
      const key = leetifyKey?.trim() || null;
      if (key && !/^[\w-]{8,200}$/.test(key)) throw badRequest("That doesn't look like a Leetify API key.");
      this.d.settings.set("matchmaking.leetifyKey", this.d.box.sealOptional(key));
      this.leetify.clear();
    }
    this.d.audit.record(actorId, "matchmaking.settings", null, {
      enabled: next.enabled,
      port: next.port,
      servers: next.serverIds.length,
      lobbies: this.openModes(next).map((m) => MODE_INFO[m].label),
      ...(leetifyKey !== undefined ? { leetifyKey: leetifyKey ? "changed" : "removed" } : {}),
    });
    if (!next.enabled && before.enabled) {
      // Nobody can reach the site any more; take down the waiting room, but let running matches finish.
      this.lobby.clear();
      this.drafts.clear();
    }
    // People in a lobby that just closed go back to choosing.
    for (const e of [...this.lobby.values()]) if (!this.openModes(next).includes(e.mode)) this.removeFromLobby(e.steamId);
    // Tell the bridge on servers that became casual (or stopped being casual), so it balances teams on join.
    const was = new Set(before.casual.serverIds);
    const now = new Set(next.casual.serverIds);
    for (const id of new Set([...was, ...now])) {
      if (was.has(id) !== now.has(id)) await this.setCasualFlag(id, now.has(id)).catch(() => undefined);
    }
    void this.refreshCasual();
    await this.onSettingsChanged();
    return next;
  }

  // ------------------------------------------------------------- images

  async saveImage(kind: ImageKind, data: Buffer, actorId: number): Promise<void> {
    await this.d.images.save(kind, data);
    this.imageVersions = await this.d.images.versions();
    this.d.audit.record(actorId, "matchmaking.image", null, { kind, removed: false });
  }

  async removeImage(kind: ImageKind, actorId: number): Promise<void> {
    await this.d.images.remove(kind);
    this.imageVersions = await this.d.images.versions();
    this.d.audit.record(actorId, "matchmaking.image", null, { kind, removed: true });
  }

  readImage(kind: ImageKind): Promise<{ data: Buffer; type: string } | null> {
    return this.d.images.read(kind);
  }

  imageUrls(): { icon: string | null; banner: string | null } {
    const v = this.imageVersions;
    return { icon: v.icon ? `/branding/icon?v=${v.icon}` : null, banner: v.banner ? `/branding/banner?v=${v.banner}` : null };
  }

  // ------------------------------------------------------------- lifecycle

  /** Matches the panel was running when it stopped can't be resumed; give their servers back. */
  async recover(): Promise<void> {
    this.imageVersions = await this.d.images.versions().catch(() => ({ icon: null, banner: null }));
    for (const id of this.config().casual.serverIds) await this.setCasualFlag(id, true).catch(() => undefined);
    void this.loadMapTitles();
    const open = this.d.db.prepare(`SELECT id, server_id FROM mm_matches WHERE status IN ('veto','side','starting','live')`).all() as {
      id: number;
      server_id: number | null;
    }[];
    for (const row of open) {
      this.d.db.prepare("UPDATE mm_matches SET status = 'abandoned', note = 'The panel restarted', ended_at = datetime('now') WHERE id = ?").run(row.id);
      if (row.server_id) this.queueCleanup(row.server_id, "The match was ended (the panel restarted). Back to the site for the next one.");
    }
    // Cleanups that were still pending when the panel stopped, plus the ones above. Failures are retried by tick().
    const pending = this.d.db.prepare("SELECT server_id, reason, attempts, last_error FROM mm_cleanup").all() as {
      server_id: number;
      reason: string;
      attempts: number;
      last_error: string | null;
    }[];
    for (const row of pending) {
      const c = this.cleanups.get(row.server_id);
      if (c) continue;
      this.cleanups.set(row.server_id, {
        serverId: row.server_id,
        reason: row.reason,
        attempts: row.attempts,
        lastError: row.last_error,
        nextAt: 0,
        running: false,
        again: false,
      });
    }
    for (const id of [...this.cleanups.keys()]) await this.runCleanup(id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Timeouts, presence, and checking on live matches. Runs every second. */
  async tick(): Promise<void> {
    const t = this.now();
    for (const [id, e] of this.lobby) {
      if (t - e.lastSeen > PRESENCE_MS && !this.activeMatchOf(id)) this.removeFromLobby(id);
    }
    for (const [mode, d] of this.drafts) if (t - d.createdAt > DRAFT_MS) this.drafts.delete(mode);

    for (const m of this.matches) {
      if (m.phase === "veto" && m.deadline !== null && t >= m.deadline) {
        const remaining = this.remaining(m);
        this.applyBan(m, remaining[this.random(remaining.length)]!, m.turn, true);
      } else if (m.phase === "side" && m.deadline !== null && t >= m.deadline) {
        this.applySide(m, this.random(2) === 0 ? "ct" : "t");
      } else if (m.phase === "over" && m.overAt !== null && !m.released && t - m.overAt >= RELEASE_AFTER_MS) {
        await this.finish(m, "over", null);
      }
    }

    for (const c of this.cleanups.values()) if (!c.running && t >= c.nextAt) void this.runCleanup(c.serverId);

    if (t - this.lastCasual >= POLL_MS && this.config().casual.serverIds.length) void this.refreshCasual();
    if (t - this.lastPoll >= POLL_MS) {
      this.lastPoll = t;
      await Promise.all(this.matches.filter((m) => m.phase === "live" && !m.polling).map((m) => this.poll(m)));
    }

    // Ended matches stay a while for their own players (score, what happened); servers stay held until released.
    this.matches = this.matches.filter((m) => isActive(m) || !m.released || (m.endedAt !== null && t - m.endedAt < KEEP_ENDED_MS));
  }

  // ------------------------------------------------------------- players and ratings

  private player(steamId: string): MmPlayer {
    return this.d.players.get(steamId) ?? this.d.players.ensure(steamId);
  }

  private displayName(p: MmPlayer): string {
    return p.name ?? `Player …${p.steamId.slice(-4)}`;
  }

  /** The rating right now, without waiting for Leetify (it's asked in the background). */
  private ratingNow(p: MmPlayer): RatingView {
    if (p.overrideRating !== null) return { value: p.overrideRating, source: "admin", note: null };
    const cached = this.leetify.peek(p.steamId);
    if (!cached) {
      void this.leetify.premier(p.steamId);
      if (p.selfRating !== null) return { value: p.selfRating, source: "self", note: null, pending: true };
      return { value: null, source: "none", note: null, pending: true };
    }
    const fc = this.config().faceit ?? { blend: "average", table: FACEIT_TABLE };
    const fromFaceit = cached.faceit && fc.blend !== "off" ? faceitToPremier(cached.faceit.elo, fc.table) : null;
    if (cached.premier !== null || fromFaceit !== null) {
      const pr = cached.premier;
      const value =
        pr !== null && fromFaceit !== null
          ? fc.blend === "faceit"
            ? fromFaceit
            : fc.blend === "premier"
              ? pr
              : Math.round((pr + fromFaceit) / 2)
          : (pr ?? fromFaceit)!;
      // The badge shows the stronger one in its own format; FACEIT numbers are never shown as Premier.
      const badge =
        fromFaceit !== null && (pr === null || fromFaceit > pr) ? `FACEIT ${cached.faceit!.level ?? "?"} · ${cached.faceit!.elo.toLocaleString("en")}` : null;
      return { value, badge, source: "leetify", note: null };
    }
    if (p.selfRating !== null) return { value: p.selfRating, source: "self", note: cached.note };
    return { value: null, source: "none", note: cached.note };
  }

  /** The rating, after asking Leetify if needed. */
  private async rating(p: MmPlayer): Promise<RatingView> {
    if (p.overrideRating === null) await this.leetify.premier(p.steamId);
    return this.ratingNow(p);
  }

  setSelfRating(steamId: string, rating: number | null): void {
    if (rating !== null && (!Number.isInteger(rating) || rating < 0 || rating > MAX_RATING)) {
      throw badRequest(`Enter your Premier rating as a number from 0 to ${MAX_RATING.toLocaleString("en")}.`);
    }
    this.d.players.ensure(steamId);
    this.d.players.setSelfRating(steamId, rating);
  }

  setOverride(steamId: string, rating: number | null, actorId: number): void {
    if (!/^7656119\d{10}$/.test(steamId)) throw badRequest("Not a SteamID64.");
    if (rating !== null && (!Number.isInteger(rating) || rating < 0 || rating > MAX_RATING)) {
      throw badRequest(`The rating must be a number from 0 to ${MAX_RATING.toLocaleString("en")}.`);
    }
    this.d.players.setOverrideRating(steamId, rating);
    this.d.audit.record(actorId, "matchmaking.rating", null, { steamId, name: this.d.players.get(steamId)?.name ?? null, rating });
  }

  // ------------------------------------------------------------- lobby

  private requireEnabled(): MatchmakingSettings {
    const c = this.config();
    if (!c.enabled) throw badRequest("Matchmaking is switched off right now.");
    return c;
  }

  touch(steamId: string): void {
    const e = this.lobby.get(steamId);
    if (e) e.lastSeen = this.now();
  }

  join(steamId: string, mode: Mode): void {
    const c = this.requireEnabled();
    if (!this.openModes(c).includes(mode)) throw badRequest(`The ${MODE_INFO[mode].label} lobby isn't open.`);
    if (this.d.isBanned(steamId)) throw forbidden("You're banned from these servers.");
    this.d.players.ensure(steamId);
    const t = this.now();
    const e = this.lobby.get(steamId);
    if (e && e.mode === mode) {
      e.lastSeen = t;
      return;
    }
    if (e) {
      if (this.activeMatchOf(steamId)) throw badRequest("Finish your match before changing lobby.");
      this.dropDraftsWith(steamId);
    }
    this.lobby.set(steamId, { steamId, mode, ready: true, readySince: t, joinedAt: t, lastSeen: t, sitOuts: 0, team: this.openTeam(mode) });
  }

  // ------------------------------------------------------------- fixed teams

  /** Players waiting in a Fixed teams lobby, by the team they picked (not those already in a match). */
  private fixedTeams(mode: Mode): { a: LobbyEntry[]; b: LobbyEntry[] } {
    const here = [...this.lobby.values()].filter((e) => e.mode === mode && !this.activeMatchOf(e.steamId)).sort((x, y) => x.joinedAt - y.joinedAt);
    return { a: here.filter((e) => e.team === "a"), b: here.filter((e) => e.team === "b") };
  }

  /** For a newcomer to a Fixed teams lobby: the smaller team with room, or none (waiting for a spot). */
  private openTeam(mode: Mode): TeamKey | null {
    if (!MODE_INFO[mode].fixed) return null;
    const { a, b } = this.fixedTeams(mode);
    const size = MODE_INFO[mode].teamSize;
    if (a.length >= size && b.length >= size) return null;
    if (a.length >= size) return "b";
    if (b.length >= size) return "a";
    return b.length < a.length ? "b" : "a";
  }

  /** The best-rated player on a fixed team is its captain (the first to join on a tie). */
  private fixedCaptain(team: LobbyEntry[]): string | null {
    let best: LobbyEntry | null = null;
    let bestRating = -1;
    for (const e of team) {
      const r = this.ratingNow(this.player(e.steamId)).value ?? 0;
      if (r > bestRating) [best, bestRating] = [e, r];
    }
    return best?.steamId ?? null;
  }

  /** Each Fixed teams lobby's start votes: the captain who voted, per team (void once they're no longer captain). */
  private fixedVotes = new Map<Mode, { a: string | null; b: string | null }>();

  private fixedView(mode: Mode): FixedView {
    const { a, b } = this.fixedTeams(mode);
    const size = MODE_INFO[mode].teamSize;
    const captainA = this.fixedCaptain(a);
    const captainB = this.fixedCaptain(b);
    const v = this.fixedVotes.get(mode) ?? { a: null, b: null };
    const votes = { a: !!captainA && v.a === captainA, b: !!captainB && v.b === captainB };
    const full = a.length === size && b.length === size;
    const reason = full
      ? null
      : !a.length || !b.length
        ? "Each team needs at least one player."
        : `Not full yet (${a.length}v${b.length}): both captains vote to start, and bots fill the empty spots.`;
    return { mode, captainA, captainB, votes, full, reason };
  }

  /** Picks a team in a Fixed teams lobby (null: step out and wait). */
  pickTeam(steamId: string, team: TeamKey | null): void {
    this.requireEnabled();
    const e = this.lobby.get(steamId);
    if (!e || !MODE_INFO[e.mode].fixed) throw badRequest("Join a Fixed teams lobby first.");
    if (this.activeMatchOf(steamId)) throw badRequest("You're in a match.");
    if (e.team === team) return;
    if (team) {
      const others = this.fixedTeams(e.mode)[team].filter((x) => x.steamId !== steamId);
      if (others.length >= MODE_INFO[e.mode].teamSize) throw badRequest("That team is full.");
    }
    e.team = team;
    e.lastSeen = this.now();
  }

  /**
   * Starts a Fixed teams match: straight away when both teams are full (anyone on a team), otherwise once
   * both captains have voted. Returns the match ID, or null while waiting for the other captain.
   */
  async startFixed(by: string): Promise<number | null> {
    const c = this.requireEnabled();
    const e = this.lobby.get(by);
    if (!e || !MODE_INFO[e.mode].fixed) throw badRequest("Join a Fixed teams lobby first.");
    if (this.activeMatchOf(by)) throw badRequest("You're already in a match.");
    if (!e.team) throw badRequest("Pick a team first.");
    const mode = e.mode;
    const view = this.fixedView(mode);
    if (!view.full) {
      if (!view.captainA || !view.captainB) throw badRequest("Each team needs at least one player.");
      const mine: TeamKey | null = view.captainA === by ? "a" : view.captainB === by ? "b" : null;
      if (!mine) throw forbidden("The teams aren't full: only the two captains can start (both have to vote).");
      const v = this.fixedVotes.get(mode) ?? { a: null, b: null };
      v[mine] = by;
      this.fixedVotes.set(mode, v);
      if (!this.fixedView(mode).votes[mine === "a" ? "b" : "a"]) return null;
    }
    if ((await this.freeServers(mode)).length === 0) {
      if (!this.poolRecords(mode).some((s) => this.d.hasBridge(s.id)))
        throw badRequest(`No server is set up for ${MODE_INFO[mode].label} yet. Ask the organiser.`);
      throw badRequest(`Every ${MODE_INFO[mode].label} server is busy. Wait for a match to finish.`);
    }
    const { a, b } = this.fixedTeams(mode);
    const teamA = await Promise.all(a.map((x) => this.member(x.steamId)));
    const teamB = await Promise.all(b.map((x) => this.member(x.steamId)));
    // Things may have changed while Leetify answered.
    const now = this.fixedTeams(mode);
    if (now.a.length !== a.length || now.b.length !== b.length || this.activeMatchOf(by)) throw badRequest("The teams changed. Try again.");
    const known = [...teamA, ...teamB]
      .map((p) => p.rating.value)
      .filter((v): v is number => v !== null)
      .sort((x, y) => x - y);
    const stand = known.length ? known[Math.floor(known.length / 2)]! : FALLBACK_RATING;
    for (const p of [...teamA, ...teamB]) p.effective = p.rating.value ?? stand;
    // Bots fill every empty spot (the captains can vote them off in the match).
    const size = MODE_INFO[mode].teamSize;
    while (teamA.length < size) teamA.push(this.botMember());
    while (teamB.length < size) teamB.push(this.botMember());
    this.fixedVotes.delete(mode);
    return this.createMatch(c, mode, teamA, teamB, "Fixed teams picked on the matchmaking site");
  }

  leave(steamId: string): void {
    this.removeFromLobby(steamId);
  }

  setReady(steamId: string, ready: boolean): void {
    const e = this.lobby.get(steamId);
    if (!e) throw badRequest("Join the lobby first.");
    if (e.ready !== ready) {
      e.ready = ready;
      e.readySince = this.now();
    }
    if (!ready) this.dropDraftsWith(steamId);
  }

  private dropDraftsWith(steamId: string): void {
    for (const [mode, d] of this.drafts) if (d.players.some((p) => p.steamId === steamId)) this.drafts.delete(mode);
  }

  private removeFromLobby(steamId: string): void {
    this.lobby.delete(steamId);
    this.dropDraftsWith(steamId);
  }

  /** Removed by a panel admin. They can join again unless they're banned. */
  kick(steamId: string, actorId: number): void {
    if (!this.lobby.has(steamId)) throw notFound("That player isn't in the lobby.");
    this.removeFromLobby(steamId);
    this.d.audit.record(actorId, "matchmaking.kick", null, { steamId, name: this.d.players.get(steamId)?.name ?? null });
  }

  private activeMatchOf(steamId: string): Match | undefined {
    return this.matches.find((m) => isActive(m) && [...m.teamA, ...m.teamB].some((p) => p.steamId === steamId));
  }

  /** Lobby members of one lobby who can be put in a match now. */
  private available(mode: Mode): LobbyEntry[] {
    return [...this.lobby.values()].filter((e) => e.mode === mode && e.ready && !this.activeMatchOf(e.steamId));
  }

  // ------------------------------------------------------------- servers

  /** The match servers, or only one lobby's. */
  private poolRecords(mode?: Mode): ServerRecord[] {
    const c = this.config();
    const ids = new Set((mode ? (c.modes[mode].serverIds ?? []) : c.serverIds).filter((id) => !c.casual.serverIds.includes(id)));
    return this.d.servers.listRecords().filter((s) => ids.has(s.id));
  }

  /** Looks up the names of the Workshop maps in the pools, so players see "Aim Botz" instead of a number. */
  async loadMapTitles(): Promise<void> {
    const c = this.config();
    for (const map of new Set(MODES.flatMap((m) => c.modes[m].maps))) {
      const spec = parseMapSpec(map);
      if (spec?.kind !== "workshop" || this.mapTitles.has(map)) continue;
      const info = await this.d.workshop(spec.id).catch(() => null);
      if (info?.title) this.mapTitles.set(map, info.title);
    }
  }

  /** Names for Workshop maps, by "workshop:ID". */
  mapNames(): Record<string, string> {
    return Object.fromEntries(this.mapTitles);
  }

  // ------------------------------------------------------------- casual servers

  private casualInfo = new Map<number, CasualView>();
  private lastCasual = 0;

  /** Marks a server casual (or not) for the bridge: casual servers put each newcomer on the smaller team. */
  private async setCasualFlag(serverId: number, casual: boolean): Promise<void> {
    const s = this.d.servers.listRecords().find((x) => x.id === serverId);
    if (!s || !this.d.hasBridge(s.id)) return;
    await this.matchFile(s, { version: 1, active: false, casual, players: [] });
    if ((await this.d.host.serviceStatus(s.slug)).state === "active") await this.exec(s, "cs2panel_match_reload").catch(() => undefined);
  }

  /** Name, map and head count of the casual servers, for the site (asked every 10 seconds, not on every page refresh). */
  async refreshCasual(): Promise<void> {
    this.lastCasual = this.now();
    const ids = this.config().casual.serverIds;
    const next = new Map<number, CasualView>();
    for (const id of ids) {
      try {
        const v = await this.d.servers.get(id);
        next.set(id, {
          id,
          name: v.live?.name || v.name,
          map: v.live?.map ?? null,
          players: v.live ? v.live.players - (v.live.bots ?? 0) : 0,
          maxPlayers: v.live?.maxPlayers ?? v.maxPlayers,
          online: v.answering === "yes",
          port: v.port,
          password: v.password,
        });
      } catch {
        /* server deleted */
      }
    }
    this.casualInfo = next;
  }

  /** A match still holds the server: running, or not yet completely freed (kicked, unlocked, password back). */
  private reserved(serverId: number): boolean {
    return this.matches.some((m) => m.serverId === serverId && (isActive(m) || !m.released));
  }

  /** When each server was last emptied and unlocked by matchmaking. */
  private freedAt = new Map<number, number>();

  /** People on the server, ignoring the stale count right after matchmaking kicked everyone. */
  private peopleOn(serverId: number): number {
    const freed = this.freedAt.get(serverId);
    if (freed !== undefined && this.now() - freed < 60_000) return 0;
    return this.d.humans(serverId) ?? 0;
  }

  /** Why each match server is or isn't free, for the panel and the site. */
  serverStates(): {
    id: number;
    name: string;
    state: "free" | "in-match" | "freeing" | "cleanup-failed" | "people" | "no-bridge";
    label: string;
  }[] {
    return this.poolRecords().map((s) => {
      const holder = this.matches.find((m) => m.serverId === s.id && (isActive(m) || !m.released));
      if (holder && isActive(holder)) return { id: s.id, name: s.name, state: "in-match" as const, label: `Running match ${holder.id}` };
      if (holder) return { id: s.id, name: s.name, state: "freeing" as const, label: "Showing the scoreboard, then emptied" };
      const c = this.cleanups.get(s.id);
      if (c && c.attempts > 0) {
        const wait = Math.max(0, Math.ceil((c.nextAt - this.now()) / 1000));
        return {
          id: s.id,
          name: s.name,
          state: "cleanup-failed" as const,
          label: `Couldn't be emptied after a match (tried ${c.attempts}×: ${c.lastError ?? "unknown error"}). ${c.running ? "Trying again now" : `Trying again in ${wait} s`}`,
        };
      }
      if (c) return { id: s.id, name: s.name, state: "freeing" as const, label: "Being emptied after a match" };
      if (this.d.pluginBusy?.(s.id)) return { id: s.id, name: s.name, state: "freeing" as const, label: "Updating a plugin" };
      if (!this.d.hasBridge(s.id)) return { id: s.id, name: s.name, state: "no-bridge" as const, label: "Needs CounterStrikeSharp (with CS2 Panel Bridge)" };
      const people = this.peopleOn(s.id);
      if (people > 0) return { id: s.id, name: s.name, state: "people" as const, label: `${people} ${people === 1 ? "person" : "people"} on it` };
      return { id: s.id, name: s.name, state: "free" as const, label: "Free" };
    });
  }

  /**
   * Free match servers, best first: running ones that have been idle a while,
   * then stopped ones (they need starting), then the ones just freed.
   */
  /** Free servers for a lobby's next match, best first. */
  private async freeServers(mode: Mode): Promise<ServerRecord[]> {
    const t = this.now();
    const free: { s: ServerRecord; rank: number; freed: number }[] = [];
    const ok = new Set(
      this.serverStates()
        .filter((x) => x.state === "free")
        .map((x) => x.id),
    );
    for (const s of this.poolRecords(mode)) {
      if (!ok.has(s.id)) continue;
      const running = (await this.d.host.serviceStatus(s.slug)).state === "active";
      const freed = this.freedAt.get(s.id) ?? 0;
      const recent = t - freed < 5 * 60_000;
      free.push({ s, rank: recent ? 2 : running ? 0 : 1, freed });
    }
    return free.sort((x, y) => x.rank - y.rank || x.freed - y.freed).map((x) => x.s);
  }

  private freeCountSync(mode?: Mode): number {
    const ids = mode ? new Set(this.poolRecords(mode).map((s) => s.id)) : null;
    return this.serverStates().filter((x) => x.state === "free" && (!ids || ids.has(x.id))).length;
  }

  // ------------------------------------------------------------- making teams

  private async member(steamId: string): Promise<Member> {
    const p = this.player(steamId);
    const rating = await this.rating(p);
    return { steamId, name: this.displayName(p), avatarUrl: p.avatarUrl, rating, effective: rating.value ?? 0 };
  }

  private botMember(): Member {
    const level = BOT_LEVELS[this.config().botDifficulty] ?? BOT_LEVELS[1];
    const rating: RatingView = { value: level.rating, source: "bot", note: null };
    return { steamId: BOT_ID, name: `Bot (${level.label})`, avatarUrl: null, rating, effective: level.rating };
  }

  async makeTeams(by: string): Promise<void> {
    this.requireEnabled();
    const me = this.lobby.get(by);
    if (!me) throw badRequest("Join a lobby first.");
    if (this.activeMatchOf(by)) throw badRequest("You're already in a match.");
    const mode = me.mode;
    if (MODE_INFO[mode].fixed) throw badRequest("In Fixed teams, pick a team and press Start.");
    if (this.drafts.has(mode)) return;
    const size = MODE_INFO[mode].teamSize;
    // An odd number of players plays with a bot on the short team, so nobody waits.
    const chosen = choosePlayers(this.available(mode), size * 2, size > 1);
    if (chosen.length < 2) throw badRequest("At least 2 ready players are needed to make teams.");
    if ((await this.freeServers(mode)).length === 0) {
      if (!this.poolRecords(mode).some((s) => this.d.hasBridge(s.id)))
        throw badRequest(`No server is set up for ${MODE_INFO[mode].label} yet. Ask the organiser.`);
      throw badRequest(`Every ${MODE_INFO[mode].label} server is busy. Wait for a match to finish.`);
    }

    const players = await Promise.all(chosen.map((e) => this.member(e.steamId)));
    // Someone without any rating counts as the middle of everyone else, so they don't skew a team.
    const known = players
      .map((p) => p.rating.value)
      .filter((v): v is number => v !== null)
      .sort((x, y) => x - y);
    const stand = known.length ? known[Math.floor(known.length / 2)]! : FALLBACK_RATING;
    for (const p of players) p.effective = p.rating.value ?? stand;
    if (players.length % 2) players.push(this.botMember());

    if (this.drafts.has(mode)) return; // someone else was quicker while Leetify answered
    this.drafts.set(mode, {
      id: this.nextDraftId++,
      mode,
      players,
      splits: rankSplits(players.map((p) => ({ steamId: p.steamId, rating: p.effective }))).slice(0, 10),
      index: 0,
      createdAt: this.now(),
    });
  }

  private requireDraft(by: string, draftId: number): Draft {
    const d = [...this.drafts.values()].find((x) => x.id === draftId);
    if (!d) throw badRequest("Those teams aren't up any more.");
    if (!d.players.some((p) => p.steamId === by)) throw forbidden("Only players on these teams can do that.");
    return d;
  }

  reshuffle(by: string, draftId: number): void {
    const d = this.requireDraft(by, draftId);
    d.index = (d.index + 1) % d.splits.length;
    d.createdAt = this.now();
  }

  cancelDraft(by: string, draftId: number): void {
    const d = this.requireDraft(by, draftId);
    this.drafts.delete(d.mode);
  }

  async startDraft(by: string, draftId: number): Promise<number> {
    const c = this.requireEnabled();
    const d = this.requireDraft(by, draftId);
    const split = d.splits[d.index]!;
    const teamA = split.a.map((i) => d.players[i]!);
    const teamB = split.b.map((i) => d.players[i]!);
    // Bots fill every empty spot (the captains can vote them off), never in 1v1.
    if (d.mode !== "duel") {
      const size = MODE_INFO[d.mode].teamSize;
      while (teamA.length < size) teamA.push(this.botMember());
      while (teamB.length < size) teamB.push(this.botMember());
    }
    const id = await this.createMatch(c, d.mode, teamA, teamB, "Teams made on the matchmaking site", () => {
      if (this.drafts.get(d.mode) !== d) throw badRequest("Those teams aren't up any more.");
      this.drafts.delete(d.mode);
    });
    // Whoever was ready but didn't get a spot goes first next time.
    const picked = new Set(d.players.map((p) => p.steamId));
    for (const e of this.available(d.mode)) if (!picked.has(e.steamId)) e.sitOuts++;
    for (const pid of picked) {
      const e = this.lobby.get(pid);
      if (e) e.sitOuts = 0;
    }
    return id;
  }

  /** Takes a free server and starts the veto. `claim` runs once the server is certain, before anything changes. */
  private async createMatch(
    c: MatchmakingSettings,
    mode: Mode,
    teamA: Member[],
    teamB: Member[],
    reason: string,
    claim: () => void = () => undefined,
  ): Promise<number> {
    const candidates = await this.freeServers(mode);
    // Checked again without waiting in between, so two teams starting at once can't get the same server.
    const stillFree = new Set(
      this.serverStates()
        .filter((x) => x.state === "free")
        .map((x) => x.id),
    );
    const server = candidates.find((x) => stillFree.has(x.id));
    if (!server) throw badRequest("Every matchmaking server is busy. Wait for a match to finish.");
    claim();

    // The best-rated person on each team is captain; never a bot.
    const captain = (team: Member[]) => team.filter((p) => p.steamId !== BOT_ID).sort((x, y) => y.effective - x.effective)[0]!.steamId;
    const t = this.now();
    const pool = c.modes[mode].maps.slice();
    const bot = botTeamOf({ teamA, teamB });

    const row = this.d.db
      .prepare("INSERT INTO mm_matches (server_id, mode, team_a, team_b, status) VALUES (?, ?, ?, ?, 'veto')")
      .run(
        server.id,
        mode,
        JSON.stringify(teamA.map(({ steamId, name }) => ({ steamId, name }))),
        JSON.stringify(teamB.map(({ steamId, name }) => ({ steamId, name }))),
      );

    const m: Match = {
      id: Number(row.lastInsertRowid),
      mode,
      bot,
      teamA,
      teamB,
      captainA: captain(teamA),
      captainB: captain(teamB),
      phase: "veto",
      pool,
      bans: [],
      turn: this.random(2) === 0 ? "a" : "b",
      deadline: t + c.vetoSeconds * 1000,
      map: null,
      sideA: null,
      sidePicker: null,
      serverId: server.id,
      password: randomInt(10_000_000, 100_000_000).toString(36),
      status: "Captains are banning maps",
      error: null,
      readyAt: null,
      lastConnectedAt: null,
      connected: 0,
      bridgePhase: null,
      score: null,
      pollFailures: 0,
      polling: false,
      createdAt: t,
      overAt: null,
      endedAt: null,
      released: true,
      lateJoinVotes: { a: true, b: true },
      botVotes: { a: true, b: true },
    };
    this.matches.push(m);

    const bots = botCount(teamA) + botCount(teamB);
    this.d.audit.record(null, "matchmaking.match", server.id, {
      reason,
      match: m.id,
      mode: MODE_INFO[mode].label,
      players: humans(teamA).length + humans(teamB).length,
      ...(bots ? { bots } : {}),
    });
    if (pool.length === 1) this.toSidePick(m, pool[0]!, "b");
    return m.id;
  }

  // ------------------------------------------------------------- veto

  private requireMatch(id: number): Match {
    const m = this.matches.find((x) => x.id === id);
    if (!m) throw notFound("That match isn't running.");
    return m;
  }

  private remaining(m: Match): string[] {
    const banned = new Set(m.bans.map((b) => b.map));
    return m.pool.filter((x) => !banned.has(x));
  }

  private captainOf(m: Match, team: TeamKey): string {
    return team === "a" ? m.captainA : m.captainB;
  }

  ban(by: string, matchId: number, map: string): void {
    const m = this.requireMatch(matchId);
    if (m.phase !== "veto") throw badRequest("The map veto is over.");
    if (this.captainOf(m, m.turn) !== by) throw forbidden("It's the other captain's turn.");
    if (!this.remaining(m).includes(map)) throw badRequest("That map is already banned.");
    this.applyBan(m, map, m.turn, false);
  }

  private applyBan(m: Match, map: string, by: TeamKey, auto: boolean): void {
    m.bans.push({ map, by, auto });
    const left = this.remaining(m);
    if (left.length === 1) {
      // Like FACEIT: the team that didn't make the last ban picks its side.
      this.toSidePick(m, left[0]!, by === "a" ? "b" : "a");
      return;
    }
    m.turn = by === "a" ? "b" : "a";
    m.deadline = this.now() + this.config().vetoSeconds * 1000;
  }

  private toSidePick(m: Match, map: string, picker: TeamKey): void {
    m.map = map;
    m.phase = "side";
    m.sidePicker = picker;
    m.deadline = this.now() + this.config().vetoSeconds * 1000;
    m.status = "Picking sides";
    this.save(m);
  }

  pickSide(by: string, matchId: number, side: Side): void {
    const m = this.requireMatch(matchId);
    if (m.phase !== "side") throw badRequest("Sides are already picked.");
    if (this.captainOf(m, m.sidePicker!) !== by) throw forbidden("The other captain picks the side.");
    this.applySide(m, m.sidePicker === "a" ? side : side === "ct" ? "t" : "ct");
  }

  private applySide(m: Match, sideA: Side): void {
    m.sideA = sideA;
    m.deadline = null;
    m.phase = "starting";
    m.status = "Getting the server ready";
    this.save(m);
    void this.launch(m);
  }

  // ------------------------------------------------------------- the server

  private exec(s: ServerRecord, command: string, timeoutMs = 5000): Promise<string> {
    return this.d.rcon({ port: s.port, password: s.rconPassword, timeoutMs }, command);
  }

  /** Writes the lobby's config for the bridge to run after each map load (empty file when there is none). */
  private async modeConfigFile(s: ServerRecord, mode: Mode): Promise<void> {
    const file = path.join(await this.d.files.liveDir(s.slug), "game", "csgo", "cfg", MATCH_CFG);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o2775 });
    const { text } = cleanModeConfig(this.config().modes[mode].config);
    await writeAtomic(file, `// Written by CS2 Panel for ${MODE_INFO[mode].label} matches. Edit it on the Matchmaking page.\n${text}\n`, 0o664);
  }

  /** Rounds a team needs to win: from the lobby's config (mp_maxrounds) or the mode's default. */
  private winRounds(mode: Mode): number {
    return winRoundsFromConfig(this.config().modes[mode].config) ?? WIN_ROUNDS[mode];
  }

  private async matchFile(s: ServerRecord, content: unknown): Promise<void> {
    const file = path.join(await this.d.files.liveDir(s.slug), "game", "csgo", MATCH_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o2775 });
    await writeAtomic(file, JSON.stringify(content, null, 2) + "\n", 0o664);
  }

  /**
   * Bots fill every empty spot (at the start and when someone disconnects) unless both captains
   * said no. Never in 1v1.
   */
  private botActive(m: Match): boolean {
    return m.mode !== "duel" && (m.botVotes.a || m.botVotes.b);
  }

  /** What the bridge needs: who may join, on which team, the password and the bot. The bridge re-applies these after every map load. */
  private matchFileContent(m: Match) {
    const sideB: Side = m.sideA === "ct" ? "t" : "ct";
    return {
      version: 1,
      active: true,
      matchId: String(m.id),
      mode: m.mode,
      password: m.password,
      keepWeapons: this.config().modes[m.mode].keepWeapons,
      exec: cleanModeConfig(this.config().modes[m.mode].config).text ? MATCH_CFG : null,
      // One bot: the old single-bot form, which every bridge understands.
      bot:
        this.botActive(m) && botCount(m.teamA) + botCount(m.teamB) === 1
          ? { side: m.bot === "a" ? m.sideA : sideB, difficulty: this.config().botDifficulty }
          : null,
      // Bots per team (by team, so they follow the team across half time). Bridge 1.9.0 and later.
      // fill: the bridge (1.10.0+) keeps every empty spot filled, also for players who disconnect; size: spots per team.
      bots: this.botActive(m)
        ? { a: botCount(m.teamA), b: botCount(m.teamB), fill: true, size: MODE_INFO[m.mode].teamSize, difficulty: this.config().botDifficulty }
        : null,
      players: [
        ...humans(m.teamA).map((p) => ({ steamId: p.steamId, name: p.name, team: m.sideA, group: "a" })),
        ...humans(m.teamB).map((p) => ({ steamId: p.steamId, name: p.name, team: sideB, group: "b" })),
      ],
    };
  }

  private async launch(m: Match): Promise<void> {
    try {
      const s = this.d.servers.require(m.serverId);
      if (!this.d.hasBridge(s.id)) throw new Error(`${s.name} doesn't have the CS2 Panel Bridge plugin.`);
      if (!isActive(m)) return;
      m.released = false;
      await this.modeConfigFile(s, m.mode);
      await this.matchFile(s, this.matchFileContent(m));
      if (this.recleanIfEnded(m)) return;

      if ((await this.d.host.serviceStatus(s.slug)).state !== "active") {
        m.status = "Starting the server";
        await this.d.servers.control(s.id, "start", { id: null }, { reason: `Matchmaking match ${m.id}` });
      }
      m.status = "Waiting for the server to answer";
      await this.waitForBridge(s, m);
      if (this.recleanIfEnded(m)) return;

      m.status = "Loading the map";
      const before = await this.status(s).catch(() => null);
      // The bridge takes the player list, password and bot from match.json, now and after every map load.
      await this.exec(s, "cs2panel_match_reload");
      await this.exec(s, `sv_password "${m.password}"`);
      // A full map load in the lobby's mode; the bridge keeps warmup going until everyone is in.
      const info = MODE_INFO[m.mode];
      await this.exec(s, gameModeLine(info.gameType, info.gameMode, m.map!), 15_000).catch(() => undefined);
      if (this.recleanIfEnded(m)) return;
      // Only hand out the Join button once the server has loaded the map and runs this match.
      await this.waitForMatch(s, m, before?.mapLoads ?? null);
      if (!isActive(m)) return;

      m.phase = "live";
      m.readyAt = this.now();
      m.status = "Server ready. Join now; the match starts when everyone is in.";
      this.save(m);
      this.voiceLive(m);
    } catch (e) {
      if (this.recleanIfEnded(m)) return;
      await this.finish(m, "cancelled", `Couldn't start the match: ${(e as Error).message}`);
    }
  }

  private async waitForBridge(s: ServerRecord, m: Match): Promise<void> {
    const deadline = this.now() + 180_000;
    for (;;) {
      try {
        const out = await this.exec(s, "cs2panel_version", 3000);
        if (out.includes("cs2panel")) return;
      } catch {
        /* still starting */
      }
      if (!isActive(m)) return;
      if (this.now() > deadline) throw new Error(`${s.name} didn't answer within 3 minutes.`);
      await this.sleep(3000);
    }
  }

  private async status(s: ServerRecord) {
    return parseMatchStatus(await this.exec(s, "cs2panel_match_status", 3000));
  }

  /** Waits until the bridge reports this match, on a newly loaded map, in warmup (or later). */
  private async waitForMatch(s: ServerRecord, m: Match, mapLoadsBefore: number | null): Promise<void> {
    const deadline = this.now() + 120_000;
    for (;;) {
      const st = await this.status(s).catch(() => null);
      const loaded = mapLoadsBefore === null || st?.mapLoads === undefined || st.mapLoads > mapLoadsBefore;
      if (st && st.matchId === String(m.id) && loaded && (st.phase === "warmup" || st.phase === "live")) return;
      if (!isActive(m)) return;
      if (this.now() > deadline) throw new Error(`${s.name} didn't finish loading the match within 2 minutes. Is its CS2 Panel Bridge up to date?`);
      await this.sleep(2000);
    }
  }

  private async poll(m: Match): Promise<void> {
    m.polling = true;
    try {
      const s = this.d.servers.require(m.serverId);
      let st: { phase?: string; connected?: number; scoreA?: number; scoreB?: number; overSeconds?: number };
      try {
        st = parseMatchStatus(await this.exec(s, "cs2panel_match_status"));
        m.pollFailures = 0;
      } catch {
        m.pollFailures++;
        if (m.pollFailures >= 6) await this.finish(m, "abandoned", "The server stopped answering.");
        return;
      }
      const t = this.now();
      m.bridgePhase = st.phase ?? null;
      m.connected = st.connected ?? 0;
      if (typeof st.scoreA === "number" && typeof st.scoreB === "number" && st.phase !== "warmup") m.score = { a: st.scoreA, b: st.scoreB };
      if (m.connected > 0) m.lastConnectedAt = t;

      if (st.phase === "over") {
        m.phase = "over";
        // Time the kick from when the match really ended (the bridge says how long ago), not from this poll.
        m.overAt = t - Math.min(Math.max(st.overSeconds ?? 0, 0), 60) * 1000;
        m.status = "Match over";
        this.save(m);
        return;
      }
      if (st.phase === "live") m.status = "Match in progress";
      else if (st.phase === "warmup") m.status = `Warmup: ${m.connected} of ${expected(m)} players in`;
      const quietSince = Math.max(m.readyAt ?? t, m.lastConnectedAt ?? 0);
      if (m.connected === 0 && t - quietSince > IDLE_MATCH_MS) await this.finish(m, "abandoned", "Nobody was on the server for 10 minutes.");
    } finally {
      m.polling = false;
    }
  }

  /** Ends a match and gives the server back: no player list, no password. */
  private async finish(m: Match, phase: "over" | "cancelled" | "abandoned", note: string | null): Promise<void> {
    const wasActive = isActive(m);
    m.phase = phase;
    m.deadline = null;
    m.endedAt = this.now();
    if (note) {
      m.status = note;
      if (phase !== "over") m.error = note;
    } else if (phase === "over") m.status = "Match over";
    this.save(m, note);
    // Discord: back to the waiting room, temporary channels removed (in the background).
    if (wasActive || m.readyAt) void this.voice?.matchEnded(m.id).catch(() => undefined);
    if (!m.released) {
      const reason =
        phase === "over"
          ? "Match over, thanks for playing! Back to the site for the next match."
          : phase === "cancelled"
            ? "The match was cancelled. Back to the site for the next one."
            : "The match was ended. Back to the site for the next one.";
      // The match is done; the server is handed to the cleanup, and only used again once that has been checked.
      m.released = true;
      this.queueCleanup(m.serverId, reason);
      await this.runCleanup(m.serverId);
    }
    this.d.audit.record(null, `matchmaking.${phase === "over" ? "finished" : phase}`, m.serverId, {
      match: m.id,
      map: m.map,
      ...(m.score ? { score: `${m.score.a}-${m.score.b}` } : {}),
      ...(note ? { reason: note } : {}),
    });
  }

  // ------------------------------------------------------------- cleanup after a match

  /** The Discord bot, when there is one. Never awaited: Discord can't hold up or fail a match. */
  voice: {
    matchLive(m: VoiceMatchInfo): Promise<void>;
    matchEnded(matchId: number): Promise<void>;
    channelLinkFor(matchId: number, steamId: string, team: TeamKey, mode: Mode): string | null;
  } | null = null;

  private voiceLive(m: Match): void {
    if (!this.voice) return;
    const humans = (team: Member[]) => team.filter((p) => p.steamId !== BOT_ID).map((p) => p.steamId);
    void this.voice.matchLive({ id: m.id, mode: m.mode, serverId: m.serverId, teams: { a: humans(m.teamA), b: humans(m.teamB) } }).catch(() => undefined);
  }

  /** A match that's still going (not ended), for the Discord bot's tidy-up. */
  isMatchActive(matchId: number): boolean {
    return this.matches.some((m) => m.id === matchId && isActive(m));
  }

  /** Matchmaking is using the server: a match on it, its scoreboard time, or its cleanup afterwards. */
  inUse(serverId: number): boolean {
    return this.matches.some((m) => m.serverId === serverId && (isActive(m) || !m.released)) || this.cleanups.has(serverId);
  }

  /**
   * The voice channel for a player's team, by the match's lobby (not the server's game mode: 1v1 runs in
   * Wingman mode, and one server can serve several lobbies). 1v1: the server's own channel, else the shared one.
   */
  private discordChannel(m: Match, team: TeamKey, steamId?: string): string {
    // The bot's temporary channel for this match, when the player is linked (and so allowed in).
    const temp = steamId ? this.voice?.channelLinkFor(m.id, steamId, team, m.mode) : null;
    if (temp) return temp;
    const d = this.config().discord;
    const id = String(m.serverId);
    if (m.mode === "duel") return d.duelServers?.[id] || d.duel;
    const ch = d.channels[id];
    return ch ? (team === "a" ? ch.a : ch.b) : "";
  }

  /** Hands a server to the cleanup (or runs it again if it's already waiting). Saved, so a restart picks it up. */
  private queueCleanup(serverId: number, reason: string): void {
    const c = this.cleanups.get(serverId);
    if (c) {
      c.reason = reason;
      c.nextAt = 0;
      if (c.running) c.again = true;
    } else {
      this.cleanups.set(serverId, { serverId, reason, attempts: 0, lastError: null, nextAt: 0, running: false, again: false });
    }
    this.d.db
      .prepare(
        `INSERT INTO mm_cleanup (server_id, reason) VALUES (?, ?)
         ON CONFLICT(server_id) DO UPDATE SET reason = excluded.reason`,
      )
      .run(serverId, reason);
  }

  /**
   * A launch, late join or bot vote that was still talking to the server when its match ended may have put
   * match settings back on it: queue the cleanup again. Returns true when the match has ended.
   */
  private recleanIfEnded(m: Match): boolean {
    if (isActive(m)) return false;
    if (m.released) this.queueCleanup(m.serverId, "The match was ended. Back to the site for the next one.");
    return true;
  }

  /** Runs one cleanup attempt (never two at once for a server). True when the server is clean and free again. */
  private async runCleanup(serverId: number): Promise<boolean> {
    const c = this.cleanups.get(serverId);
    if (!c || c.running) return false;
    c.running = true;
    c.again = false;
    try {
      await this.cleanServer(serverId, c.reason);
      if (c.again) {
        c.nextAt = 0;
        return false;
      }
      this.cleanups.delete(serverId);
      this.d.db.prepare("DELETE FROM mm_cleanup WHERE server_id = ?").run(serverId);
      // The bridge has just confirmed nobody is on it: the panel's people count can lag behind for a bit.
      this.freedAt.set(serverId, this.now());
      if (c.attempts > 0) this.d.audit.record(null, "matchmaking.cleanup_done", serverId, { attempts: c.attempts + 1 });
      return true;
    } catch (e) {
      c.attempts++;
      c.lastError = (e as Error).message || String(e);
      c.nextAt = this.now() + cleanupDelay(c.attempts);
      this.d.db.prepare("UPDATE mm_cleanup SET attempts = ?, last_error = ? WHERE server_id = ?").run(c.attempts, c.lastError, serverId);
      console.warn(`matchmaking: cleaning up server ${serverId} failed (attempt ${c.attempts}): ${c.lastError}`);
      if (c.attempts === 1 || c.attempts % 10 === 0) {
        this.d.audit.record(null, "matchmaking.cleanup_failed", serverId, { attempts: c.attempts, error: c.lastError });
      }
      return false;
    } finally {
      c.running = false;
    }
  }

  /**
   * Empties a match server and checks it, so the next match gets a clean server. Throws when an essential
   * step fails or can't be confirmed; the cleanup is then retried. Safe to run again and again.
   *
   * Essential (checked): everyone kicked and gone; no match in match.json; the bridge has dropped the
   * match; the server's own password back. Best effort: removing bots and going back to the server's own
   * game mode and map (nobody is on it, and the next match loads its own mode and map anyway).
   */
  private async cleanServer(serverId: number, reason: string): Promise<void> {
    const s = this.d.servers.listRecords().find((x) => x.id === serverId);
    if (!s) return; // The server was deleted: nothing to clean.
    const running = (await this.d.host.serviceStatus(s.slug)).state === "active";

    if (running) {
      // 1. Everyone off, and confirmed gone (a kick that silently didn't happen shows up here).
      await this.exec(s, `cs2panel_kick_all "${reason.replace(/["\\;\r\n]/g, "")}"`);
      let st = await this.status(s);
      for (let i = 0; st.humans !== undefined && st.humans > 0 && i < 4; i++) {
        await this.sleep(1000);
        st = await this.status(s);
      }
      if (st.humans !== undefined && st.humans > 0) throw new Error(`${st.humans} ${st.humans === 1 ? "person is" : "people are"} still on it after the kick`);
    }

    // 2. No match for the bridge, also for a stopped server: it's what the bridge reads when it starts.
    await this.matchFile(s, INACTIVE_MATCH);
    if (!running) return; // The password and game mode come from the server's own settings when it starts.

    // 3. The bridge has dropped the match (no player list, team lock or match password any more).
    await this.exec(s, "cs2panel_match_reload");
    const after = await this.status(s);
    if (after.active) throw new Error("The CS2 Panel Bridge still has the match loaded");

    // 4. Its own password back, checked through the bridge where it can tell us.
    const own = (s.password ?? "").replace(/["\\;\r\n]/g, "");
    await this.exec(s, `sv_password "${own}"`);
    const pw = await this.status(s);
    if (pw.password !== undefined && pw.password !== own) throw new Error("The server's own password didn't come back");

    // 5. Best effort.
    await this.exec(s, "bot_quota 0; bot_kick; bot_join_team any").catch(() => undefined);
    try {
      await this.exec(s, gameModeLine(s.gameType, s.gameMode, s.map), 15_000).catch(() => undefined);
    } catch {
      // The server's own map isn't one we can load by command; it keeps the match's map until its next change.
    }
  }

  /** Admin: try a server's cleanup again now. */
  async retryCleanup(serverId: number, actorId: number): Promise<void> {
    if (!this.cleanups.has(serverId)) throw badRequest("That server isn't waiting to be cleaned up.");
    this.d.audit.record(actorId, "matchmaking.cleanup_retry", serverId, {});
    await this.runCleanup(serverId);
  }

  /** Admin: the server has been sorted out by hand (e.g. restarted); free it without the cleanup. */
  async releaseServer(serverId: number, actorId: number): Promise<void> {
    const c = this.cleanups.get(serverId);
    if (!c) throw badRequest("That server isn't waiting to be cleaned up.");
    if (c.running) throw badRequest("The cleanup is running right now. Try again in a moment.");
    const s = this.d.servers.listRecords().find((x) => x.id === serverId);
    // At least make sure the bridge won't load the old match again.
    if (s) await this.matchFile(s, INACTIVE_MATCH);
    this.cleanups.delete(serverId);
    this.d.db.prepare("DELETE FROM mm_cleanup WHERE server_id = ?").run(serverId);
    this.d.audit.record(actorId, "matchmaking.cleanup_skipped", serverId, { attempts: c.attempts, error: c.lastError });
  }

  private save(m: Match, note: string | null = null): void {
    this.d.db
      .prepare(
        `UPDATE mm_matches SET status = ?, map = ?, score_a = ?, score_b = ?, note = COALESCE(?, note),
           ended_at = CASE WHEN ? THEN datetime('now') ELSE ended_at END WHERE id = ?`,
      )
      .run(m.phase, m.map, m.score?.a ?? null, m.score?.b ?? null, note, m.endedAt !== null ? 1 : 0, m.id);
  }

  // ------------------------------------------------------------- match actions by players

  private requireMember(m: Match, by: string): void {
    if (![...m.teamA, ...m.teamB].some((p) => p.steamId === by)) throw forbidden("Only players in this match can do that.");
  }

  async cancelMatch(by: string | null, matchId: number, actorId: number | null = null): Promise<void> {
    const m = this.requireMatch(matchId);
    if (by !== null) this.requireMember(m, by);
    if (!isActive(m)) throw badRequest("That match has already ended.");
    const who = by ? this.displayName(this.player(by)) : "an admin";
    await this.finish(m, "cancelled", `Cancelled by ${who}`);
    if (actorId !== null) this.d.audit.record(actorId, "matchmaking.cancel", m.serverId, { match: m.id });
  }

  /** Ends warmup without waiting for everyone (someone didn't show up). */
  async startNow(by: string, matchId: number): Promise<void> {
    const m = this.requireMatch(matchId);
    this.requireMember(m, by);
    if (m.phase !== "live") throw badRequest("The server isn't ready yet.");
    if (m.bridgePhase === "live") throw badRequest("The match has already started.");
    const s = this.d.servers.require(m.serverId);
    await this.exec(s, "mp_warmup_end");
    await this.exec(s, `say Match started early by ${this.displayName(this.player(by)).replace(/[";\r\n]/g, "")}`).catch(() => undefined);
  }

  // ------------------------------------------------------------- joining a running match

  private lateJoinsOpen(m: Match): boolean {
    return m.lateJoinVotes.a || m.lateJoinVotes.b;
  }

  /**
   * Which team someone would join, or why they can't. Null when there's nothing
   * to show them (they're in the match, or it has ended).
   */
  private joinOption(m: Match, steamId: string): { team: TeamKey | null; reason: string | null } | null {
    if (!isActive(m) || [...m.teamA, ...m.teamB].some((p) => p.steamId === steamId)) return null;
    const no = (reason: string) => ({ team: null, reason });
    const size = MODE_INFO[m.mode].teamSize;
    const room = (["a", "b"] as const).filter((k) => humans(k === "a" ? m.teamA : m.teamB).length < size);
    if (room.length === 0) return no("Both teams are full.");
    // No lobby needed: joining from the front page puts the player in this match's lobby.
    if (this.activeMatchOf(steamId)) return no("You're in another match.");
    if (!this.lateJoinsOpen(m)) return no("The captains have closed this match to new players.");
    if (m.score && Math.max(m.score.a, m.score.b) >= this.winRounds(m.mode) - LATE_JOIN_CUTOFF) return no("Too late to join: the match is nearly over.");
    if (room.length === 1) return { team: room[0]!, reason: null };
    // The team with fewer players gets them first (in a bot's place, if bots fill in).
    const [ha, hb] = [humans(m.teamA).length, humans(m.teamB).length];
    if (ha !== hb) return { team: ha < hb ? "a" : "b", reason: null };
    // Even: the losing team, or on a tie (or before the first round) the team with the lower total rating.
    if (m.score && m.score.a !== m.score.b) return { team: m.score.a < m.score.b ? "a" : "b", reason: null };
    const total = (t: Member[]) => humans(t).reduce((sum, p) => sum + p.effective, 0);
    return { team: total(m.teamA) <= total(m.teamB) ? "a" : "b", reason: null };
  }

  async joinMatch(by: string, matchId: number): Promise<TeamKey> {
    this.requireEnabled();
    if (this.d.isBanned(by)) throw forbidden("You're banned from these servers.");
    const m = this.requireMatch(matchId);
    const option = this.joinOption(m, by);
    if (!option) throw badRequest(isActive(m) ? "You're already in this match." : "That match has already ended.");
    if (!option.team) throw badRequest(option.reason!);
    const teamKey = option.team;

    const joiner = await this.member(by);
    // No rating at all: count as the middle of the people already playing.
    if (joiner.rating.value === null) {
      const known = humans([...m.teamA, ...m.teamB])
        .map((p) => p.effective)
        .sort((x, y) => x - y);
      joiner.effective = known.length ? known[Math.floor(known.length / 2)]! : FALLBACK_RATING;
    }
    // Things may have changed while Leetify answered.
    const again = this.joinOption(m, by);
    if (!again?.team) throw badRequest(again?.reason ?? "You're already in this match.");
    // Into this match's lobby (from another lobby, or none), so they're handled like everyone else in the match.
    const entry = this.lobby.get(by);
    if (!entry || entry.mode !== m.mode) {
      if (entry) this.dropDraftsWith(by);
      const t = this.now();
      this.lobby.set(by, { steamId: by, mode: m.mode, ready: true, readySince: t, joinedAt: t, lastSeen: t, sitOuts: 0 });
    }

    const team = teamKey === "a" ? m.teamA : m.teamB;
    const replacesBot = botCount(team) > 0;
    if (replacesBot) {
      team.splice(
        team.findIndex((p) => p.steamId === BOT_ID),
        1,
      );
      m.bot = botTeamOf(m);
    }
    team.push(joiner);
    // Now one player short on the other team (e.g. 2v1 in Wingman): a bot fills in, as when teams are made.
    let addedBot: TeamKey | null = null;
    if (!replacesBot && !m.bot) {
      const [ha, hb] = [humans(m.teamA).length, humans(m.teamB).length];
      const short: TeamKey | null = ha === hb + 1 ? "b" : hb === ha + 1 ? "a" : null;
      if (short && humans(short === "a" ? m.teamA : m.teamB).length < MODE_INFO[m.mode].teamSize) {
        (short === "a" ? m.teamA : m.teamB).push(this.botMember());
        m.bot = short;
        m.botVotes = { a: true, b: true };
        addedBot = short;
      }
    }
    const e = this.lobby.get(by);
    if (e) e.sitOuts = 0;
    this.d.db
      .prepare("UPDATE mm_matches SET team_a = ?, team_b = ? WHERE id = ?")
      .run(
        JSON.stringify(m.teamA.map(({ steamId, name }) => ({ steamId, name }))),
        JSON.stringify(m.teamB.map(({ steamId, name }) => ({ steamId, name }))),
        m.id,
      );
    this.d.audit.record(null, "matchmaking.joined", m.serverId, {
      match: m.id,
      steamId: by,
      name: joiner.name,
      ...(replacesBot ? { replacedBot: true } : {}),
      ...(addedBot ? { addedBot: true } : {}),
    });

    // Already on the server: let them in, and take the bot off if they replace it.
    if (!m.released) {
      const s = this.d.servers.require(m.serverId);
      await this.matchFile(s, this.matchFileContent(m));
      await this.exec(s, "cs2panel_match_reload").catch(() => undefined);
      if (replacesBot) await this.exec(s, "bot_quota 0; bot_kick").catch(() => undefined);
      const captain = this.displayName(this.player(teamKey === "a" ? m.captainA : m.captainB));
      const extra = replacesBot ? " in place of the bot" : addedBot ? ", and a bot joins the other team" : "";
      const line = `${joiner.name} is joining ${captain}'s team${extra}`.replace(/[";\r\n]/g, "");
      await this.exec(s, `say ${line}`).catch(() => undefined);
      this.recleanIfEnded(m);
    }
    // A late joiner gets moved too (players already handled aren't touched again).
    this.voiceLive(m);
    return teamKey;
  }

  /** A captain's vote on the bot. Turning it off kicks the bot; on again brings it back. */
  async setBot(by: string, matchId: number, allow: boolean): Promise<void> {
    const m = this.requireMatch(matchId);
    if (!isActive(m)) throw badRequest("That match has already ended.");
    if (m.mode === "duel") throw badRequest("1v1 matches have no bots.");
    const team: TeamKey | null = m.captainA === by ? "a" : m.captainB === by ? "b" : null;
    if (!team) throw forbidden("Only the captains vote on this.");
    const before = this.botActive(m);
    m.botVotes[team] = allow;
    if (before === this.botActive(m) || m.released) return;
    const s = this.d.servers.require(m.serverId);
    await this.matchFile(s, this.matchFileContent(m));
    await this.exec(s, "cs2panel_match_reload").catch(() => undefined);
    this.recleanIfEnded(m);
  }

  setLateJoins(by: string, matchId: number, allow: boolean): void {
    const m = this.requireMatch(matchId);
    if (!isActive(m)) throw badRequest("That match has already ended.");
    const team: TeamKey | null = m.captainA === by ? "a" : m.captainB === by ? "b" : null;
    if (!team) throw forbidden("Only the captains vote on this.");
    m.lateJoinVotes[team] = allow;
  }

  // ------------------------------------------------------------- views

  private teamsView(teamA: Member[], teamB: Member[]): TeamsView {
    const sum = (t: Member[]) => t.reduce((s, p) => s + p.effective, 0);
    const sumA = sum(teamA);
    const sumB = sum(teamB);
    return {
      teamA,
      teamB,
      sumA,
      sumB,
      avgA: teamA.length ? Math.round(sumA / teamA.length) : 0,
      avgB: teamB.length ? Math.round(sumB / teamB.length) : 0,
      gap: Math.abs(sumA - sumB),
    };
  }

  private matchView(m: Match, viewer: string | null): MatchView {
    const s = this.d.servers.listRecords().find((x) => x.id === m.serverId);
    const member = viewer !== null && [...m.teamA, ...m.teamB].some((p) => p.steamId === viewer);
    const showBot = this.botActive(m);
    const shown = (t: Member[]) => (showBot ? t : humans(t));
    const myTeam: TeamKey | null = !member ? null : m.teamA.some((p) => p.steamId === viewer) ? "a" : "b";
    const channels = this.config().discord.channels[String(m.serverId)];
    // 1v1: one shared channel for everyone; other lobbies: the player's own team's channel on this server.
    const channel = !myTeam ? "" : this.discordChannel(m, myTeam, viewer ?? undefined);
    return {
      ...this.teamsView(shown(m.teamA), shown(m.teamB)),
      // Shown in every match but 1v1: bots can also fill in for players who disconnect.
      bots: m.mode !== "duel" ? { team: m.bot ?? "a", on: showBot, votes: { ...m.botVotes }, counts: { a: botCount(m.teamA), b: botCount(m.teamB) } } : null,
      discord: channel && isActive(m) ? { channel, invite: this.config().discord.invite || null } : null,
      id: m.id,
      mode: m.mode,
      modeLabel: MODE_INFO[m.mode].label,
      phase: m.phase,
      captainA: m.captainA,
      captainB: m.captainB,
      pool: m.pool,
      bans: m.bans,
      remaining: this.remaining(m),
      turn: m.phase === "veto" ? m.turn : null,
      deadline: m.deadline,
      map: m.map,
      sideA: m.sideA,
      sidePicker: m.sidePicker,
      serverName: s?.name ?? null,
      status: m.status,
      error: m.error,
      connected: m.connected,
      expected: expected(m),
      warmup: m.bridgePhase !== "live" && m.bridgePhase !== "over",
      score: m.score,
      createdAt: m.createdAt,
      endedAt: m.endedAt,
      join: member && m.phase === "live" && s ? { port: s.port, password: m.password } : null,
      lateJoins: { open: this.lateJoinsOpen(m), votes: { ...m.lateJoinVotes } },
      canJoin: viewer ? this.joinOption(m, viewer) : null,
    };
  }

  state(viewer: string | null): StateView {
    const c = this.config();
    let me: StateView["me"] = null;
    if (viewer) {
      const p = this.player(viewer);
      const e = this.lobby.get(viewer);
      me = {
        steamId: viewer,
        name: this.displayName(p),
        avatarUrl: p.avatarUrl,
        rating: this.ratingNow(p),
        selfRating: p.selfRating,
        inLobby: !!e,
        mode: e?.mode ?? null,
        ready: e?.ready ?? false,
        leetifyUrl: leetifyProfileUrl(viewer),
      };
    }
    const lobby: LobbyView[] = [...this.lobby.values()]
      .sort((x, y) => x.joinedAt - y.joinedAt)
      .map((e) => {
        const p = this.player(e.steamId);
        return {
          steamId: e.steamId,
          name: this.displayName(p),
          avatarUrl: p.avatarUrl,
          rating: this.ratingNow(p),
          leetifyUrl: leetifyProfileUrl(e.steamId),
          status: this.activeMatchOf(e.steamId) ? "in-match" : e.ready ? "ready" : "away",
          sitOuts: e.sitOuts,
          mode: e.mode,
          team: e.team ?? null,
        };
      });
    const drafts: DraftView[] = [...this.drafts.values()].map((d) => {
      const split = d.splits[d.index]!;
      return {
        ...this.teamsView(
          split.a.map((i) => d.players[i]!),
          split.b.map((i) => d.players[i]!),
        ),
        id: d.id,
        mode: d.mode,
        option: d.index + 1,
        options: d.splits.length,
      };
    });
    const lobbies = this.openModes(c).map((mode) => ({
      mode,
      label: MODE_INFO[mode].label,
      teamSize: MODE_INFO[mode].teamSize,
      fixed: MODE_INFO[mode].fixed,
      maps: c.modes[mode].maps,
      players: lobby.filter((p) => p.mode === mode).length,
      ready: lobby.filter((p) => p.mode === mode && p.status === "ready").length,
      freeServers: this.freeCountSync(mode),
      matchServers: this.poolRecords(mode).filter((s) => this.d.hasBridge(s.id)).length,
    }));
    return {
      title: c.title,
      enabled: c.enabled,
      me,
      lobbies,
      fixed: me?.mode && MODE_INFO[me.mode].fixed ? this.fixedView(me.mode) : null,
      lobby,
      drafts,
      // Ongoing matches for everyone (so people can join them); an ended match only for its own players.
      matches: this.matches
        .filter((m) => isActive(m) || (viewer !== null && [...m.teamA, ...m.teamB].some((p) => p.steamId === viewer)))
        .slice()
        .reverse()
        .map((m) => this.matchView(m, viewer)),
      look: { ...this.imageUrls(), layout: c.look.layout ?? "classic", language: c.look.language ?? "en" },
      mapNames: this.mapNames(),
      casual: {
        name: c.casual.name,
        // Each casual server's channel: its own, else the shared one.
        servers: c.casual.serverIds
          .map((id) => this.casualInfo.get(id))
          .filter((x): x is CasualView => !!x)
          .map((x) => {
            const ch = c.discord.casualServers?.[String(x.id)] || c.discord.casual;
            return { ...x, discord: ch ? { channel: ch, invite: c.discord.invite || null } : null };
          }),
        discord: c.discord.casual ? { channel: c.discord.casual, invite: c.discord.invite || null } : null,
      },
      freeServers: this.freeCountSync(),
      serverStates: this.serverStates().map(({ name, state, label }) => ({ name, state, label })),
      matchServers: this.poolRecords().filter((s) => this.d.hasBridge(s.id)).length,
      now: this.now(),
    };
  }

  /** Finished matches, newest first, for the panel. */
  history(limit = 30): {
    id: number;
    serverId: number | null;
    mode: string;
    map: string | null;
    teamA: { steamId: string; name: string }[];
    teamB: { steamId: string; name: string }[];
    scoreA: number | null;
    scoreB: number | null;
    status: string;
    note: string | null;
    createdAt: string;
    endedAt: string | null;
  }[] {
    const rows = this.d.db.prepare("SELECT * FROM mm_matches ORDER BY id DESC LIMIT ?").all(limit) as {
      id: number;
      server_id: number | null;
      mode: string;
      map: string | null;
      team_a: string;
      team_b: string;
      score_a: number | null;
      score_b: number | null;
      status: string;
      note: string | null;
      created_at: string;
      ended_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      serverId: r.server_id,
      mode: r.mode,
      map: r.map,
      teamA: JSON.parse(r.team_a),
      teamB: JSON.parse(r.team_b),
      scoreA: r.score_a,
      scoreB: r.score_b,
      status: r.status,
      note: r.note,
      createdAt: r.created_at,
      endedAt: r.ended_at,
    }));
  }
}

/** Parses the bridge's `cs2panel_match_status` reply. */
export function parseMatchStatus(output: string): {
  active?: boolean;
  matchId?: string;
  phase?: string;
  connected?: number;
  scoreA?: number;
  scoreB?: number;
  mapLoads?: number;
  map?: string;
  overSeconds?: number;
  /** Everyone on the server (bridge 1.8.0 and newer). */
  humans?: number;
  /** The server's current sv_password (bridge 1.8.0 and newer). */
  password?: string;
} {
  const line = output.split(/\r?\n/).find((l) => l.includes(MATCH_MARKER));
  if (!line) throw new Error("The bridge didn't answer. Is it up to date?");
  const v = JSON.parse(line.slice(line.indexOf(MATCH_MARKER) + MATCH_MARKER.length)) as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" ? x : undefined);
  const str = (x: unknown) => (typeof x === "string" ? x : undefined);
  return {
    active: typeof v.active === "boolean" ? v.active : undefined,
    matchId: str(v.matchId),
    phase: str(v.phase),
    connected: num(v.connected),
    scoreA: num(v.scoreA),
    scoreB: num(v.scoreB),
    mapLoads: num(v.mapLoads),
    map: str(v.map),
    overSeconds: num(v.overSeconds),
    humans: num(v.humans),
    password: str(v.password),
  };
}
