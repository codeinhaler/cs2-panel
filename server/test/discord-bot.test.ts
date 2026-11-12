import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { Settings } from "../src/settings.js";
import { SecretBox } from "../src/crypto.js";
import { AuditLog } from "../src/audit.js";
import { UserStore } from "../src/auth/users.js";
import { DiscordBot, type ConfiguredChannels, type VoiceMatch } from "../src/discord-bot/service.js";
import { BOT_PERMISSIONS, memberPermissions, parseChannelRef, PERM } from "../src/discord-bot/rest.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";

// ------------------------------------------------------------------ a fake Discord

const G = "100000000000000001";
const BOT = "200000000000000002";
const WAIT = "300000000000000001";
const LOUNGE = "300000000000000002";
const CATEGORY = "300000000000000003";
const T1 = "300000000000000011";
const T2 = "300000000000000012";
const DUEL = "300000000000000020";
const link = (c: string) => `https://discord.com/channels/${G}/${c}`;
const sf = (ms: number, n: number) => (((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n)).toString();

interface FakeChannel {
  id: string;
  type: number;
  name: string;
  parent_id: string | null;
  permission_overwrites?: { id: string; type: number; allow: string; deny: string }[];
}

class FakeDiscord {
  now = Date.parse("2026-11-11T12:00:00Z");
  channels = new Map<string, FakeChannel>();
  voice = new Map<string, string>();
  botPerms = BOT_PERMISSIONS;
  calls: string[] = [];
  failCreate = false;
  rateLimitNext = 0;
  /** OAuth: code → Discord user. */
  codes = new Map<string, { id: string; username: string }>();
  private n = 1;

  constructor() {
    for (const [id, type, name, parent] of [
      [WAIT, 2, "Waiting room", null],
      [LOUNGE, 2, "Lounge", null],
      [CATEGORY, 4, "CS2 matches", null],
      [T1, 2, "Team 1", null],
      [T2, 2, "Team 2", null],
      [DUEL, 2, "1v1", null],
    ] as const)
      this.channels.set(id, { id, type, name, parent_id: parent });
  }

  made = () => [...this.channels.values()].filter((c) => !/^3000000000000000/.test(c.id));
  moves = () => this.calls.filter((c) => c.startsWith("PATCH /guilds/"));

  fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const p = u.pathname.replace(/^\/api\/v10/, "");
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
    this.calls.push(`${method} ${p}`);
    const json = (status: number, b: unknown, headers: Record<string, string> = {}) =>
      new Response(status === 204 ? null : JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
    if (p === "/oauth2/token") {
      const f = new URLSearchParams(String(init?.body));
      const user = this.codes.get(f.get("code") ?? "");
      return user && f.get("client_secret") === "s3cret" ? json(200, { access_token: `at-${user.id}` }) : json(400, { error_description: "bad code" });
    }
    if (auth.startsWith("Bearer ")) {
      const id = auth.slice("Bearer at-".length);
      const user = [...this.codes.values()].find((x) => x.id === id);
      return user ? json(200, user) : json(401, { message: "401: Unauthorized" });
    }
    if (auth !== "Bot good-token") return json(401, { message: "401: Unauthorized", code: 0 });
    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      return json(429, { message: "You are being rate limited.", retry_after: 0.01 });
    }
    let m: RegExpExecArray | null;
    if (p === "/users/@me") return json(200, { id: BOT, username: "CS2 Bot" });
    if (p === `/guilds/${G}`) return json(200, { id: G, name: "Fredagsspiller", owner_id: "1" });
    if (p === `/guilds/${G}/roles`)
      return json(200, [
        { id: G, permissions: "0" },
        { id: "r1", permissions: this.botPerms.toString() },
      ]);
    if (p === `/guilds/${G}/members/${BOT}`) return json(200, { roles: ["r1"] });
    if (p === `/guilds/${G}/channels` && method === "GET") return json(200, [...this.channels.values()]);
    if (p === `/guilds/${G}/channels` && method === "POST") {
      if (this.failCreate) return json(403, { message: "Missing Permissions", code: 50013 });
      const id = sf(this.now, this.n++);
      const ch = { id, type: body.type, name: body.name, parent_id: body.parent_id ?? null, permission_overwrites: body.permission_overwrites };
      this.channels.set(id, ch);
      return json(201, ch);
    }
    if ((m = /^\/guilds\/\d+\/voice-states\/(\d+)$/.exec(p))) {
      const ch = this.voice.get(m[1]!);
      return ch ? json(200, { user_id: m[1], channel_id: ch }) : json(404, { message: "Unknown Voice State", code: 10065 });
    }
    if ((m = /^\/guilds\/\d+\/members\/(\d+)$/.exec(p)) && method === "PATCH") {
      if (!this.voice.has(m[1]!)) return json(400, { message: "Target user is not connected to voice.", code: 40032 });
      this.voice.set(m[1]!, body.channel_id);
      return json(200, {});
    }
    if ((m = /^\/channels\/(\d+)$/.exec(p)) && method === "DELETE") {
      if (!this.channels.delete(m[1]!)) return json(404, { message: "Unknown Channel", code: 10003 });
      for (const [user, ch] of this.voice) if (ch === m[1]) this.voice.delete(user);
      return json(200, {});
    }
    if ((m = /^\/channels\/(\d+)\/permissions\/(\d+)$/.exec(p)) && method === "PUT") {
      const ch = this.channels.get(m[1]!);
      if (ch)
        ch.permission_overwrites = [...(ch.permission_overwrites ?? []).filter((x) => x.id !== m![2]), { id: m[2]!, type: 1, allow: body.allow, deny: "0" }];
      return json(204, null);
    }
    return json(404, { message: `No route ${method} ${p}` });
  }) as typeof fetch;
}

