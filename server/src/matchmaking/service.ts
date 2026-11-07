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
import type { MmPlayer, MmPlayerStore } from "./players.js";

/** Where the bridge reads the current match, relative to game/csgo. */
export const MATCH_FILE = "addons/counterstrikesharp/configs/plugins/Cs2PanelBridge/match.json";

/** Premier's scale. */
export const MAX_RATING = 40_000;
/** Used for players nobody knows a rating for, when no one else in the match has one either. */
const FALLBACK_RATING = 10_000;
/** A lobby member whose page hasn't checked in for this long has closed it. */
const PRESENCE_MS = 90_000;
/** Teams nobody starts are dropped after this long. */
const DRAFT_MS = 5 * 60_000;
/** A ready server nobody is on is given back after this long. */
const IDLE_MATCH_MS = 10 * 60_000;
/** The scoreboard stays up this long after the match before the server is unlocked. */
const RELEASE_AFTER_MS = 20_000;
/** Finished matches stay on the page this long. */
const KEEP_ENDED_MS = 30 * 60_000;
const POLL_MS = 10_000;

export const DEFAULT_MAPS = ["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train"];

/** The lobbies players can pick. 1v1 runs in Wingman mode (short halves, small maps). */
export const MODES = ["competitive", "wingman", "duel"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_INFO: Record<Mode, { label: string; teamSize: number; gameType: number; gameMode: number }> = {
  competitive: { label: "Competitive", teamSize: 5, gameType: 0, gameMode: 1 },
  wingman: { label: "Wingman", teamSize: 2, gameType: 0, gameMode: 2 },
  duel: { label: "1v1", teamSize: 1, gameType: 0, gameMode: 2 },
};

/** Bot difficulty (bot_difficulty 0–3) and the rating it counts as when balancing. */
export const BOT_LEVELS = [
  { label: "Easy", rating: 3000 },
  { label: "Normal", rating: 6000 },
  { label: "Hard", rating: 9000 },
  { label: "Expert", rating: 12000 },
] as const;
export const BOT_ID = "BOT";

const MapList = z
  .array(z.string().trim().min(1).max(80))
  .max(20)
  .refine(
    (maps) => maps.every((m) => ["stock", "workshop"].includes(parseMapSpec(m)?.kind ?? "")),
    "Each map must be a map name like de_mirage or a Workshop map (workshop:ID). Collections can't be voted on.",
  );
const ModeSettings = z.object({ enabled: z.boolean(), maps: MapList });

export const MatchmakingSettingsSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
  title: z.string().trim().min(1).max(60),
  serverIds: z.array(z.number().int().positive()).max(20),
  modes: z
    .object({ competitive: ModeSettings, wingman: ModeSettings, duel: ModeSettings })
    .refine((m) => MODES.some((k) => m[k].enabled), "Open at least one lobby.")
    .refine((m) => MODES.every((k) => !m[k].enabled || m[k].maps.length > 0), "Every open lobby needs at least one map."),
  botDifficulty: z.number().int().min(0).max(3),
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
    competitive: { enabled: true, maps: DEFAULT_MAPS },
    wingman: { enabled: true, maps: ["de_inferno", "de_nuke", "de_overpass", "de_vertigo"] },
    duel: { enabled: true, maps: ["de_inferno", "de_nuke", "de_vertigo"] },
  },
  botDifficulty: 1,
  gameAddress: "",
  vetoSeconds: 30,
};

export type RatingSource = "admin" | "leetify" | "self" | "none" | "bot";
export interface RatingView {
  value: number | null;
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
}

interface LobbyEntry {
  steamId: string;
  mode: Mode;
  ready: boolean;
  readySince: number;
  joinedAt: number;
  lastSeen: number;
  sitOuts: number;
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
  lobbies: { mode: Mode; label: string; teamSize: number; maps: string[]; players: number; ready: number }[];
  lobby: LobbyView[];
  drafts: DraftView[];
  matches: MatchView[];
  freeServers: number;
  /** Servers set up for matches (in the pool, with the bridge), busy or not. */
  matchServers: number;
  now: number;
}

