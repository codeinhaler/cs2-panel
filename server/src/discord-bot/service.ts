// The Discord bot: moves players who opted in from a waiting room into their match's voice channel when the
// match goes live, and back afterwards; creates and removes temporary channels. Optional in every way: when
// it's off, broken or Discord is down, matchmaking carries on and players keep the "Join Discord channel" button.
import { z } from "zod";
import type { AuditLog } from "../audit.js";
import type { SecretBox } from "../crypto.js";
import type { Db } from "../db.js";
import { badRequest } from "../errors.js";
import type { Settings } from "../settings.js";
import { BOT_PERMISSIONS, DiscordError, DiscordRest, memberPermissions, parseChannelRef, PERM, snowflakeTime, type DiscordChannel } from "./rest.js";

const id = z.string().regex(/^$|^\d{15,22}$/, "That isn't a Discord ID.");
const ref = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === "" || parseChannelRef(v) !== null, "Paste a channel link (right-click → Copy Link) or its ID.");

export const BotSettingsSchema = z.object({
  enabled: z.boolean(),
  applicationId: id,
  /** Write-only: empty keeps the saved one. */
  token: z.string().trim().max(200).optional(),
  clientSecret: z.string().trim().max(200).optional(),
  clearToken: z.boolean().optional(),
  clearSecret: z.boolean().optional(),
  /** Empty: taken from the channel links. */
  guildId: id,
  waitingChannels: z.array(ref).max(10),
  category: ref,
  teamMode: z.enum(["configured", "temporary"]),
  duelMode: z.enum(["shared", "temporary"]),
  privateChannels: z.boolean(),
  returnAfter: z.boolean(),
  orphanCleanup: z.boolean(),
});

type Stored = Omit<z.infer<typeof BotSettingsSchema>, "token" | "clientSecret" | "clearToken" | "clearSecret"> & {
  tokenSealed: string | null;
  secretSealed: string | null;
};

const DEFAULTS: Stored = {
  enabled: false,
  applicationId: "",
  guildId: "",
  waitingChannels: [],
  category: "",
  teamMode: "configured",
  duelMode: "shared",
  privateChannels: true,
  returnAfter: true,
  orphanCleanup: true,
  tokenSealed: null,
  secretSealed: null,
};

/** A match as the bot needs it: who's on which team (humans only) and where it runs. */
export interface VoiceMatch {
  id: number;
  mode: "competitive" | "wingman" | "duel";
  serverId: number;
  teams: { a: string[]; b: string[] };
}

/** The channels matchmaking already has (per server, team, 1v1). */
export interface ConfiguredChannels {
  channels: Record<string, { a: string; b: string }>;
  duel: string;
  duelServers?: Record<string, string>;
}