// ------------------------------------------------------------------ the bot on its own

const STEAM = Array.from({ length: 6 }, (_, i) => `7656119800000010${i}`);
const DISC = Array.from({ length: 6 }, (_, i) => `40000000000000000${i}`);

let dir: string;
let db: Db;
let settings: Settings;
let box: SecretBox;
let discord: FakeDiscord;
let active: Set<number>;
let configured: ConfiguredChannels;

function makeBot() {
  return new DiscordBot({
    db,
    settings,
    box,
    audit: new AuditLog(db),
    fetchFn: discord.fetch,
    configured: () => configured,
    isMatchActive: (id) => active.has(id),
    now: () => discord.now,
    sleep: async () => undefined,
  });
}

const base = {
  enabled: true,
  applicationId: "500000000000000005",
  token: "good-token",
  clientSecret: "s3cret",
  guildId: "",
  waitingChannels: [link(WAIT)],
  category: link(CATEGORY),
  teamMode: "configured" as const,
  duelMode: "shared" as const,
  privateChannels: true,
  returnAfter: true,
  orphanCleanup: true,
};

/** Player i: linked, opted in (unless told otherwise), sitting in the waiting room. */
function player(bot: DiscordBot, i: number, o: { optIn?: boolean; voice?: string | null; discord?: string } = {}) {
  const d = o.discord ?? DISC[i]!;
  bot.link(STEAM[i]!, { id: d, username: `P${i}` });
  bot.setPrefs(STEAM[i]!, { autoMove: o.optIn ?? true, autoReturn: true });
  if (o.voice !== null) discord.voice.set(d, o.voice ?? WAIT);
}