export interface MatchmakingDeps {
  db: Db;
  settings: Settings;
  box: SecretBox;
  players: MmPlayerStore;
  servers: ServerService;
  hasBridge: (serverId: number) => boolean;
  files: InstanceFiles;
  host: Host;
  rcon: RconExec;
  /** People on a server right now, if known. */
  humans: (serverId: number) => number | null;
  isBanned: (steamId: string) => boolean;
  audit: AuditLog;
  fetchFn: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Picks a random index below n (tests replace it). */
  random?: (n: number) => number;
}

const ACTIVE: MatchPhase[] = ["veto", "side", "starting", "live"];
const humans = (team: Member[]) => team.filter((p) => p.steamId !== BOT_ID);
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
    const modes = { ...DEFAULT_SETTINGS.modes, ...(stored.modes ?? {}) };
    // Before lobbies there was one map pool, for Competitive.
    if (!stored.modes && legacyMaps?.length) modes.competitive = { enabled: true, maps: legacyMaps };
    return { ...DEFAULT_SETTINGS, ...rest, modes };
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

  async saveConfig(raw: unknown, leetifyKey: string | null | undefined, actorId: number): Promise<MatchmakingSettings> {
    const next = MatchmakingSettingsSchema.parse(raw);
    const known = new Set(this.d.servers.listRecords().map((s) => s.id));
    next.serverIds = [...new Set(next.serverIds)].filter((id) => known.has(id));
    for (const m of MODES) next.modes[m].maps = [...new Set(next.modes[m].maps)];
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
    await this.onSettingsChanged();
    return next;
  }

  // ------------------------------------------------------------- lifecycle

  /** Matches the panel was running when it stopped can't be resumed; give their servers back. */
  async recover(): Promise<void> {
    const open = this.d.db.prepare(`SELECT id, server_id FROM mm_matches WHERE status IN ('veto','side','starting','live')`).all() as {
      id: number;
      server_id: number | null;
    }[];
    for (const row of open) {
      this.d.db.prepare("UPDATE mm_matches SET status = 'abandoned', note = 'The panel restarted', ended_at = datetime('now') WHERE id = ?").run(row.id);
      if (row.server_id) await this.unlockServer(row.server_id).catch(() => undefined);
    }
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

    if (t - this.lastPoll >= POLL_MS) {
      this.lastPoll = t;
      await Promise.all(this.matches.filter((m) => m.phase === "live" && !m.polling).map((m) => this.poll(m)));
    }

    this.matches = this.matches.filter((m) => isActive(m) || m.phase === "over" || (m.endedAt !== null && t - m.endedAt < KEEP_ENDED_MS));
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
    if (cached.premier !== null) return { value: cached.premier, source: "leetify", note: null };
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
    this.lobby.set(steamId, { steamId, mode, ready: true, readySince: t, joinedAt: t, lastSeen: t, sitOuts: 0 });
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

  private poolRecords(): ServerRecord[] {
    const ids = new Set(this.config().serverIds);
    return this.d.servers.listRecords().filter((s) => ids.has(s.id));
  }

  private reserved(serverId: number): boolean {
    return this.matches.some((m) => m.serverId === serverId && (isActive(m) || !m.released));
  }

  /** Servers in the pool that are free: not reserved, bridge installed, and nobody on them. Running ones first. */
  private async freeServers(): Promise<ServerRecord[]> {
    const free: { s: ServerRecord; running: boolean }[] = [];
    for (const s of this.poolRecords()) {
      if (this.reserved(s.id) || !this.d.hasBridge(s.id)) continue;
      const running = (await this.d.host.serviceStatus(s.slug)).state === "active";
      if (running && (this.d.humans(s.id) ?? 0) > 0) continue;
      free.push({ s, running });
    }
    return free.sort((x, y) => Number(y.running) - Number(x.running)).map((x) => x.s);
  }

  private freeCountSync(): number {
    return this.poolRecords().filter((s) => !this.reserved(s.id) && this.d.hasBridge(s.id) && (this.d.humans(s.id) ?? 0) === 0).length;
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
    if (this.drafts.has(mode)) return;
    const size = MODE_INFO[mode].teamSize;
    // An odd number of players plays with a bot on the short team, so nobody waits.
    const chosen = choosePlayers(this.available(mode), size * 2, size > 1);
    if (chosen.length < 2) throw badRequest("At least 2 ready players are needed to make teams.");
    if ((await this.freeServers()).length === 0) {
      if (!this.poolRecords().some((s) => this.d.hasBridge(s.id))) throw badRequest("No server is set up for matches yet. Ask the organiser.");
      throw badRequest("Every matchmaking server is busy. Wait for a match to finish.");
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
    const server = (await this.freeServers())[0];
    if (!server) throw badRequest("Every matchmaking server is busy. Wait for a match to finish.");
    if (this.drafts.get(d.mode) !== d) throw badRequest("Those teams aren't up any more.");
    this.drafts.delete(d.mode);

    const teamA = split.a.map((i) => d.players[i]!);
    const teamB = split.b.map((i) => d.players[i]!);
    // The best-rated person on each team is captain; never the bot.
    const captain = (team: Member[]) => team.filter((p) => p.steamId !== BOT_ID).sort((x, y) => y.effective - x.effective)[0]!.steamId;
    const t = this.now();
    const pool = c.modes[d.mode].maps.slice();
    const bot: TeamKey | null = teamA.some((p) => p.steamId === BOT_ID) ? "a" : teamB.some((p) => p.steamId === BOT_ID) ? "b" : null;

    const row = this.d.db
      .prepare("INSERT INTO mm_matches (server_id, mode, team_a, team_b, status) VALUES (?, ?, ?, ?, 'veto')")
      .run(
        server.id,
        d.mode,
        JSON.stringify(teamA.map(({ steamId, name }) => ({ steamId, name }))),
        JSON.stringify(teamB.map(({ steamId, name }) => ({ steamId, name }))),
      );

    const m: Match = {
      id: Number(row.lastInsertRowid),
      mode: d.mode,
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
    };
    this.matches.push(m);

    // Whoever was ready but didn't get a spot goes first next time.
    const picked = new Set(d.players.map((p) => p.steamId));
    for (const e of this.available(d.mode)) if (!picked.has(e.steamId)) e.sitOuts++;
    for (const id of picked) {
      const e = this.lobby.get(id);
      if (e) e.sitOuts = 0;
    }

    this.d.audit.record(null, "matchmaking.match", server.id, {
      reason: "Teams made on the matchmaking site",
      match: m.id,
      mode: MODE_INFO[d.mode].label,
      players: d.players.filter((p) => p.steamId !== BOT_ID).length,
      ...(bot ? { bot: true } : {}),
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

  private async matchFile(s: ServerRecord, content: unknown): Promise<void> {
    const file = path.join(await this.d.files.liveDir(s.slug), "game", "csgo", MATCH_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o2775 });
    await writeAtomic(file, JSON.stringify(content, null, 2) + "\n", 0o664);
  }

  private async launch(m: Match): Promise<void> {
    try {
      const s = this.d.servers.require(m.serverId);
      if (!this.d.hasBridge(s.id)) throw new Error(`${s.name} doesn't have the CS2 Panel Bridge plugin.`);
      const sideB: Side = m.sideA === "ct" ? "t" : "ct";
      m.released = false;
      await this.matchFile(s, {
        version: 1,
        active: true,
        matchId: String(m.id),
        mode: m.mode,
        players: [
          ...humans(m.teamA).map((p) => ({ steamId: p.steamId, name: p.name, team: m.sideA, group: "a" })),
          ...humans(m.teamB).map((p) => ({ steamId: p.steamId, name: p.name, team: sideB, group: "b" })),
        ],
      });

      if ((await this.d.host.serviceStatus(s.slug)).state !== "active") {
        m.status = "Starting the server";
        await this.d.servers.control(s.id, "start", { id: null }, { reason: `Matchmaking match ${m.id}` });
      }
      m.status = "Waiting for the server to answer";
      await this.waitForBridge(s, m);
      if (!isActive(m)) return;

      m.status = "Loading the map";
      await this.exec(s, `sv_password "${m.password}"`);
      await this.exec(s, "cs2panel_match_reload");
      // Bot settings stick across the map load. A bot joins the short team; otherwise none.
      if (m.bot) {
        const botSide = m.bot === "a" ? m.sideA : sideB;
        await this.exec(
          s,
          `bot_kick; bot_quota_mode normal; bot_difficulty ${this.config().botDifficulty}; bot_join_team ${botSide!.toUpperCase()}; bot_quota 1`,
        );
      } else {
        await this.exec(s, "bot_kick; bot_quota 0");
      }
      // A full map load in the lobby's mode; the bridge keeps warmup going until everyone is in.
      const info = MODE_INFO[m.mode];
      await this.exec(s, gameModeLine(info.gameType, info.gameMode, m.map!), 15_000).catch(() => undefined);
      if (!isActive(m)) return;

      m.phase = "live";
      m.readyAt = this.now();
      m.status = "Server ready. Join now; the match starts when everyone is in.";
      this.save(m);
    } catch (e) {
      if (!isActive(m)) return;
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

  private async poll(m: Match): Promise<void> {
    m.polling = true;
    try {
      const s = this.d.servers.require(m.serverId);
      let st: { phase?: string; connected?: number; scoreA?: number; scoreB?: number };
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
        m.overAt = t;
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
    m.phase = phase;
    m.deadline = null;
    m.endedAt = this.now();
    if (note) {
      m.status = note;
      if (phase !== "over") m.error = note;
    } else if (phase === "over") m.status = "Match over";
    this.save(m, note);
    if (!m.released) {
      m.released = true;
      await this.unlockServer(m.serverId).catch(() => undefined);
    }
    this.d.audit.record(null, `matchmaking.${phase === "over" ? "finished" : phase}`, m.serverId, {
      match: m.id,
      map: m.map,
      ...(m.score ? { score: `${m.score.a}-${m.score.b}` } : {}),
      ...(note ? { reason: note } : {}),
    });
  }

  private async unlockServer(serverId: number): Promise<void> {
    const s = this.d.servers.listRecords().find((x) => x.id === serverId);
    if (!s) return;
    await this.matchFile(s, { version: 1, active: false, players: [] });
    if ((await this.d.host.serviceStatus(s.slug)).state !== "active") return;
    await this.exec(s, "cs2panel_match_reload").catch(() => undefined);
    await this.exec(s, "bot_quota 0; bot_kick; bot_join_team any").catch(() => undefined);
    await this.exec(s, `sv_password "${(s.password ?? "").replace(/["\\;\r\n]/g, "")}"`).catch(() => undefined);
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
    return {
      ...this.teamsView(m.teamA, m.teamB),
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
      maps: c.modes[mode].maps,
      players: lobby.filter((p) => p.mode === mode).length,
      ready: lobby.filter((p) => p.mode === mode && p.status === "ready").length,
    }));
    return {
      title: c.title,
      enabled: c.enabled,
      me,
      lobbies,
      lobby,
      drafts,
      matches: this.matches
        .slice()
        .reverse()
        .map((m) => this.matchView(m, viewer)),
      freeServers: this.freeCountSync(),
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
export function parseMatchStatus(output: string): { active?: boolean; phase?: string; connected?: number; scoreA?: number; scoreB?: number } {
  const line = output.split(/\r?\n/).find((l) => l.includes(MATCH_MARKER));
  if (!line) throw new Error("The bridge didn't answer. Is it up to date?");
  const v = JSON.parse(line.slice(line.indexOf(MATCH_MARKER) + MATCH_MARKER.length)) as Record<string, unknown>;
  return {
    active: typeof v.active === "boolean" ? v.active : undefined,
    phase: typeof v.phase === "string" ? v.phase : undefined,
    connected: typeof v.connected === "number" ? v.connected : undefined,
    scoreA: typeof v.scoreA === "number" ? v.scoreA : undefined,
    scoreB: typeof v.scoreB === "number" ? v.scoreB : undefined,
  };
}