export interface BotDeps {
  db: Db;
  settings: Settings;
  box: SecretBox;
  audit: AuditLog;
  fetchFn: typeof fetch;
  configured: () => ConfiguredChannels;
  isMatchActive: (matchId: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type BotState = "off" | "not-set-up" | "checking" | "ready" | "error";

export interface BotAction {
  at: number;
  matchId: number | null;
  ok: boolean;
  text: string;
}

const NAME_RE = /^(Match #\d+ · Team [12]|1v1 #\d+)$/;
const ORPHAN_AGE_MS = 10 * 60_000;

export class DiscordBot {
  readonly rest: DiscordRest;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private work: Promise<void> = Promise.resolve();
  private actions: BotAction[] = [];
  private status: { state: BotState; guildName: string | null; botUser: string | null; lastOk: number | null; lastError: string | null } = {
    state: "off",
    guildName: null,
    botUser: null,
    lastOk: null,
    lastError: null,
  };
  private botUserId: string | null = null;
  private retryTimers = new Set<NodeJS.Timeout>();

  constructor(private readonly d: BotDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rest = new DiscordRest(d.fetchFn, () => this.d.box.openOptional(this.stored().tokenSealed), this.sleep, this.now);
  }

  // ------------------------------------------------------------- settings

  private stored(): Stored {
    return { ...DEFAULTS, ...(this.d.settings.get<Partial<Stored> | null>("discordBot", null) ?? {}) };
  }

  /** The settings for the admin page: never the token or secret, only whether they're set. */
  view() {
    const { tokenSealed, secretSealed, ...rest } = this.stored();
    return { ...rest, hasToken: !!tokenSealed, hasSecret: !!secretSealed };
  }

  async save(raw: unknown, actorId: number) {
    const input = BotSettingsSchema.parse(raw);
    const cur = this.stored();
    const next: Stored = {
      enabled: input.enabled,
      applicationId: input.applicationId,
      guildId: input.guildId,
      waitingChannels: input.waitingChannels.filter(Boolean),
      category: input.category,
      teamMode: input.teamMode,
      duelMode: input.duelMode,
      privateChannels: input.privateChannels,
      returnAfter: input.returnAfter,
      orphanCleanup: input.orphanCleanup,
      tokenSealed: input.clearToken ? null : input.token ? this.d.box.seal(input.token) : cur.tokenSealed,
      secretSealed: input.clearSecret ? null : input.clientSecret ? this.d.box.seal(input.clientSecret) : cur.secretSealed,
    };
    if (next.enabled && !next.tokenSealed) throw badRequest("Paste the bot token before switching the bot on.");
    if ((next.teamMode === "temporary" || next.duelMode === "temporary") && !next.category) {
      throw badRequest("Temporary channels need a category to go in. Paste the category's link or ID.");
    }
    this.d.settings.set("discordBot", next);
    this.d.audit.record(actorId, "discord.bot", null, { enabled: next.enabled, teamMode: next.teamMode, duelMode: next.duelMode });
    this.botUserId = null;
    void this.healthCheck();
    return this.view();
  }

  /** The guild: set, or taken from the waiting rooms, the category or matchmaking's channel links. */
  guildId(): string | null {
    const s = this.stored();
    if (s.guildId) return s.guildId;
    const c = this.d.configured();
    const links = [...s.waitingChannels, s.category, c.duel, ...Object.values(c.duelServers ?? {}), ...Object.values(c.channels).flatMap((x) => [x.a, x.b])];
    for (const l of links) {
      const g = l ? parseChannelRef(l)?.guild : null;
      if (g) return g;
    }
    return null;
  }

  private waiting(): string[] {
    return this.stored()
      .waitingChannels.map((w) => parseChannelRef(w)?.channel)
      .filter((x): x is string => !!x);
  }

  /** On, with a token and a guild. */
  private ready(): string | null {
    const s = this.stored();
    if (!s.enabled || !s.tokenSealed) return null;
    return this.guildId();
  }

  /** Player sign-in with Discord is possible (an application ID and secret are set). */
  oauthReady(): boolean {
    const s = this.stored();
    return !!s.applicationId && !!s.secretSealed;
  }

  oauthClient(): { clientId: string; clientSecret: string } | null {
    const s = this.stored();
    const secret = this.d.box.openOptional(s.secretSealed);
    return s.applicationId && secret ? { clientId: s.applicationId, clientSecret: secret } : null;
  }

  inviteUrl(): string | null {
    const s = this.stored();
    if (!s.applicationId) return null;
    return `https://discord.com/oauth2/authorize?client_id=${s.applicationId}&scope=bot&permissions=${BOT_PERMISSIONS}`;
  }

  // ------------------------------------------------------------- status

  getStatus() {
    const s = this.stored();
    const state: BotState = !s.enabled
      ? "off"
      : !s.tokenSealed || !this.guildId()
        ? "not-set-up"
        : this.status.state === "off"
          ? "checking"
          : this.status.state;
    return { ...this.status, state };
  }

  private ok() {
    this.status.lastOk = this.now();
    if (this.status.state !== "ready") this.status.state = "ready";
  }

  private fail(e: unknown, matchId: number | null, what: string) {
    const msg = e instanceof Error ? e.message : String(e);
    this.status.lastError = `${what}: ${msg}`;
    if (e instanceof DiscordError && (e.status === 401 || e.status === 0)) this.status.state = "error";
    this.log(matchId, false, `${what}: ${msg}`);
  }

  private log(matchId: number | null, ok: boolean, text: string) {
    this.actions.unshift({ at: this.now(), matchId, ok, text });
    this.actions.length = Math.min(this.actions.length, 60);
    if (!ok) console.warn(`discord bot: ${text}`);
  }

  recentActions(): BotAction[] {
    return this.actions;
  }

  /** Checks the token and the guild (on save, at start and every few minutes). */
  async healthCheck(): Promise<void> {
    const g = this.ready();
    if (!g) return;
    this.status.state = "checking";
    try {
      const me = await this.rest.me();
      this.botUserId = me.id;
      this.status.botUser = me.username;
      const guild = await this.rest.guild(g);
      this.status.guildName = guild.name;
      this.ok();
      this.status.state = "ready";
    } catch (e) {
      this.status.state = "error";
      this.fail(e, null, "Connection check");
    }
  }

  private async botId(): Promise<string> {
    if (!this.botUserId) this.botUserId = (await this.rest.me()).id;
    return this.botUserId;
  }

  // ------------------------------------------------------------- events from matchmaking (never awaited there)

  /** Runs one piece of Discord work after the previous one; errors are logged, never thrown at matchmaking. */
  private queue(what: string, matchId: number | null, job: () => Promise<void>): Promise<void> {
    const run = async () => {
      try {
        await job();
      } catch (e) {
        this.fail(e, matchId, what);
      }
    };
    this.work = this.work.then(run, run);
    return this.work;
  }

  /** The match is live (teams final, Join shown): create or pick channels, move players who opted in. */
  matchLive(m: VoiceMatch): Promise<void> {
    if (!this.ready()) return Promise.resolve();
    return this.queue(`Match ${m.id}`, m.id, () => this.handleLive(m));
  }

  /** The match ended (over, cancelled or abandoned): move people back, remove temporary channels. */
  matchEnded(matchId: number): Promise<void> {
    if (!this.ready() && !this.hasState(matchId)) return Promise.resolve();
    return this.queue(`Match ${matchId} ended`, matchId, () => this.handleEnded(matchId));
  }

  private hasState(matchId: number): boolean {
    return !!this.d.db
      .prepare("SELECT 1 FROM discord_channels WHERE match_id = ? AND deleted_at IS NULL UNION SELECT 1 FROM discord_sessions WHERE match_id = ?")
      .get(matchId, matchId);
  }

  /** Where each team goes: a temporary channel (made once per match), or the configured one. */
  private async destinations(m: VoiceMatch, g: string, created: Set<string>): Promise<{ a: string | null; b: string | null }> {
    const s = this.stored();
    const c = this.d.configured();
    const sid = String(m.serverId);
    const configuredFor = (team: "a" | "b") => {
      const link = m.mode === "duel" ? c.duelServers?.[sid] || c.duel : team === "a" ? c.channels[sid]?.a : c.channels[sid]?.b;
      return link ? (parseChannelRef(link)?.channel ?? null) : null;
    };
    const temporary = m.mode === "duel" ? s.duelMode === "temporary" : s.teamMode === "temporary";
    if (!temporary) return { a: configuredFor("a"), b: configuredFor("b") };

    const make = async (team: "a" | "b" | "all", name: string, members: string[]): Promise<string | null> => {
      const existing = this.d.db.prepare("SELECT channel_id FROM discord_channels WHERE match_id = ? AND team = ? AND deleted_at IS NULL").get(m.id, team) as
        { channel_id: string } | undefined;
      if (existing) return existing.channel_id;
      // A team without people (only a CS2 bot) needs no voice channel.
      if ((team === "all" ? m.teams.a.length + m.teams.b.length : m.teams[team].length) === 0) return null;
      const parent = parseChannelRef(s.category)?.channel;
      const allow = (PERM.VIEW_CHANNEL | PERM.CONNECT).toString();
      const overwrites = s.privateChannels
        ? [
            { id: g, type: 0, deny: allow, allow: "0" },
            { id: await this.botId(), type: 1, allow: (PERM.VIEW_CHANNEL | PERM.CONNECT | PERM.MOVE_MEMBERS | PERM.MANAGE_CHANNELS).toString(), deny: "0" },
            ...members.map((u) => ({ id: u, type: 1, allow, deny: "0" })),
          ]
        : undefined;
      try {
        const ch = await this.rest.createVoice(
          g,
          { name, ...(parent ? { parent_id: parent } : {}), ...(overwrites ? { permission_overwrites: overwrites } : {}) },
          `CS2 Panel match ${m.id}`,
        );
        this.d.db.prepare("INSERT OR IGNORE INTO discord_channels (channel_id, match_id, team, name) VALUES (?, ?, ?, ?)").run(ch.id, m.id, team, name);
        created.add(ch.id);
        this.ok();
        this.log(m.id, true, `Created "${name}"`);
        return ch.id;
      } catch (e) {
        this.fail(e, m.id, `Creating "${name}" (using the configured channel instead)`);
        return null;
      }
    };
    const linked = (steamIds: string[]) => steamIds.map((sid2) => this.discordOf(sid2)).filter((x): x is string => !!x);
    if (m.mode === "duel") {
      const ch = (await make("all", `1v1 #${m.id}`, linked([...m.teams.a, ...m.teams.b]))) ?? configuredFor("a");
      return { a: ch, b: ch };
    }
    return {
      a: (await make("a", `Match #${m.id} · Team 1`, linked(m.teams.a))) ?? configuredFor("a"),
      b: (await make("b", `Match #${m.id} · Team 2`, linked(m.teams.b))) ?? configuredFor("b"),
    };
  }

  private discordOf(steamId: string): string | null {
    return (
      (this.d.db.prepare("SELECT discord_id FROM discord_links WHERE steam_id = ?").get(steamId) as { discord_id: string } | undefined)?.discord_id ?? null
    );
  }

  private async handleLive(m: VoiceMatch): Promise<void> {
    const g = this.ready();
    if (!g || !this.d.isMatchActive(m.id)) return;
    const created = new Set<string>();
    const dest = await this.destinations(m, g, created);
    const waiting = new Set(this.waiting());
    for (const team of ["a", "b"] as const) {
      const target = dest[team];
      for (const steamId of m.teams[team]) {
        const discordId = this.discordOf(steamId);
        if (!discordId) continue;
        // One decision per player per match: a repeated event never moves anyone twice.
        if (this.d.db.prepare("SELECT 1 FROM discord_moves WHERE match_id = ? AND discord_id = ?").get(m.id, discordId)) continue;
        const decide = (result: string) =>
          this.d.db.prepare("INSERT OR IGNORE INTO discord_moves (match_id, discord_id, result) VALUES (?, ?, ?)").run(m.id, discordId, result);
        const prefs = this.d.db.prepare("SELECT auto_move, username FROM discord_users WHERE discord_id = ?").get(discordId) as
          { auto_move: number; username: string } | undefined;
        if (!prefs?.auto_move) {
          decide("not-opted-in");
          continue;
        }
        if (!target) {
          decide("no-channel");
          this.log(m.id, false, `No voice channel for ${prefs.username}'s team`);
          continue;
        }
        // One person, one voice channel: another match already owns their voice session.
        const busy = this.d.db.prepare("SELECT match_id FROM discord_sessions WHERE discord_id = ? AND match_id != ?").get(discordId, m.id) as
          { match_id: number } | undefined;
        if (busy && this.d.isMatchActive(busy.match_id)) {
          decide("busy");
          this.log(m.id, true, `${prefs.username} stays put: match ${busy.match_id} already has their voice`);
          continue;
        }
        try {
          // A private temporary channel made before this player joined the match: let them in.
          const ours = this.d.db.prepare("SELECT 1 FROM discord_channels WHERE channel_id = ? AND deleted_at IS NULL").get(target);
          if (ours && !created.has(target) && this.stored().privateChannels) await this.rest.allowMember(target, discordId, `CS2 Panel match ${m.id}`);
          const vs = await this.rest.voiceState(g, discordId);
          if (!vs?.channel_id) {
            decide("not-in-voice");
            continue;
          }
          if (!waiting.has(vs.channel_id)) {
            decide("not-in-waiting-room");
            continue;
          }
          await this.rest.move(g, discordId, target, `CS2 Panel match ${m.id}`);
          this.d.db
            .prepare(
              `INSERT INTO discord_sessions (discord_id, match_id, steam_id, channel_id, origin_id) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(discord_id) DO UPDATE SET match_id = excluded.match_id, steam_id = excluded.steam_id, channel_id = excluded.channel_id,
                 origin_id = excluded.origin_id, moved_at = datetime('now')`,
            )
            .run(discordId, m.id, steamId, target, vs.channel_id);
          decide("moved");
          this.ok();
          this.log(m.id, true, `Moved ${prefs.username} to their match channel`);
        } catch (e) {
          decide("failed");
          this.fail(e, m.id, `Moving ${prefs.username}`);
        }
      }
    }
  }

  private async handleEnded(matchId: number): Promise<void> {
    const g = this.guildId();
    const s = this.stored();
    const sessions = this.d.db.prepare("SELECT discord_id, channel_id, origin_id FROM discord_sessions WHERE match_id = ?").all(matchId) as {
      discord_id: string;
      channel_id: string;
      origin_id: string | null;
    }[];
    const waiting = new Set(this.waiting());
    for (const ses of sessions) {
      try {
        const prefs = this.d.db.prepare("SELECT auto_return, username FROM discord_users WHERE discord_id = ?").get(ses.discord_id) as
          { auto_return: number; username: string } | undefined;
        const back = ses.origin_id && waiting.has(ses.origin_id) ? ses.origin_id : [...waiting][0];
        if (g && this.ready() && s.returnAfter && prefs?.auto_return && back) {
          // Only someone still in the match's channel: not someone who went somewhere else themselves.
          const vs = await this.rest.voiceState(g, ses.discord_id);
          if (vs?.channel_id === ses.channel_id) {
            await this.rest.move(g, ses.discord_id, back, `CS2 Panel match ${matchId} ended`);
            this.ok();
            this.log(matchId, true, `Moved ${prefs.username} back to the waiting room`);
          }
        }
      } catch (e) {
        this.fail(e, matchId, "Moving a player back");
      } finally {
        this.d.db.prepare("DELETE FROM discord_sessions WHERE discord_id = ? AND match_id = ?").run(ses.discord_id, matchId);
      }
    }
    this.d.db.prepare("UPDATE discord_channels SET ended_at = COALESCE(ended_at, datetime('now')) WHERE match_id = ?").run(matchId);
    await this.removeChannels(matchId);
  }

  /**
   * Deletes a finished match's temporary channels once nobody the panel knows is in them (only its own
   * channels, never configured ones). If someone is still talking, it tries again in a minute.
   */
  private async removeChannels(matchId: number, attempt = 0): Promise<void> {
    const g = this.guildId();
    if (!g) return;
    const rows = this.d.db.prepare("SELECT channel_id, name FROM discord_channels WHERE match_id = ? AND deleted_at IS NULL").all(matchId) as {
      channel_id: string;
      name: string;
    }[];
    if (!rows.length) return;
    // Who could be in them: the linked players of that match (private channels let nobody else in).
    const people = (this.d.db.prepare("SELECT discord_id FROM discord_moves WHERE match_id = ?").all(matchId) as { discord_id: string }[]).map(
      (r) => r.discord_id,
    );
    let busy = false;
    for (const r of rows) {
      let occupied = false;
      for (const p of people) {
        const vs = await this.rest.voiceState(g, p);
        if (vs?.channel_id === r.channel_id) occupied = true;
      }
      if (occupied && attempt < 30) {
        busy = true;
        continue;
      }
      await this.rest.deleteChannel(r.channel_id, `CS2 Panel match ${matchId} ended`);
      this.d.db.prepare("UPDATE discord_channels SET deleted_at = datetime('now') WHERE channel_id = ?").run(r.channel_id);
      this.ok();
      this.log(matchId, true, `Removed "${r.name}"`);
    }
    if (busy) {
      const t = setTimeout(() => {
        this.retryTimers.delete(t);
        void this.queue(`Removing match ${matchId}'s channels`, matchId, () => this.removeChannels(matchId, attempt + 1));
      }, 60_000);
      t.unref?.();
      this.retryTimers.add(t);
    }
  }

  /**
   * After a restart (and every few minutes): sessions and channels of matches that aren't running any more are
   * closed, and, if allowed, leftover panel channels in the category are removed.
   */
  reconcile(): Promise<void> {
    return this.queue("Tidying up", null, async () => {
      const ids = new Set<number>([
        ...(this.d.db.prepare("SELECT DISTINCT match_id FROM discord_sessions").all() as { match_id: number }[]).map((r) => r.match_id),
        ...(this.d.db.prepare("SELECT DISTINCT match_id FROM discord_channels WHERE deleted_at IS NULL").all() as { match_id: number }[]).map(
          (r) => r.match_id,
        ),
      ]);
      for (const mid of ids) if (!this.d.isMatchActive(mid)) await this.handleEnded(mid);
      const g = this.ready();
      const s = this.stored();
      const parent = parseChannelRef(s.category)?.channel;
      if (!g || !s.orphanCleanup || !parent) return;
      const known = new Set(
        (this.d.db.prepare("SELECT channel_id FROM discord_channels WHERE deleted_at IS NULL").all() as { channel_id: string }[]).map((r) => r.channel_id),
      );
      const all: DiscordChannel[] = await this.rest.channels(g);
      for (const ch of all) {
        if (ch.type !== 2 || ch.parent_id !== parent || known.has(ch.id) || !NAME_RE.test(ch.name)) continue;
        const mid = Number(/#(\d+)/.exec(ch.name)?.[1]);
        if (this.d.isMatchActive(mid) || this.now() - snowflakeTime(ch.id) < ORPHAN_AGE_MS) continue;
        await this.rest.deleteChannel(ch.id, "CS2 Panel: left over from an earlier match");
        this.log(mid, true, `Removed leftover "${ch.name}"`);
      }
    });
  }

  /** Waits for queued Discord work (tests, shutdown). */
  idle(): Promise<void> {
    return this.work;
  }

  stop(): void {
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
  }

  // ------------------------------------------------------------- what the site and panel show

  /** A player's own temporary channel for this match, when they're allowed into it. */
  channelLinkFor(matchId: number, steamId: string, team: "a" | "b", mode: VoiceMatch["mode"]): string | null {
    const g = this.guildId();
    const discordId = this.discordOf(steamId);
    if (!g || !discordId) return null;
    const row = this.d.db
      .prepare("SELECT channel_id FROM discord_channels WHERE match_id = ? AND team = ? AND deleted_at IS NULL")
      .get(matchId, mode === "duel" ? "all" : team) as { channel_id: string } | undefined;
    return row ? `https://discord.com/channels/${g}/${row.channel_id}` : null;
  }

  monitoring() {
    const sessions = this.d.db
      .prepare(
        `SELECT s.discord_id, u.username, s.match_id, s.steam_id, s.channel_id, s.moved_at FROM discord_sessions s
         LEFT JOIN discord_users u ON u.discord_id = s.discord_id ORDER BY s.moved_at DESC`,
      )
      .all();
    const channels = this.d.db
      .prepare("SELECT channel_id, match_id, team, name, created_at, ended_at FROM discord_channels WHERE deleted_at IS NULL ORDER BY created_at DESC")
      .all();
    const linked = (this.d.db.prepare("SELECT COUNT(*) AS n FROM discord_links").get() as { n: number }).n;
    const optedIn = (this.d.db.prepare("SELECT COUNT(*) AS n FROM discord_users WHERE auto_move = 1").get() as { n: number }).n;
    return { sessions, channels, linked, optedIn, actions: this.actions };
  }

  // ------------------------------------------------------------- admin checks

  /** What the bot can and can't do, in words. */
  async check(): Promise<{ ok: boolean; items: { ok: boolean; text: string }[] }> {
    const items: { ok: boolean; text: string }[] = [];
    const s = this.stored();
    const g = this.guildId();
    const add = (ok: boolean, text: string) => items.push({ ok, text });
    if (!s.tokenSealed) add(false, "No bot token saved.");
    if (!g) add(false, "No Discord server: paste a waiting room link, or set the server ID.");
    if (!s.tokenSealed || !g) return { ok: false, items };
    try {
      const me = await this.rest.me();
      this.botUserId = me.id;
      add(true, `Signed in as ${me.username}.`);
      const guild = await this.rest.guild(g);
      add(true, `Can see the server "${guild.name}".`);
      const [roles, member] = await Promise.all([this.rest.roles(g), this.rest.member(g, me.id)]);
      const perms = memberPermissions(g, roles, member.roles);
      const need: [bigint, string, boolean][] = [
        [PERM.VIEW_CHANNEL, "View Channels", true],
        [PERM.CONNECT, "Connect", true],
        [PERM.MOVE_MEMBERS, "Move Members", true],
        [PERM.MANAGE_CHANNELS, "Manage Channels (for temporary channels)", s.teamMode === "temporary" || s.duelMode === "temporary"],
      ];
      for (const [bit, name, required] of need) {
        if (perms & bit) add(true, `Has ${name}.`);
        else add(!required, required ? `Missing ${name}: give the bot's role this permission.` : `No ${name} (only needed for temporary channels).`);
      }
      if (perms & PERM.ADMINISTRATOR && perms === ~0n) add(true, "Note: the bot has Administrator. It doesn't need it; the four permissions above are enough.");
      const chans = await this.rest.channels(g);
      const byId = new Map(chans.map((c) => [c.id, c]));
      if (!s.waitingChannels.length) add(false, "No waiting room set: nobody can be moved automatically.");
      for (const w of this.waiting()) {
        const c = byId.get(w);
        add(!!c && (c.type === 2 || c.type === 13), c ? `Waiting room "${c.name}" found.` : `Waiting room ${w} not found on this server.`);
      }
      const cat = parseChannelRef(s.category)?.channel;
      if (cat) {
        const c = byId.get(cat);
        add(!!c && c.type === 4, c ? (c.type === 4 ? `Category "${c.name}" found.` : `"${c.name}" isn't a category.`) : `Category ${cat} not found.`);
      }
      this.ok();
    } catch (e) {
      add(false, e instanceof DiscordError && e.status === 401 ? "Discord didn't accept the token." : `Discord: ${(e as Error).message}`);
      this.fail(e, null, "Permission check");
    }
    return { ok: items.every((i) => i.ok), items };
  }

  /** Moves the admin (their own linked account) to a test channel and back. Only them, only when they ask. */
  async testMove(steamId: string): Promise<{ ok: boolean; items: { ok: boolean; text: string }[] }> {
    const items: { ok: boolean; text: string }[] = [];
    const g = this.ready();
    if (!g) return { ok: false, items: [{ ok: false, text: "Switch the bot on and save its token first." }] };
    const discordId = this.discordOf(steamId);
    if (!discordId) return { ok: false, items: [{ ok: false, text: "Your Steam account isn't linked to Discord. Link it on the matchmaking site first." }] };
    try {
      const vs = await this.rest.voiceState(g, discordId);
      if (!vs?.channel_id) return { ok: false, items: [{ ok: false, text: "Join any voice channel on the Discord server first." }] };
      const parent = parseChannelRef(this.stored().category)?.channel;
      const ch = await this.rest.createVoice(g, { name: "CS2 Panel test", ...(parent ? { parent_id: parent } : {}) }, "CS2 Panel voice test");
      items.push({ ok: true, text: `Created "CS2 Panel test".` });
      try {
        await this.rest.move(g, discordId, ch.id, "CS2 Panel voice test");
        items.push({ ok: true, text: "Moved you there." });
        await this.sleep(4000);
        await this.rest.move(g, discordId, vs.channel_id, "CS2 Panel voice test");
        items.push({ ok: true, text: "Moved you back." });
      } finally {
        await this.rest.deleteChannel(ch.id, "CS2 Panel voice test");
        items.push({ ok: true, text: "Removed the test channel." });
      }
      this.ok();
    } catch (e) {
      items.push({ ok: false, text: `Discord: ${(e as Error).message}` });
      this.fail(e, null, "Voice test");
    }
    return { ok: items.every((i) => i.ok), items };
  }

  // ------------------------------------------------------------- players' links and choices

  playerView(steamId: string) {
    const row = this.d.db
      .prepare(
        "SELECT u.discord_id, u.username, u.auto_move, u.auto_return FROM discord_links l JOIN discord_users u ON u.discord_id = l.discord_id WHERE l.steam_id = ?",
      )
      .get(steamId) as { discord_id: string; username: string; auto_move: number; auto_return: number } | undefined;
    return {
      available: this.oauthReady(),
      botOn: !!this.ready(),
      linked: row ? { username: row.username } : null,
      autoMove: !!row?.auto_move,
      autoReturn: row ? !!row.auto_return : true,
    };
  }

  /** Links a Steam account to a Discord user whose identity Discord just confirmed. */
  link(steamId: string, user: { id: string; username: string; global_name?: string | null }): void {
    const name = user.global_name || user.username;
    this.d.db
      .prepare(
        // New players are moved automatically unless they switch it off; a re-link keeps their choice.
        `INSERT INTO discord_users (discord_id, username, auto_move) VALUES (?, ?, 1)
         ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, updated_at = datetime('now')`,
      )
      .run(user.id, name);
    this.d.db
      .prepare(
        `INSERT INTO discord_links (steam_id, discord_id) VALUES (?, ?)
         ON CONFLICT(steam_id) DO UPDATE SET discord_id = excluded.discord_id, linked_at = datetime('now')`,
      )
      .run(steamId, user.id);
    this.d.audit.record(null, "discord.link", null, { steamId, discordUser: name });
  }

  unlink(steamId: string): void {
    this.d.db.prepare("DELETE FROM discord_links WHERE steam_id = ?").run(steamId);
    this.d.audit.record(null, "discord.unlink", null, { steamId });
  }

  /** The player's choices, shared by all Steam accounts linked to the same Discord user. */
  setPrefs(steamId: string, p: { autoMove: boolean; autoReturn: boolean }): void {
    const discordId = this.discordOf(steamId);
    if (!discordId) throw badRequest("Link your Discord account first.");
    this.d.db
      .prepare("UPDATE discord_users SET auto_move = ?, auto_return = ?, updated_at = datetime('now') WHERE discord_id = ?")
      .run(p.autoMove ? 1 : 0, p.autoReturn ? 1 : 0, discordId);
  }
}