const comp = (id: number, a: number[], b: number[], serverId = 1): VoiceMatch => ({
  id,
  mode: "competitive",
  serverId,
  teams: { a: a.map((i) => STEAM[i]!), b: b.map((i) => STEAM[i]!) },
});
const duel = (id: number, a: number, b: number, serverId = 3): VoiceMatch => ({ id, mode: "duel", serverId, teams: { a: [STEAM[a]!], b: [STEAM[b]!] } });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-discord-"));
  db = openDb(path.join(dir, "panel.db"));
  settings = new Settings(db);
  new UserStore(db).ensureOwner("76561198000000001"); // user 1, for the audit log
  box = new SecretBox("bb".repeat(32));
  discord = new FakeDiscord();
  active = new Set();
  configured = { channels: { "1": { a: link(T1), b: link(T2) } }, duel: link(DUEL), duelServers: {} };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Discord bot: moving players", () => {
  it("moves players who opted in from the waiting room into their team's configured channel, and no one else", async () => {
    const bot = makeBot();
    await bot.save(base, 1);
    player(bot, 0);
    player(bot, 1, { optIn: false });
    player(bot, 2);
    player(bot, 3, { voice: LOUNGE }); // in another conversation: left alone
    player(bot, 4, { voice: null }); // not in voice
    active.add(42);
    await bot.matchLive(comp(42, [0, 1, 4], [2, 3, 5])); // player 5 isn't linked at all
    expect(discord.voice.get(DISC[0]!)).toBe(T1);
    expect(discord.voice.get(DISC[2]!)).toBe(T2);
    expect(discord.voice.get(DISC[1]!)).toBe(WAIT);
    expect(discord.voice.get(DISC[3]!)).toBe(LOUNGE);
    expect(discord.moves()).toHaveLength(2);
    // The same event again (or out of order): nobody is moved twice, nothing new is made.
    discord.voice.set(DISC[0]!, WAIT); // player 0 went back by themselves: not pulled in again
    await bot.matchLive(comp(42, [0, 1, 4], [2, 3, 5]));
    expect(discord.moves()).toHaveLength(2);
    expect(discord.voice.get(DISC[0]!)).toBe(WAIT);
  });

  it("makes private temporary team channels, once per match, and lets a late joiner in", async () => {
    const bot = makeBot();
    await bot.save({ ...base, teamMode: "temporary" }, 1);
    for (const i of [0, 1, 2, 3]) player(bot, i);
    active.add(42);
    await bot.matchLive(comp(42, [0, 1], [2]));
    const made = discord.made();
    expect(made.map((c) => c.name).sort()).toEqual(["Match #42 · Team 1", "Match #42 · Team 2"]);
    const team1 = made.find((c) => c.name.endsWith("Team 1"))!;
    expect(team1.parent_id).toBe(CATEGORY);
    // Private: @everyone can't see or join; only the bot and Team 1's players can.
    const ow = team1.permission_overwrites!;
    expect(ow.find((o) => o.id === G)!.deny).toBe((PERM.VIEW_CHANNEL | PERM.CONNECT).toString());
    expect(
      ow
        .filter((o) => o.type === 1)
        .map((o) => o.id)
        .sort(),
    ).toEqual([BOT, DISC[0], DISC[1]].sort());
    expect(discord.voice.get(DISC[0]!)).toBe(team1.id);
    // A late joiner on Team 2: allowed into the existing channel and moved; no new channels.
    await bot.matchLive(comp(42, [0, 1], [2, 3]));
    expect(discord.made()).toHaveLength(2);
    const team2 = discord.made().find((c) => c.name.endsWith("Team 2"))!;
    expect(team2.permission_overwrites!.some((o) => o.id === DISC[3])).toBe(true);
    expect(discord.voice.get(DISC[3]!)).toBe(team2.id);
    // The site links linked players to their own temporary channel.
    expect(bot.channelLinkFor(42, STEAM[3]!, "b", "competitive")).toBe(link(team2.id));
    expect(bot.channelLinkFor(42, STEAM[5]!, "b", "competitive")).toBeNull();
  });

  it("1v1: one shared channel (or the server's own), or a temporary channel per match for simultaneous matches", async () => {
    const bot = makeBot();
    await bot.save(base, 1);
    for (const i of [0, 1, 2, 3, 4, 5]) player(bot, i);
    configured.duelServers = { "4": link(LOUNGE) };
    active.add(101).add(102);
    await bot.matchLive(duel(101, 0, 1, 3));
    await bot.matchLive(duel(102, 2, 3, 4));
    expect([discord.voice.get(DISC[0]!), discord.voice.get(DISC[1]!)]).toEqual([DUEL, DUEL]);
    expect([discord.voice.get(DISC[2]!), discord.voice.get(DISC[3]!)]).toEqual([LOUNGE, LOUNGE]);
    expect(discord.made()).toHaveLength(0);

    await bot.save({ ...base, duelMode: "temporary" }, 1);
    active.add(103).add(104);
    discord.voice.set(DISC[4]!, WAIT);
    discord.voice.set(DISC[5]!, WAIT);
    discord.voice.set(DISC[0]!, WAIT);
    discord.voice.set(DISC[1]!, WAIT);
    await bot.matchLive(duel(103, 4, 5, 3));
    await bot.matchLive(duel(104, 0, 1, 3)); // same CS2 server, its own channel
    const names = discord
      .made()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["1v1 #103", "1v1 #104"]);
    const c103 = discord.made().find((c) => c.name === "1v1 #103")!.id;
    expect([discord.voice.get(DISC[4]!), discord.voice.get(DISC[5]!)]).toEqual([c103, c103]);
  });

  it("with 'any voice channel' on: moves players from anywhere unless they switched it off, and back where they came from", async () => {
    const bot = makeBot();
    await bot.save({ ...base, anyChannel: true }, 1);
    player(bot, 0, { voice: LOUNGE });
    player(bot, 1, { voice: LOUNGE });
    player(bot, 2);
    bot.setPrefs(STEAM[1]!, { autoMove: true, autoReturn: true, moveAny: false }); // only from the waiting room
    expect(bot.playerView(STEAM[0]!)).toMatchObject({ anyChannel: true, moveAny: true });
    expect(bot.playerView(STEAM[1]!)).toMatchObject({ moveAny: false });
    active.add(42);
    await bot.matchLive(comp(42, [0, 1], [2]));
    expect(discord.voice.get(DISC[0]!)).toBe(T1);
    expect(discord.voice.get(DISC[1]!)).toBe(LOUNGE);
    expect(discord.voice.get(DISC[2]!)).toBe(T2);
    active.delete(42);
    await bot.matchEnded(42);
    expect(discord.voice.get(DISC[0]!)).toBe(LOUNGE); // the channel they came from
    expect(discord.voice.get(DISC[2]!)).toBe(WAIT);
  });

  it("after the match: moves back only those still in the match's channel, and removes only its own channels", async () => {
    const bot = makeBot();
    await bot.save({ ...base, teamMode: "temporary", waitingChannels: [link(WAIT), link(LOUNGE)] }, 1);
    for (const i of [0, 1, 2]) player(bot, i);
    discord.voice.set(DISC[2]!, LOUNGE);
    active.add(42);
    await bot.matchLive(comp(42, [0, 1], [2]));
    discord.voice.set(DISC[1]!, T1); // went somewhere else themselves
    active.delete(42);
    await bot.matchEnded(42);
    expect(discord.voice.get(DISC[0]!)).toBe(WAIT);
    expect(discord.voice.get(DISC[2]!)).toBe(LOUNGE); // back to the waiting room they came from
    expect(discord.voice.get(DISC[1]!)).toBe(T1);
    expect(discord.made()).toHaveLength(0);
    expect(discord.channels.has(T1) && discord.channels.has(WAIT)).toBe(true);
    expect(bot.monitoring()).toMatchObject({ sessions: [], channels: [] });
    // Ended twice: nothing more happens.
    const before = discord.calls.length;
    await bot.matchEnded(42);
    expect(discord.calls.length).toBe(before);
  });

  it("one Discord user on two Steam accounts in two matches: the first match keeps their voice", async () => {
    const bot = makeBot();
    await bot.save(base, 1);
    player(bot, 0);
    bot.link(STEAM[1]!, { id: DISC[0]!, username: "P0" }); // second Steam account, same Discord
    player(bot, 2);
    active.add(1).add(2);
    configured.channels["2"] = { a: link(LOUNGE), b: link(DUEL) };
    await bot.matchLive(comp(1, [0], [2], 1));
    await bot.matchLive(comp(2, [1], [], 2));
    expect(discord.voice.get(DISC[0]!)).toBe(T1);
    expect(bot.recentActions().some((a) => /stays put: match 1/.test(a.text))).toBe(true);
    // A new link is moved automatically by default; re-linking keeps the choice.
    bot.link(STEAM[3]!, { id: DISC[3]!, username: "P3" });
    expect(bot.playerView(STEAM[3]!)).toMatchObject({ autoMove: true });
    bot.setPrefs(STEAM[3]!, { autoMove: false, autoReturn: true });
    bot.link(STEAM[3]!, { id: DISC[3]!, username: "P3" });
    expect(bot.playerView(STEAM[3]!)).toMatchObject({ autoMove: false });
    // The same Discord user's choices are shared by both Steam accounts.
    expect(bot.playerView(STEAM[1]!)).toMatchObject({ linked: { username: "P0" }, autoMove: true });
  });

  it("never fails a match: a failed channel falls back to the configured one, and a bot that's off does nothing", async () => {
    const bot = makeBot();
    await bot.save({ ...base, teamMode: "temporary" }, 1);
    player(bot, 0);
    discord.failCreate = true;
    active.add(7);
    await expect(bot.matchLive(comp(7, [0], []))).resolves.toBeUndefined();
    expect(discord.voice.get(DISC[0]!)).toBe(T1);
    expect(bot.recentActions().some((a) => !a.ok && /Missing Permissions/.test(a.text))).toBe(true);

    await bot.save({ ...base, enabled: false }, 1);
    discord.calls = [];
    active.add(8);
    discord.voice.set(DISC[0]!, WAIT);
    await bot.matchLive(comp(8, [0], []));
    expect(discord.calls).toEqual([]);
    expect(bot.getStatus().state).toBe("off");
  });

  it("waits out Discord's rate limits instead of failing", async () => {
    const bot = makeBot();
    await bot.save(base, 1);
    player(bot, 0);
    discord.rateLimitNext = 2;
    active.add(9);
    await bot.matchLive(comp(9, [0], []));
    expect(discord.voice.get(DISC[0]!)).toBe(T1);
  });

  it("after a restart: closes ended matches and removes leftover panel channels, but nothing else", async () => {
    let bot = makeBot();
    await bot.save({ ...base, teamMode: "temporary" }, 1);
    player(bot, 0);
    active.add(42);
    await bot.matchLive(comp(42, [0], []));
    expect(discord.made()).toHaveLength(1);
    // Leftovers in the category: an old panel channel from a crash, a fresh one, a running match's, and someone else's.
    const add = (name: string, ageMs: number) => {
      const id = sf(discord.now - ageMs, 900 + discord.channels.size);
      discord.channels.set(id, { id, type: 2, name, parent_id: CATEGORY });
      return id;
    };
    const old = add("Match #7 · Team 1", 60 * 60_000);
    const fresh = add("1v1 #8", 60_000);
    const running = add("1v1 #9", 60 * 60_000);
    const theirs = add("Movie night", 60 * 60_000);
    active = new Set([9]); // the panel restarted: match 42 is gone, 9 still runs
    bot = makeBot();
    await bot.reconcile();
    expect(discord.voice.get(DISC[0]!)).toBe(WAIT);
    expect(discord.channels.has(old)).toBe(false);
    expect([fresh, running, theirs].every((c) => discord.channels.has(c))).toBe(true);
    expect(discord.made().filter((c) => c.name === "Match #42 · Team 1")).toHaveLength(0);
  });

  it("explains missing permissions and a bad token", async () => {
    const bot = makeBot();
    await bot.save({ ...base, teamMode: "temporary" }, 1);
    discord.botPerms = PERM.VIEW_CHANNEL | PERM.CONNECT;
    const r = await bot.check();
    expect(r.ok).toBe(false);
    expect(r.items.filter((i) => !i.ok).map((i) => i.text)).toEqual([
      "Missing Move Members: give the bot's role this permission.",
      "Missing Manage Channels (for temporary channels): give the bot's role this permission.",
    ]);
    discord.botPerms = BOT_PERMISSIONS;
    expect((await bot.check()).ok).toBe(true);
    await bot.save({ ...base, token: "bad" }, 1);
    expect((await bot.check()).items.at(-1)!.text).toBe("Discord didn't accept the token.");
    await bot.healthCheck();
    expect(bot.getStatus().state).toBe("error");
  });

  it("checks the setup: token needed to switch on, category for temporary channels; secrets never shown", async () => {
    const bot = makeBot();
    await expect(bot.save({ ...base, token: "" }, 1)).rejects.toThrow(/token/);
    await expect(bot.save({ ...base, teamMode: "temporary", category: "" }, 1)).rejects.toThrow(/category/);
    const v = await bot.save(base, 1);
    expect(JSON.stringify(v)).not.toMatch(/good-token|s3cret/);
    expect(v).toMatchObject({ hasToken: true, hasSecret: true });
    expect(bot.guildId()).toBe(G);
    expect(bot.inviteUrl()).toBe(`https://discord.com/oauth2/authorize?client_id=500000000000000005&scope=bot&permissions=${BOT_PERMISSIONS}`);
    // Saving without a token keeps the saved one.
    expect((await bot.save({ ...base, token: "" }, 1)).hasToken).toBe(true);
  });

  it("runs a voice test only for the admin who asks, and back again", async () => {
    const bot = makeBot();
    await bot.save(base, 1);
    expect((await bot.testMove(STEAM[0]!)).items[0]!.text).toMatch(/isn't linked/);
    player(bot, 0, { voice: LOUNGE });
    const r = await bot.testMove(STEAM[0]!);
    expect(r.ok).toBe(true);
    expect(discord.voice.get(DISC[0]!)).toBe(LOUNGE);
    expect(discord.made()).toHaveLength(0);
  });
});

describe("Discord helpers", () => {
  it("reads channel links and IDs, and works out the bot's permissions", () => {
    expect(parseChannelRef(link(WAIT))).toEqual({ guild: G, channel: WAIT });
    expect(parseChannelRef(WAIT)).toEqual({ guild: null, channel: WAIT });
    expect(parseChannelRef("general")).toBeNull();
    expect(
      memberPermissions(
        G,
        [
          { id: G, permissions: String(PERM.VIEW_CHANNEL) },
          { id: "r", permissions: String(PERM.CONNECT) },
        ],
        ["r"],
      ),
    ).toBe(PERM.VIEW_CHANNEL | PERM.CONNECT);
    expect(memberPermissions(G, [{ id: "r", permissions: String(PERM.ADMINISTRATOR) }], ["r"]) & PERM.MOVE_MEMBERS).toBeTruthy();
  });
});

// ------------------------------------------------------------------ linking on the matchmaking site

describe("Discord linking on the matchmaking site", () => {
  let app: App;
  let appDir: string;

  beforeEach(async () => {
    appDir = mkdtempSync(path.join(tmpdir(), "cs2panel-discord-app-"));
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      ownerSteamId: "76561198000000001",
      secretKey: "aa".repeat(32),
      dataDir: appDir,
      cs2Root: path.join(appDir, "cs2"),
      instanceEnvDir: path.join(appDir, "env"),
      cs2ctl: "/bin/false",
      webDir: path.join(appDir, "no-web"),
      bridgeDir: path.join(appDir, "no-bridge"),
      dev: true,
    };
    installFakeBase(config.cs2Root);
    app = await buildApp({
      config,
      db: openDb(path.join(appDir, "panel.db")),
      host: new FakeHost(config.cs2Root, config.instanceEnvDir),
      logLevel: "silent",
      pluginCheckDelayMs: 0,
      a2sQuery: async () => null,
      rcon: async () => "",
      fetchFn: discord.fetch,
    });
    await app.services.discordBot.save(base, 1);
  });

  afterEach(async () => {
    await app.fastify.close();
    rmSync(appDir, { recursive: true, force: true });
  });

  async function site() {
    return app.services.publicSite.instance();
  }
  async function playerCookie(steamId: string) {
    const res = await (await site()).inject({ method: "GET", url: `/api/auth/dev?steamId=${steamId}` });
    const c = res.cookies.find((x) => x.name === "cs2mm_session")!;
    return `${c.name}=${c.value}`;
  }
  async function get(cookie: string, url: string) {
    return (await site()).inject({ method: "GET", url, headers: { cookie, host: "play.example" } });
  }
  async function send(cookie: string, method: "POST" | "PUT", url: string, body: unknown) {
    return (await site()).inject({ method, url, payload: body as object, headers: { cookie, host: "play.example", origin: "http://play.example" } });
  }
  /** Starts linking and follows Discord back with a code for this Discord user. */
  async function linkAs(cookie: string, user: { id: string; username: string }, otherCookie?: string) {
    const start = await get(cookie, "/api/discord/link");
    const auth = new URL(start.headers.location as string);
    expect(auth.origin + auth.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(auth.searchParams.get("scope")).toBe("identify");
    expect(auth.searchParams.get("redirect_uri")).toBe("http://play.example/api/discord/callback");
    const code = `code-${user.id}-${Math.random()}`;
    discord.codes.set(code, user);
    return get(otherCookie ?? cookie, `/api/discord/callback?code=${code}&state=${auth.searchParams.get("state")}`);
  }

  it("links with a verified Discord identity, several Steam accounts to one Discord user, and unlinks", async () => {
    const a = await playerCookie(STEAM[0]!);
    const b = await playerCookie(STEAM[1]!);
    expect((await get(a, "/api/discord")).json()).toMatchObject({ available: true, botOn: true, linked: null, autoMove: false });
    expect((await linkAs(a, { id: DISC[0]!, username: "sune" })).headers.location).toBe("/?discord=linked");
    expect((await linkAs(b, { id: DISC[0]!, username: "sune" })).headers.location).toBe("/?discord=linked");
    expect((await get(b, "/api/discord")).json()).toMatchObject({ linked: { username: "sune" } });
    // Opting in on one account counts for the Discord user, so for both.
    expect((await send(a, "PUT", "/api/discord/prefs", { autoMove: true, autoReturn: false })).statusCode).toBe(200);
    expect((await get(b, "/api/discord")).json()).toMatchObject({ autoMove: true, autoReturn: false });
    // Unlinking one leaves the other.
    expect((await send(a, "POST", "/api/discord/unlink", {})).statusCode).toBe(200);
    expect((await get(a, "/api/discord")).json()).toMatchObject({ linked: null });
    expect((await get(b, "/api/discord")).json()).toMatchObject({ linked: { username: "sune" } });
    expect((await send(a, "PUT", "/api/discord/prefs", { autoMove: true, autoReturn: true })).statusCode).toBe(400);
  });

  it("refuses a sign-in that wasn't started by the same player, a reused state, and a bad code", async () => {
    const a = await playerCookie(STEAM[0]!);
    const b = await playerCookie(STEAM[1]!);
    const stolen = await linkAs(a, { id: DISC[2]!, username: "x" }, b);
    expect(decodeURIComponent(stolen.headers.location as string)).toMatch(/wasn't yours/);
    expect((await get(b, "/api/discord")).json()).toMatchObject({ linked: null });
    expect(decodeURIComponent((await get(a, "/api/discord/callback?code=c&state=made-up")).headers.location as string)).toMatch(/expired/);
    const start = await get(a, "/api/discord/link");
    const state = new URL(start.headers.location as string).searchParams.get("state");
    expect(decodeURIComponent((await get(a, `/api/discord/callback?code=nope&state=${state}`)).headers.location as string)).toMatch(/didn't accept/);
    // Signed out: no linking.
    expect(decodeURIComponent((await (await site()).inject({ method: "GET", url: "/api/discord/link" })).headers.location as string)).toMatch(/Sign in/);
  });
});
