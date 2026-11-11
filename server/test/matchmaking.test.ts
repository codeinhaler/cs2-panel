import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DUEL_CONFIG, OLD_DUEL_CONFIGS, cleanModeConfig, winRoundsFromConfig } from "../src/matchmaking/mode-config.js";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { choosePlayers, rankSplits } from "../src/matchmaking/balance.js";
import { parseProfile } from "../src/matchmaking/leetify.js";
import { hostOnly } from "../src/matchmaking/public-app.js";
import { imageType, inkOn, themeCss } from "../src/matchmaking/look.js";
import { cleanupDelay, parseMatchStatus } from "../src/matchmaking/service.js";

describe("team balancing", () => {
  it("tries every split once and puts the most even first", () => {
    const players = [30, 25, 20, 18, 15, 12, 10, 9, 8, 5].map((r, i) => ({ steamId: String(i), rating: r * 1000 }));
    const splits = rankSplits(players);
    expect(splits).toHaveLength(126);
    const best = splits[0]!;
    expect(best.a).toHaveLength(5);
    expect(best.b).toHaveLength(5);
    expect(best.gap).toBe(Math.min(...splits.map((s) => s.gap)));
    expect(best.gap).toBe(0); // 152k total splits evenly into 76k + 76k
    for (let i = 1; i < splits.length; i++) expect(splits[i]!.gap).toBeGreaterThanOrEqual(splits[i - 1]!.gap);
  });

  it("refuses odd or oversized groups", () => {
    expect(() => rankSplits([{ steamId: "a", rating: 1 }])).toThrow(/even/);
    expect(() => rankSplits(Array.from({ length: 12 }, (_, i) => ({ steamId: String(i), rating: i })))).toThrow(/10/);
  });

  it("gives priority to whoever sat out, then whoever waited longest", () => {
    const ready = [
      { id: "a", sitOuts: 0, readySince: 1 },
      { id: "b", sitOuts: 1, readySince: 5 },
      { id: "c", sitOuts: 0, readySince: 2 },
      { id: "d", sitOuts: 0, readySince: 3 },
      { id: "e", sitOuts: 0, readySince: 4 },
    ];
    expect(choosePlayers(ready, 4).map((p) => p.id)).toEqual(["b", "a", "c", "d"]);
    // An odd number of ready players leaves the last one out.
    expect(choosePlayers(ready.slice(0, 3)).map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("site look", () => {
  it("writes theme colours, with changes on top", () => {
    expect(themeCss({ theme: "default", colors: {} })).toBe("");
    const css = themeCss({ theme: "purple", colors: { accent: "#FF0000" } });
    expect(css).toMatch(/^html:root\{color-scheme:dark;/);
    expect(css).toContain("--accent:#ff0000;");
    expect(css).toContain("--paper:#160a2a;");
    expect(inkOn("#ffffff")).toBe("#111418");
    expect(inkOn("#22113d")).toBe("#ffffff");
  });

  it("knows images by their bytes", () => {
    expect(imageType(Buffer.from("89504e470d0a1a0a0000", "hex"))).toBe("png");
    expect(imageType(Buffer.from("ffd8ffe000104a46", "hex"))).toBe("jpg");
    expect(imageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe("webp");
    expect(imageType(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("parsers", () => {
  it("reads Premier from a Leetify profile", () => {
    expect(parseProfile({ ranks: { premier: 18854, competitive: [] }, privacy_mode: "public" })).toEqual({ premier: 18854, note: null });
    expect(parseProfile({ ranks: { premier: null, competitive: [] }, privacy_mode: "private" }).note).toMatch(/private/);
    expect(parseProfile({}).premier).toBeNull();
  });

  it("reads the bridge's match status", () => {
    const out = `junk\nCS2PANEL_MATCH {"active":true,"matchId":"3","phase":"live","connected":10,"expected":10,"scoreA":7,"scoreB":5}\n`;
    expect(parseMatchStatus(out)).toMatchObject({ active: true, matchId: "3", phase: "live", connected: 10, scoreA: 7, scoreB: 5 });
    expect(parseMatchStatus(`CS2PANEL_MATCH {"phase":"warmup","mapLoads":4,"map":"de_nuke"}`)).toMatchObject({ mapLoads: 4, map: "de_nuke" });
    expect(parseMatchStatus(`CS2PANEL_MATCH {"phase":"over","overSeconds":7.5}`)).toMatchObject({ phase: "over", overSeconds: 7.5 });
    expect(() => parseMatchStatus("Unknown command")).toThrow(/bridge/);
  });

  it("takes the host from a Host header", () => {
    expect(hostOnly("play.example:8090")).toBe("play.example");
    expect(hostOnly("10.0.0.5")).toBe("10.0.0.5");
    expect(hostOnly("[::1]:8090")).toBe("[::1]");
  });
});

// ------------------------------------------------------------- the whole flow

const OWNER = "76561198000000001";
const P = ["76561198000000101", "76561198000000102", "76561198000000103", "76561198000000104", "76561198000000105"];
/** Leetify's answers: P4 and P5 aren't on Leetify. */
const LEETIFY: Record<string, number> = { [P[0]!]: 20000, [P[1]!]: 15000, [P[2]!]: 10000 };

let dir: string;
let app: App;
let site: FastifyInstance;
let now: number;
let rconLog: string[];
let statusReply: string;
let leetifyCalls: number;
let mapLoads: number;
/** The fake server: people on it, its sv_password, and commands that fail (like an RCON timeout). */
let humansOn: number;
let serverPassword: string;
let failRcon: RegExp | null;
let kickWorks: boolean;
/** When set, a matching RCON command waits for the promise first (to make two things overlap). */
let rconGate: { match: RegExp; wait: Promise<void> } | null;
let passwordSticks: boolean;
let config: Config;
/** Kept across a restart: the game servers keep running when the panel restarts. */
let host: FakeHost;
let fetchFn: typeof fetch;

async function setup() {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-mm-"));
  config = {
    host: "127.0.0.1",
    port: 0,
    ownerSteamId: OWNER,
    secretKey: "11".repeat(32),
    dataDir: dir,
    cs2Root: path.join(dir, "cs2"),
    instanceEnvDir: path.join(dir, "env"),
    cs2ctl: "/bin/false",
    webDir: path.join(dir, "no-web"),
    bridgeDir: path.join(dir, "no-bridge"),
    dev: true,
  };
  installFakeBase(config.cs2Root);
  // A stand-in for the built player page.
  mkdirSync(path.join(config.webDir, "assets"), { recursive: true });
  writeFileSync(
    path.join(config.webDir, "play.html"),
    `<!doctype html><html><head><link rel="icon" href="data:image/svg+xml,<svg><rect/></svg>" /><title>Matchmaking</title></head><body><div id="root"></div></body></html>`,
  );
  now = 1_000_000;
  rconLog = [];
  leetifyCalls = 0;
  mapLoads = 0;
  humansOn = 0;
  serverPassword = "";
  failRcon = null;
  kickWorks = true;
  rconGate = null;
  passwordSticks = true;
  statusReply = `CS2PANEL_MATCH {"active":true,"phase":"warmup","connected":0,"scoreA":0,"scoreB":0}`;
  fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === "api-public.cs-prod.leetify.com") {
      leetifyCalls++;
      const id = u.searchParams.get("steam64_id")!;
      if (!(id in LEETIFY)) return new Response("{}", { status: 404 });
      return Response.json({ name: "x", privacy_mode: "public", ranks: { premier: LEETIFY[id], competitive: [] } });
    }
    if (u.hostname === "api.steampowered.com") {
      // Workshop 111 is "Aim Botz", 222 has been removed; anything else Steam doesn't know.
      if (u.pathname.includes("GetCollectionDetails")) return Response.json({ response: { collectiondetails: [{ result: 9 }] } });
      const id = new URLSearchParams(String(init?.body ?? "")).get("publishedfileids[0]");
      const d =
        id === "111"
          ? { result: 1, title: "Aim Botz", consumer_app_id: 730, visibility: 0, file_size: "1000" }
          : id === "222"
            ? { result: 1, title: "Old map", consumer_app_id: 730, visibility: 0, banned: 1 }
            : { result: 9 };
      return Response.json({ response: { publishedfiledetails: [d] } });
    }
    return new Response("<profile></profile>");
  }) as typeof fetch;
  host = new FakeHost(config.cs2Root, config.instanceEnvDir);
  await boot();
}

/** Builds the panel on this test's files and database; called again to act like a restart. */
async function boot() {
  app = await buildApp({
    config,
    db: openDb(path.join(dir, "panel.db")),
    host,
    fetchFn,
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    matchmakingClock: { now: () => now, sleep: async (ms) => void (now += ms), random: () => 0 },
    rcon: async (o, cmd) => {
      rconLog.push(cmd);
      if (rconGate?.match.test(cmd)) await rconGate.wait;
      if (failRcon?.test(cmd)) throw new Error("RCON timed out");
      if (cmd.startsWith("cs2panel_kick_all") && kickWorks) humansOn = 0;
      const pw = /^sv_password "(.*)"$/.exec(cmd);
      if (pw && passwordSticks) serverPassword = pw[1]!;
      if (cmd === "cs2panel_version") return "cs2panel bridge 1.1.0, 0 bans";
      if (/^game_type \d+; game_mode \d+; map /.test(cmd)) mapLoads++;
      if (cmd === "cs2panel_match_status") {
        // Like the bridge: the match it has loaded (from match.json) and how many maps it has loaded.
        const v = JSON.parse(statusReply.slice("CS2PANEL_MATCH ".length));
        // Each server has its own match.json (under its slug); fall back to the first for single-server tests.
        const rec = app?.services.servers.listRecords().find((r) => r.port === o.port);
        const files = findFile(dir, "match.json");
        const file = (rec && files.find((f) => f.includes(`/${rec.slug}/`))) ?? files[0];
        const loaded = file ? JSON.parse(readFileSync(file, "utf8")) : null;
        // The bridge has whatever match.json held at its last reload; tests that don't care get the file's state.
        v.active = !!loaded?.active;
        if (v.matchId === undefined) v.matchId = loaded?.active ? loaded.matchId : "";
        v.humans = humansOn;
        v.password = serverPassword;
        if (v.mapLoads === undefined) v.mapLoads = mapLoads;
        return `CS2PANEL_MATCH ${JSON.stringify(v)}`;
      }
      return `ok ${cmd}`;
    },
  });
  site = await app.services.publicSite.instance();
}

async function adminCookie(): Promise<string> {
  const res = await app.fastify.inject({ method: "GET", url: `/api/auth/dev?steamId=${OWNER}` });
  return `cs2p_session=${res.cookies.find((c) => c.name === "cs2p_session")!.value}`;
}

async function admin(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.fastify.inject({
    method: method as "GET",
    url,
    headers: { cookie, host: "panel.lan" },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

async function playerCookie(steamId: string, name: string): Promise<string> {
  const res = await site.inject({ method: "GET", url: `/api/auth/dev?steamId=${steamId}&name=${name}` });
  expect(res.statusCode).toBe(302);
  return `cs2mm_session=${res.cookies.find((c) => c.name === "cs2mm_session")!.value}`;
}

async function play(cookie: string | null, method: string, url: string, body?: unknown) {
  const res = await site.inject({
    method: method as "GET",
    url,
    headers: { ...(cookie ? { cookie } : {}), host: "play.example:8090" },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

/** Lets background work (the server launch, file writes) run. */
async function settle(until?: () => Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!until || (await until())) return;
  }
}

function findFile(root: string, name: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const p = path.join(root, entry);
    if (statSync(p).isDirectory()) out.push(...findFile(p, name));
    else if (entry === name) out.push(p);
  }
  return out;
}

async function setupServer(cookie: string, opts: { bridge?: boolean; name?: string; port?: number } = {}): Promise<number> {
  const presets = (await admin(cookie, "GET", "/api/presets")).body.presets as { id: number; key: string }[];
  const pid = presets.find((p) => p.key === "competitive")!.id;
  const res = await admin(cookie, "POST", "/api/servers", { name: opts.name ?? "Match #1", presetId: pid, port: opts.port ?? 27015 });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = res.body.server.id as number;
  if (opts.bridge !== false) {
    // Pretend the bridge is installed, as it would be with CounterStrikeSharp.
    (app.services.servers as any).store.db
      .prepare("INSERT INTO plugin_installs (server_id, plugin_id, name, version, asset) VALUES (?, 'cs2panel-bridge', 'CS2 Panel Bridge', 'dev', 'x')")
      .run(id);
  }
  return id;
}

async function enable(cookie: string, serverIds: number[], extra: Record<string, unknown> = {}) {
  const current = (await admin(cookie, "GET", "/api/matchmaking")).body.settings;
  const res = await admin(cookie, "PUT", "/api/matchmaking", {
    settings: {
      ...current,
      enabled: true,
      serverIds,
      modes: {
        competitive: { enabled: true, maps: ["de_mirage", "de_inferno", "de_nuke"] },
        wingman: { enabled: true, maps: ["de_vertigo", "de_nuke"] },
        duel: { enabled: true, maps: ["de_vertigo"] },
      },
      ...extra,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe("matchmaking site", () => {
  beforeEach(setup);
  afterEach(async () => {
    await site.close();
    await app.fastify.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is off until an admin switches it on", async () => {
    const c = await playerCookie(P[0]!, "Alpha");
    expect((await play(c, "POST", "/api/lobby/join")).body.error).toMatch(/switched off/);
    const state = (await play(null, "GET", "/api/state")).body;
    expect(state.enabled).toBe(false);
    expect(state.me).toBeNull();
    // The panel's own routes don't exist on the public site.
    expect((await play(c, "GET", "/api/servers")).status).toBe(404);
    expect((await site.inject({ method: "GET", url: "/api/auth/steam", headers: { host: "play.example:8090" } })).headers.location).toContain(
      encodeURIComponent("http://play.example:8090/api/auth/steam/callback"),
    );
  });

  it("checks the settings", async () => {
    const owner = await adminCookie();
    const base = { enabled: true, port: 8090, title: "x", serverIds: [], gameAddress: "", vetoSeconds: 30, botDifficulty: 1 };
    const closed = { enabled: false, maps: [] };
    const res = await admin(owner, "PUT", "/api/matchmaking", {
      settings: { ...base, modes: { competitive: { enabled: true, maps: [] }, wingman: closed, duel: closed } },
    });
    expect(res.body.error).toMatch(/needs at least one map/);
    const none = await admin(owner, "PUT", "/api/matchmaking", { settings: { ...base, modes: { competitive: closed, wingman: closed, duel: closed } } });
    expect(none.body.error).toMatch(/at least one lobby/);
    const bad = await admin(owner, "PUT", "/api/matchmaking", {
      settings: { ...base, modes: { competitive: { enabled: true, maps: ["not a map!"] }, wingman: closed, duel: closed } },
    });
    expect(bad.status).toBe(400);
    // Settings saved before lobbies existed keep their map pool for Competitive.
    (app.services.servers as any).store.db.prepare("INSERT INTO settings (key, value) VALUES ('matchmaking', ?)").run(JSON.stringify({ maps: ["de_cache"] }));
    expect(app.services.matchmaking.config().modes.competitive.maps).toEqual(["de_cache"]);
  });

  it("has separate lobbies, and a bot fills in for an odd number of players", async () => {
    const owner = await adminCookie();
    const serverId = await setupServer(owner);
    await enable(owner, [serverId], { botDifficulty: 2 });
    const cookies = await Promise.all(P.slice(0, 4).map((id, i) => playerCookie(id, ["Alpha", "Bravo", "Charlie", "Delta"][i]!)));
    // Three in Wingman, one in 1v1.
    for (const c of cookies.slice(0, 3)) await play(c, "POST", "/api/lobby/join", { mode: "wingman" });
    await play(cookies[3]!, "POST", "/api/lobby/join", { mode: "duel" });
    let state = (await play(cookies[0]!, "GET", "/api/state")).body;
    expect(state.me.mode).toBe("wingman");
    expect(state.lobbies.map((l: any) => [l.mode, l.players])).toEqual([
      ["competitive", 0],
      ["wingman", 3],
      ["duel", 1],
    ]);

    // Alone in 1v1: nobody to play.
    expect((await play(cookies[3]!, "POST", "/api/teams")).body.error).toMatch(/At least 2/);

    // Three in Wingman: 2v2 with a bot, captains are people.
    expect((await play(cookies[0]!, "POST", "/api/teams")).status).toBe(200);
    state = (await play(cookies[0]!, "GET", "/api/state")).body;
    expect(state.drafts).toHaveLength(1);
    const d = state.drafts[0];
    expect(d.mode).toBe("wingman");
    expect(d.teamA).toHaveLength(2);
    expect(d.teamB).toHaveLength(2);
    const bot = [...d.teamA, ...d.teamB].find((p: any) => p.steamId === "BOT");
    expect(bot).toMatchObject({ name: "Bot (Hard)", rating: { value: 9000, source: "bot" } });

    const { matchId } = (await play(cookies[0]!, "POST", `/api/teams/${d.id}/start`)).body;
    state = (await play(cookies[0]!, "GET", "/api/state")).body;
    const m = state.matches[0];
    expect(m).toMatchObject({ mode: "wingman", modeLabel: "Wingman", pool: ["de_vertigo", "de_nuke"], expected: 3 });
    expect([m.captainA, m.captainB]).not.toContain("BOT");

    // Ban, pick a side, and the server loads Wingman with the bot on the short team.
    const captainCookie = (id: string) => cookies[P.indexOf(id)]!;
    const turnCaptain = m.turn === "a" ? m.captainA : m.captainB;
    await play(captainCookie(turnCaptain), "POST", `/api/matches/${matchId}/ban`, { map: "de_nuke" });
    state = (await play(cookies[0]!, "GET", "/api/state")).body;
    const picker = state.matches[0].sidePicker === "a" ? state.matches[0].captainA : state.matches[0].captainB;
    await play(captainCookie(picker), "POST", `/api/matches/${matchId}/side`, { side: "ct" });
    await settle(async () => (await play(cookies[0]!, "GET", "/api/state")).body.matches[0].phase !== "starting");
    state = (await play(cookies[0]!, "GET", "/api/state")).body;
    expect(state.matches[0].phase).toBe("live");
    expect(rconLog).toContain("game_type 0; game_mode 2; map de_vertigo");
    const botTeam = state.matches[0].teamA.some((p: any) => p.steamId === "BOT") ? "a" : "b";
    const botSide = botTeam === "a" ? state.matches[0].sideA : state.matches[0].sideA === "ct" ? "t" : "ct";
    // The bridge gets the bot and password from match.json and puts them back after every map load.
    // The bot isn't in the bridge's player list.
    const [matchFile] = findFile(dir, "match.json");
    const file = JSON.parse(readFileSync(matchFile!, "utf8"));
    expect(file.players).toHaveLength(3);
    expect(file.mode).toBe("wingman");
    expect(file.bot).toEqual({ side: botSide, difficulty: 2 });
    expect(file.password).toBe(state.matches[0].joinInfo.password);

    // Can't switch lobby during a match; afterwards the bot is removed again.
    expect((await play(cookies[0]!, "POST", "/api/lobby/join", { mode: "duel" })).body.error).toMatch(/Finish your match/);
    await play(cookies[0]!, "POST", `/api/matches/${matchId}/cancel`);
    expect(rconLog).toContain("bot_quota 0; bot_kick; bot_join_team any");
    expect((await play(cookies[0]!, "POST", "/api/lobby/join", { mode: "duel" })).status).toBe(200);
  });

  it("plays 1v1 in pairs", async () => {
    const owner = await adminCookie();
    await enable(owner, [await setupServer(owner)]);
    const cookies = await Promise.all(P.slice(0, 3).map((id, i) => playerCookie(id, ["Alpha", "Bravo", "Charlie"][i]!)));
    for (const c of cookies) await play(c, "POST", "/api/lobby/join", { mode: "duel" });
    await play(cookies[0]!, "POST", "/api/teams");
    const d = (await play(cookies[0]!, "GET", "/api/state")).body.drafts[0];
    expect(d.teamA).toHaveLength(1);
    expect(d.teamB).toHaveLength(1);
    expect([...d.teamA, ...d.teamB].some((p: any) => p.steamId === "BOT")).toBe(false);
  });

  it("runs a match from teams to the end", async () => {
    const owner = await adminCookie();
    const serverId = await setupServer(owner);
    await enable(owner, [serverId]);

    const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
    const cookies = await Promise.all(P.map((id, i) => playerCookie(id, names[i]!)));
    for (const c of cookies.slice(0, 4)) expect((await play(c, "POST", "/api/lobby/join")).status).toBe(200);
    // Delta isn't on Leetify and types in their own rating.
    expect((await play(cookies[3]!, "PUT", "/api/me/rating", { rating: 99999 })).status).toBe(400);
    expect((await play(cookies[3]!, "PUT", "/api/me/rating", { rating: 12000 })).status).toBe(200);

    // Make teams: the most even split of 20k, 15k, 10k, 12k is 20k+10k against 15k+12k.
    expect((await play(cookies[0]!, "POST", "/api/teams")).status).toBe(200);
    let state = (await play(cookies[0]!, "GET", "/api/state")).body;
    expect(state.drafts[0].teamA.length).toBe(2);
    expect(state.drafts[0].gap).toBe(3000);
    expect(state.drafts[0].options).toBe(3);
    const delta = [...state.drafts[0].teamA, ...state.drafts[0].teamB].find((p: any) => p.steamId === P[3]);
    expect(delta.rating).toMatchObject({ value: 12000, source: "self" });
    const draftId = state.drafts[0].id;

    // Echo isn't in the lobby or on these teams.
    expect((await play(cookies[4]!, "POST", `/api/teams/${draftId}/reshuffle`)).status).toBe(403);
    expect((await play(cookies[1]!, "POST", `/api/teams/${draftId}/reshuffle`)).status).toBe(200);
    expect((await play(cookies[1]!, "GET", "/api/state")).body.drafts[0].option).toBe(2);
    await play(cookies[1]!, "POST", `/api/teams/${draftId}/reshuffle`);
    await play(cookies[1]!, "POST", `/api/teams/${draftId}/reshuffle`);
    expect((await play(cookies[1]!, "GET", "/api/state")).body.drafts[0].option).toBe(1);

    const start = await play(cookies[2]!, "POST", `/api/teams/${draftId}/start`);
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const matchId = start.body.matchId;
    state = (await play(cookies[0]!, "GET", "/api/state")).body;
    const m = state.matches[0];
    expect(m.phase).toBe("veto");
    expect(m.captainA).toBe(P[0]); // highest rated on each team
    expect(m.captainB).toBe(P[1]);
    expect(m.turn).toBe("a");
    expect(state.lobby.find((p: any) => p.steamId === P[0]).status).toBe("in-match");

    // Captains take turns; the other captain can't ban out of turn.
    expect((await play(cookies[1]!, "POST", `/api/matches/${matchId}/ban`, { map: "de_nuke" })).status).toBe(403);
    expect((await play(cookies[0]!, "POST", `/api/matches/${matchId}/ban`, { map: "de_nuke" })).status).toBe(200);
    expect((await play(cookies[1]!, "POST", `/api/matches/${matchId}/ban`, { map: "de_nuke" })).body.error).toMatch(/already banned/);
    expect((await play(cookies[1]!, "POST", `/api/matches/${matchId}/ban`, { map: "de_inferno" })).status).toBe(200);
    state = (await play(cookies[0]!, "GET", "/api/state")).body;
    expect(state.matches[0]).toMatchObject({ phase: "side", map: "de_mirage", sidePicker: "a" });

    // Team A didn't make the last ban, so its captain picks the side.
    expect((await play(cookies[1]!, "POST", `/api/matches/${matchId}/side`, { side: "ct" })).status).toBe(403);
    expect((await play(cookies[0]!, "POST", `/api/matches/${matchId}/side`, { side: "t" })).status).toBe(200);
    await settle(async () => (await play(cookies[0]!, "GET", "/api/state")).body.matches[0].phase !== "starting");

    state = (await play(cookies[0]!, "GET", "/api/state")).body;
    expect(state.matches[0].phase, state.matches[0].status).toBe("live");
    expect(state.matches[0].sideA).toBe("t");
    const join = state.matches[0].joinInfo;
    expect(join.address).toBe("play.example:27015");
    expect(join.steamUrl).toBe(`steam://connect/play.example:27015/${join.password}`);
    // People not in the match never see the password.
    expect((await play(cookies[4]!, "GET", "/api/state")).body.matches[0].joinInfo).toBeNull();

    // The server was started, locked to these four, and loaded the map in Competitive.
    expect(rconLog).toContain(`sv_password "${join.password}"`);
    expect(rconLog).toContain("cs2panel_match_reload");
    expect(rconLog).toContain("game_type 0; game_mode 1; map de_mirage");
    const [matchFile] = findFile(dir, "match.json");
    const file = JSON.parse(readFileSync(matchFile!, "utf8"));
    expect(file.active).toBe(true);
    expect(file.players).toHaveLength(4);
    const alpha = file.players.find((p: any) => p.steamId === P[0]);
    expect(alpha).toMatchObject({ team: "t", group: "a", name: "Alpha" });

    // Ratings from Leetify aren't written to the database.
    const db = (app.services.servers as any).store.db;
    expect(JSON.stringify(db.prepare("SELECT * FROM mm_matches").all())).not.toContain("20000");

    // Warmup, then the bridge reports the match is over.
    statusReply = `CS2PANEL_MATCH {"active":true,"phase":"warmup","connected":2,"scoreA":0,"scoreB":0}`;
    now += 10_000;
    await app.services.matchmaking.tick();
    expect((await play(cookies[0]!, "GET", "/api/state")).body.matches[0].status).toBe("Warmup: 2 of 4 players in");

    statusReply = `CS2PANEL_MATCH {"active":true,"phase":"over","connected":4,"scoreA":13,"scoreB":9}`;
    now += 10_000;
    await app.services.matchmaking.tick();
    state = (await play(cookies[0]!, "GET", "/api/state")).body;
    expect(state.matches[0]).toMatchObject({ phase: "over", score: { a: 13, b: 9 } });
    // Back in the lobby and ready for the next one.
    expect(state.lobby.find((p: any) => p.steamId === P[0]).status).toBe("ready");

    // The server is unlocked once the scoreboard has been up for a bit.
    now += 25_000;
    await app.services.matchmaking.tick();
    expect(JSON.parse(readFileSync(matchFile!, "utf8")).active).toBe(false);
    // Everyone kicked first, then the bridge drops the match, then the server's own password; each checked.
    const at = (cmd: string) => rconLog.lastIndexOf(cmd);
    const kick = at('cs2panel_kick_all "Match over, thanks for playing! Back to the site for the next match."');
    expect(kick).toBeGreaterThanOrEqual(0);
    expect(at("cs2panel_match_reload")).toBeGreaterThan(kick);
    expect(at('sv_password ""')).toBeGreaterThan(at("cs2panel_match_reload"));
    // And back to its own mode and map, which also drops the lobby's rules config.
    expect(rconLog.at(-1)).toMatch(/^game_type \d+; game_mode \d+; map /);

    const panel = (await admin(owner, "GET", "/api/matchmaking")).body;
    expect(panel.history[0]).toMatchObject({ status: "over", map: "de_mirage", scoreA: 13, scoreB: 9 });
    expect(panel.state.freeServers).toBe(1);
  });

  it("auto-bans when a captain runs out of time, and lets a player cancel", async () => {
    const owner = await adminCookie();
    const serverId = await setupServer(owner);
    await enable(owner, [serverId], { vetoSeconds: 15 });
    const a = await playerCookie(P[0]!, "Alpha");
    const b = await playerCookie(P[1]!, "Bravo");
    await play(a, "POST", "/api/lobby/join");
    await play(b, "POST", "/api/lobby/join");
    await play(a, "POST", "/api/teams");
    const draftId = (await play(a, "GET", "/api/state")).body.drafts[0].id;
    const { matchId } = (await play(a, "POST", `/api/teams/${draftId}/start`)).body;

    now += 16_000;
    await app.services.matchmaking.tick();
    const m = (await play(a, "GET", "/api/state")).body.matches[0];
    expect(m.bans).toEqual([{ map: "de_mirage", by: "a", auto: true }]);
    expect(m.turn).toBe("b");

    // Nobody else can make teams while both players are in a match.
    expect((await play(a, "POST", "/api/teams")).body.error).toMatch(/already in a match/);

    expect((await play(b, "POST", `/api/matches/${matchId}/cancel`)).status).toBe(200);
    const after = (await play(a, "GET", "/api/state")).body;
    expect(after.matches[0]).toMatchObject({ phase: "cancelled", error: "Cancelled by Bravo" });
    expect(after.freeServers).toBe(1);
  });

  it("needs a free server with the bridge", async () => {
    const owner = await adminCookie();
    const serverId = await setupServer(owner, { bridge: false });
    await enable(owner, [serverId]);
    const a = await playerCookie(P[0]!, "Alpha");
    const b = await playerCookie(P[1]!, "Bravo");
    await play(a, "POST", "/api/lobby/join");
    await play(b, "POST", "/api/lobby/join");
    expect((await play(a, "POST", "/api/teams")).body.error).toMatch(/No server is set up/);
  });

  it("keeps banned players out, and lets admins remove people and set ratings", async () => {
    const owner = await adminCookie();
    const serverId = await setupServer(owner);
    await enable(owner, [serverId]);
    await admin(owner, "POST", "/api/bans", { steam: P[4], minutes: 0, reason: "cheating" });
    const e = await playerCookie(P[4]!, "Echo");
    expect((await play(e, "POST", "/api/lobby/join")).status).toBe(403);

    const a = await playerCookie(P[0]!, "Alpha");
    await play(a, "POST", "/api/lobby/join");
    expect((await admin(owner, "PUT", `/api/matchmaking/players/${P[0]}/rating`, { rating: 5000 })).status).toBe(200);
    const me = (await play(a, "GET", "/api/state")).body.me;
    expect(me.rating).toMatchObject({ value: 5000, source: "admin" });

    expect((await admin(owner, "POST", `/api/matchmaking/players/${P[0]}/remove`)).status).toBe(200);
    expect((await play(a, "GET", "/api/state")).body.me.inLobby).toBe(false);
  });

  it("asks Leetify only now and then, not on every page refresh", async () => {
    const owner = await adminCookie();
    await enable(owner, [await setupServer(owner)]);
    const a = await playerCookie(P[0]!, "Alpha");
    await play(a, "POST", "/api/lobby/join");
    for (let i = 0; i < 5; i++) await play(a, "GET", "/api/state");
    await settle(async () => leetifyCalls > 0);
    await settle();
    expect(leetifyCalls).toBe(1);
    expect((await play(a, "GET", "/api/state")).body.me.rating).toMatchObject({ value: 20000, source: "leetify" });
  });

  /** Bans and picks a side until the match is on the server. */
  async function toLive(cookies: string[], ids: string[], matchId: number) {
    const cookieOf = (id: string) => cookies[ids.indexOf(id)]!;
    for (;;) {
      const m = (await play(cookies[0]!, "GET", "/api/state")).body.matches.find((x: any) => x.id === matchId);
      if (m.phase === "veto") {
        await play(cookieOf(m.turn === "a" ? m.captainA : m.captainB), "POST", `/api/matches/${matchId}/ban`, { map: m.remaining[0] });
      } else if (m.phase === "side") {
        await play(cookieOf(m.sidePicker === "a" ? m.captainA : m.captainB), "POST", `/api/matches/${matchId}/side`, { side: "ct" });
      } else if (m.phase === "starting") {
        await settle();
      } else return m;
    }
  }

  it("lets a late player take the bot's place", async () => {
    const owner = await adminCookie();
    await enable(owner, [await setupServer(owner)]);
    const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
    const cookies = await Promise.all(P.map((id, i) => playerCookie(id, names[i]!)));
    for (const c of cookies.slice(0, 3)) await play(c, "POST", "/api/lobby/join", { mode: "wingman" });
    await play(cookies[0]!, "POST", "/api/teams");
    const draft = (await play(cookies[0]!, "GET", "/api/state")).body.drafts[0];
    const { matchId } = (await play(cookies[0]!, "POST", `/api/teams/${draft.id}/start`)).body;
    let m = await toLive(cookies, P, matchId);
    expect(m.phase).toBe("live");
    const botTeam = m.teamA.some((p: any) => p.steamId === "BOT") ? "a" : "b";

    // Delta is in the Competitive lobby: can't join a Wingman match.
    await play(cookies[3]!, "POST", "/api/lobby/join", { mode: "competitive" });
    let view = (await play(cookies[3]!, "GET", "/api/state")).body.matches[0];
    expect(view.canJoin).toEqual({ team: null, reason: "Join the Wingman lobby to join this match." });

    await play(cookies[3]!, "POST", "/api/lobby/join", { mode: "wingman" });
    view = (await play(cookies[3]!, "GET", "/api/state")).body.matches[0];
    expect(view.canJoin).toEqual({ team: botTeam, reason: null });
    // People in the match get no join option.
    expect((await play(cookies[0]!, "GET", "/api/state")).body.matches[0].canJoin).toBeNull();

    rconLog = [];
    const res = await play(cookies[3]!, "POST", `/api/matches/${matchId}/join`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.team).toBe(botTeam);
    m = (await play(cookies[3]!, "GET", "/api/state")).body.matches[0];
    const team = botTeam === "a" ? m.teamA : m.teamB;
    expect(team.map((p: any) => p.steamId)).toContain(P[3]);
    expect([...m.teamA, ...m.teamB].some((p: any) => p.steamId === "BOT")).toBe(false);
    expect(m.joinInfo).not.toBeNull();
    expect(rconLog).toContain("cs2panel_match_reload");
    expect(rconLog).toContain("bot_quota 0; bot_kick");
    const [matchFile] = findFile(dir, "match.json");
    expect(JSON.parse(readFileSync(matchFile!, "utf8")).players).toHaveLength(4);
    const panel = (await admin(owner, "GET", "/api/matchmaking")).body;
    expect([...panel.history[0].teamA, ...panel.history[0].teamB].map((p: any) => p.steamId)).toContain(P[3]);

    // Now 2v2 with no bot: full.
    await play(cookies[4]!, "POST", "/api/lobby/join", { mode: "wingman" });
    expect((await play(cookies[4]!, "GET", "/api/state")).body.matches[0].canJoin.reason).toBe("Both teams are full.");
    expect((await play(cookies[4]!, "POST", `/api/matches/${matchId}/join`)).body.error).toBe("Both teams are full.");
  });

  it("puts late players on the losing team, and the captains can close the match", async () => {
    const owner = await adminCookie();
    await enable(owner, [await setupServer(owner)]);
    const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
    const cookies = await Promise.all(P.map((id, i) => playerCookie(id, names[i]!)));
    await play(cookies[3]!, "PUT", "/api/me/rating", { rating: 12000 });
    for (const c of cookies.slice(0, 4)) await play(c, "POST", "/api/lobby/join", { mode: "competitive" });
    await play(cookies[0]!, "POST", "/api/teams");
    const draft = (await play(cookies[0]!, "GET", "/api/state")).body.drafts[0];
    const { matchId } = (await play(cookies[0]!, "POST", `/api/teams/${draft.id}/start`)).body;
    const m = await toLive(cookies, P, matchId);
    // 2v2 in a 5v5 lobby: both teams have room. Before any score, the lower total rating gets the player.
    const total = (t: any[]) => t.reduce((s, p) => s + p.effective, 0);
    const lower = total(m.teamA) <= total(m.teamB) ? "a" : "b";
    await play(cookies[4]!, "POST", "/api/lobby/join", { mode: "competitive" });
    expect((await play(cookies[4]!, "GET", "/api/state")).body.matches[0].canJoin.team).toBe(lower);

    // Team A is behind: it gets the player.
    statusReply = `CS2PANEL_MATCH {"active":true,"phase":"live","connected":4,"scoreA":3,"scoreB":5}`;
    now += 10_000;
    await app.services.matchmaking.tick();
    expect((await play(cookies[4]!, "GET", "/api/state")).body.matches[0].canJoin.team).toBe("a");

    // Only captains vote; closed only when both say no.
    const capA = cookies[P.indexOf(m.captainA)]!;
    const capB = cookies[P.indexOf(m.captainB)]!;
    const notCaptain = cookies[P.findIndex((id) => id !== m.captainA && id !== m.captainB && [...m.teamA, ...m.teamB].some((p: any) => p.steamId === id))]!;
    expect((await play(notCaptain, "POST", `/api/matches/${matchId}/late-joins`, { allow: false })).status).toBe(403);
    await play(capA, "POST", `/api/matches/${matchId}/late-joins`, { allow: false });
    expect((await play(cookies[4]!, "GET", "/api/state")).body.matches[0].canJoin.team).toBe("a");
    await play(capB, "POST", `/api/matches/${matchId}/late-joins`, { allow: false });
    let view = (await play(cookies[4]!, "GET", "/api/state")).body.matches[0];
    expect(view.lateJoins).toEqual({ open: false, votes: { a: false, b: false } });
    expect(view.canJoin.reason).toMatch(/closed this match/);
    expect((await play(cookies[4]!, "POST", `/api/matches/${matchId}/join`)).status).toBe(400);
    await play(capB, "POST", `/api/matches/${matchId}/late-joins`, { allow: true });

    // Too close to the end.
    statusReply = `CS2PANEL_MATCH {"active":true,"phase":"live","connected":4,"scoreA":5,"scoreB":11}`;
    now += 10_000;
    await app.services.matchmaking.tick();
    view = (await play(cookies[4]!, "GET", "/api/state")).body.matches[0];
    expect(view.canJoin.reason).toMatch(/nearly over/);

    statusReply = `CS2PANEL_MATCH {"active":true,"phase":"live","connected":4,"scoreA":6,"scoreB":9}`;
    now += 10_000;
    await app.services.matchmaking.tick();
    expect((await play(cookies[4]!, "POST", `/api/matches/${matchId}/join`)).body.team).toBe("a");
  });

  it("serves the page with the theme, title and uploaded images", async () => {
    const owner = await adminCookie();
    await enable(owner, [], { title: "Fredags <CS>", look: { theme: "purple", colors: { teamB: "#00ff00" } } });
    let html = (await site.inject({ method: "GET", url: "/", headers: { host: "play.example:8090" } })).body;
    expect(html).toContain("<title>Fredags &lt;CS&gt;</title>");
    expect(html).toContain('<style id="cs2mm-theme">html:root{color-scheme:dark;');
    expect(html).toContain("--team-b:#00ff00;");

    const bad = await app.fastify.inject({
      method: "PUT",
      url: "/api/matchmaking/images/icon",
      headers: { cookie: owner, "content-type": "image/png" },
      payload: Buffer.from("not a png"),
    });
    expect(bad.json().error).toMatch(/PNG, JPG or WebP/);
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64)]);
    const up = await app.fastify.inject({
      method: "PUT",
      url: "/api/matchmaking/images/icon",
      headers: { cookie: owner, "content-type": "image/png" },
      payload: png,
    });
    expect(up.statusCode, up.body).toBe(200);
    const iconUrl = up.json().images.icon as string;
    expect(iconUrl).toMatch(/^\/branding\/icon\?v=\d+$/);

    const icon = await site.inject({ method: "GET", url: iconUrl });
    expect(icon.headers["content-type"]).toBe("image/png");
    expect(icon.rawPayload.equals(png)).toBe(true);
    expect((await site.inject({ method: "GET", url: "/branding/banner" })).statusCode).toBe(404);
    html = (await site.inject({ method: "GET", url: "/", headers: { host: "play.example:8090" } })).body;
    expect(html).toContain(`<link rel="icon" href="${iconUrl}" />`);
    expect(html).not.toContain("<svg");
    expect((await play(null, "GET", "/api/state")).body.look).toEqual({ icon: iconUrl, banner: null });

    // Too big, and removing.
    const huge = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(600 * 1024)]);
    expect(
      (
        await app.fastify.inject({ method: "PUT", url: "/api/matchmaking/images/icon", headers: { cookie: owner, "content-type": "image/png" }, payload: huge })
      ).json().error,
    ).toMatch(/at most 512 KB/);
    await app.fastify.inject({ method: "DELETE", url: "/api/matchmaking/images/icon", headers: { cookie: owner } });
    expect((await play(null, "GET", "/api/state")).body.look.icon).toBeNull();
    expect(
      (
        await admin(owner, "PUT", "/api/matchmaking", {
          settings: { ...(await admin(owner, "GET", "/api/matchmaking")).body.settings, look: { theme: "nope", colors: {} } },
        })
      ).status,
    ).toBe(400);
  });

  it("shows casual servers to everyone and keeps them out of matches", async () => {
    const owner = await adminCookie();
    const serverId = await setupServer(owner);
    await enable(owner, [serverId], { casual: { name: "Fun", serverIds: [serverId] } });
    const saved = (await admin(owner, "GET", "/api/matchmaking")).body.settings;
    expect(saved.casual).toEqual({ name: "Fun", serverIds: [serverId] });
    expect(saved.serverIds).toEqual([]); // a casual server is never a match server

    await app.services.matchmaking.refreshCasual();
    const anon = (await play(null, "GET", "/api/state")).body;
    expect(anon.me).toBeNull();
    expect(anon.casual.name).toBe("Fun");
    expect(anon.casual.servers).toHaveLength(1);
    expect(anon.casual.servers[0]).toMatchObject({
      id: serverId,
      name: "Match #1",
      online: false,
      joinInfo: { address: "play.example:27015", password: "", steamUrl: "steam://connect/play.example:27015", console: "connect play.example:27015" },
    });

    // The bridge is told the server is casual.
    const [matchFile] = findFile(dir, "match.json");
    expect(JSON.parse(readFileSync(matchFile!, "utf8"))).toMatchObject({ active: false, casual: true });

    // No match server left: making teams says so.
    const a = await playerCookie(P[0]!, "Alpha");
    const b = await playerCookie(P[1]!, "Bravo");
    await play(a, "POST", "/api/lobby/join", { mode: "competitive" });
    await play(b, "POST", "/api/lobby/join", { mode: "competitive" });
    expect((await play(a, "POST", "/api/teams")).body.error).toMatch(/No server is set up/);

    // No longer casual: the flag is taken off again.
    await enable(owner, [serverId], { casual: { name: "Fun", serverIds: [] } });
    expect(JSON.parse(readFileSync(matchFile!, "utf8")).casual).toBe(false);
    expect((await admin(owner, "PUT", "/api/matchmaking", { settings: { ...saved, casual: { name: "", serverIds: [] } } })).body.error).toMatch(/name/);
  });

  it("checks Workshop maps with Steam and shows their names", async () => {
    const owner = await adminCookie();
    const current = (await admin(owner, "GET", "/api/matchmaking")).body.settings;
    const withMaps = (maps: string[]) => ({
      settings: { ...current, enabled: true, modes: { ...current.modes, duel: { enabled: true, maps } } },
    });
    const removed = await admin(owner, "PUT", "/api/matchmaking", withMaps(["workshop:222"]));
    expect(removed.body.error).toMatch(/Workshop map 222: "Old map" has been removed/);
    const missing = await admin(owner, "PUT", "/api/matchmaking", withMaps(["workshop:333"]));
    expect(missing.body.error).toMatch(/Steam has no Workshop item 333/);
    expect((await admin(owner, "PUT", "/api/matchmaking", withMaps(["workshop:111", "de_nuke"]))).status).toBe(200);
    expect((await admin(owner, "GET", "/api/matchmaking")).body.mapNames).toEqual({ "workshop:111": "Aim Botz" });
    expect((await play(null, "GET", "/api/state")).body.mapNames).toEqual({ "workshop:111": "Aim Botz" });
  });

  it("keeps a just-used server out of the next match, and shows why servers aren't free", async () => {
    const owner = await adminCookie();
    const first = await setupServer(owner, { name: "Match #1", port: 27015 });
    const second = await setupServer(owner, { name: "Match #2", port: 27025 });
    const third = await setupServer(owner, { name: "Match #3", port: 27035, bridge: false });
    await enable(owner, [first, second, third]);
    const names = ["Alpha", "Bravo", "Charlie", "Delta"];
    const cookies = await Promise.all(P.slice(0, 4).map((id, i) => playerCookie(id, names[i]!)));
    for (const c of cookies.slice(0, 2)) await play(c, "POST", "/api/lobby/join", { mode: "wingman" });
    await play(cookies[0]!, "POST", "/api/teams");
    let draft = (await play(cookies[0]!, "GET", "/api/state")).body.drafts[0];
    const one = (await play(cookies[0]!, "POST", `/api/teams/${draft.id}/start`)).body.matchId;
    let m = await toLive(cookies, P, one);
    expect(m.serverName).toBe("Match #1");

    // While it runs, the same lobby can make another match on another server.
    for (const c of cookies.slice(2, 4)) await play(c, "POST", "/api/lobby/join", { mode: "wingman" });
    let st = (await play(cookies[2]!, "GET", "/api/state")).body;
    expect(st.serverStates).toEqual([
      { name: "Match #1", state: "in-match", label: `Running match ${one}` },
      { name: "Match #2", state: "free", label: "Free" },
      { name: "Match #3", state: "no-bridge", label: "Needs CounterStrikeSharp (with CS2 Panel Bridge)" },
    ]);

    // Cancelling kicks everyone; the freed server goes to the back of the line.
    rconLog = [];
    await play(cookies[0]!, "POST", `/api/matches/${one}/cancel`);
    expect(rconLog[0]).toBe('cs2panel_kick_all "The match was cancelled. Back to the site for the next one."');
    await play(cookies[2]!, "POST", "/api/teams");
    draft = (await play(cookies[2]!, "GET", "/api/state")).body.drafts[0];
    const two = (await play(cookies[2]!, "POST", `/api/teams/${draft.id}/start`)).body.matchId;
    m = await toLive(cookies, P, two);
    expect(m.serverName).toBe("Match #2");
  });

  it("only gives out the Join button once the server runs the match", async () => {
    const owner = await adminCookie();
    await enable(owner, [await setupServer(owner)]);
    const a = await playerCookie(P[0]!, "Alpha");
    const b = await playerCookie(P[1]!, "Bravo");
    for (const c of [a, b]) await play(c, "POST", "/api/lobby/join", { mode: "duel" });
    await play(a, "POST", "/api/teams");
    const draft = (await play(a, "GET", "/api/state")).body.drafts[0];
    const { matchId } = (await play(a, "POST", `/api/teams/${draft.id}/start`)).body;
    // The server keeps reporting an old match (the map change never happened).
    statusReply = `CS2PANEL_MATCH {"active":true,"matchId":"999","phase":"warmup","connected":0,"scoreA":0,"scoreB":0,"mapLoads":0}`;
    const m = await toLive([a, b], P, matchId);
    expect(m.phase).toBe("cancelled");
    expect(m.joinInfo).toBeNull();
    expect(m.error).toMatch(/didn't finish loading the match/);
  });

  it("lets the captains turn the bot off and on", async () => {
    const owner = await adminCookie();
    await enable(owner, [await setupServer(owner)]);
    const names = ["Alpha", "Bravo", "Charlie"];
    const cookies = await Promise.all(P.slice(0, 3).map((id, i) => playerCookie(id, names[i]!)));
    for (const c of cookies) await play(c, "POST", "/api/lobby/join", { mode: "wingman" });
    await play(cookies[0]!, "POST", "/api/teams");
    const draft = (await play(cookies[0]!, "GET", "/api/state")).body.drafts[0];
    const { matchId } = (await play(cookies[0]!, "POST", `/api/teams/${draft.id}/start`)).body;
    let m = await toLive(cookies, P, matchId);
    expect(m.bots).toMatchObject({ on: true, votes: { a: true, b: true } });
    const capA = cookies[P.indexOf(m.captainA)]!;
    const capB = cookies[P.indexOf(m.captainB)]!;
    const [matchFile] = findFile(dir, "match.json");

    await play(capA, "POST", `/api/matches/${matchId}/bot`, { allow: false });
    expect((await play(capA, "GET", "/api/state")).body.matches[0].bots.on).toBe(true);
    rconLog = [];
    await play(capB, "POST", `/api/matches/${matchId}/bot`, { allow: false });
    m = (await play(capA, "GET", "/api/state")).body.matches[0];
    expect(m.bots).toMatchObject({ on: false, votes: { a: false, b: false } });
    expect([...m.teamA, ...m.teamB].some((p: any) => p.steamId === "BOT")).toBe(false);
    expect(JSON.parse(readFileSync(matchFile!, "utf8")).bot).toBeNull();
    expect(rconLog).toContain("cs2panel_match_reload");

    await play(capB, "POST", `/api/matches/${matchId}/bot`, { allow: true });
    m = (await play(capA, "GET", "/api/state")).body.matches[0];
    expect(m.bots.on).toBe(true);
    expect(JSON.parse(readFileSync(matchFile!, "utf8")).bot).not.toBeNull();
  });

  it("gives each team its Discord channel", async () => {
    const owner = await adminCookie();
    const serverId = await setupServer(owner);
    const chA = "https://discord.com/channels/111/222";
    const chB = "https://discord.com/channels/111/333";
    const bad = await admin(owner, "PUT", "/api/matchmaking", {
      settings: {
        ...(await admin(owner, "GET", "/api/matchmaking")).body.settings,
        discord: { invite: "", channels: { [serverId]: { a: "discord team 1", b: "" } } },
      },
    });
    expect(bad.body.error).toMatch(/voice channel's link/);
    await enable(owner, [serverId], { discord: { invite: "https://discord.gg/fredag", channels: { [serverId]: { a: chA, b: chB } } } });
    const cookies = await Promise.all(P.slice(0, 3).map((id, i) => playerCookie(id, ["Alpha", "Bravo", "Charlie"][i]!)));
    for (const c of cookies.slice(0, 2)) await play(c, "POST", "/api/lobby/join", { mode: "wingman" });
    await play(cookies[0]!, "POST", "/api/teams");
    const draft = (await play(cookies[0]!, "GET", "/api/state")).body.drafts[0];
    await play(cookies[0]!, "POST", `/api/teams/${draft.id}/start`);
    const m = (await play(cookies[0]!, "GET", "/api/state")).body.matches[0];
    const mine = m.teamA.some((p: any) => p.steamId === P[0]) ? chA : chB;
    expect(m.discord).toEqual({ channel: mine, invite: "https://discord.gg/fredag" });
    expect((await play(cookies[2]!, "GET", "/api/state")).body.matches[0].discord).toBeNull();
    expect((await play(cookies[2]!, "GET", "/api/state")).body.casual.discord).toBeNull();

    // An ended match leaves the list for everyone but its own players.
    await play(cookies[0]!, "POST", `/api/matches/${m.id}/cancel`);
    await settle(async () => (await play(cookies[0]!, "GET", "/api/state")).body.matches[0]?.phase === "cancelled");
    expect((await play(cookies[2]!, "GET", "/api/state")).body.matches).toHaveLength(0);
    expect((await play(cookies[0]!, "GET", "/api/state")).body.matches[0].discord).toBeNull();

    // One channel for the casual servers, shown to everyone.
    await enable(owner, [serverId], { discord: { invite: "https://discord.gg/fredag", channels: {}, casual: chA } });
    expect((await play(null, "GET", "/api/state")).body.casual.discord).toEqual({ channel: chA, invite: "https://discord.gg/fredag" });

    // 1v1 uses one shared channel instead of the team channels.
    const duelCh = "https://discord.com/channels/111/444";
    await enable(owner, [serverId], { discord: { invite: "", channels: { [serverId]: { a: chA, b: chB } }, casual: "", duel: duelCh } });
    for (const c of cookies.slice(0, 2)) await play(c, "POST", "/api/lobby/join", { mode: "duel" });
    await play(cookies[0]!, "POST", "/api/teams");
    const duelDraft = (await play(cookies[0]!, "GET", "/api/state")).body.drafts[0];
    expect((await play(cookies[0]!, "POST", `/api/teams/${duelDraft.id}/start`)).status).toBe(200);
    for (const c of cookies.slice(0, 2)) {
      const mine = (await play(c, "GET", "/api/state")).body.matches.find((x: any) => x.mode === "duel");
      expect(mine.discord).toEqual({ channel: duelCh, invite: null });
    }
  });

  it("runs the lobby's rules config after each map load, without the lines that fight the match", async () => {
    const owner = await adminCookie();
    const serverId = await setupServer(owner);
    // Before anyone saves a config, 1v1 comes with the aim-duel rules.
    expect((await admin(owner, "GET", "/api/matchmaking")).body.settings.modes.duel.config).toMatch(/mp_maxrounds 30/);
    const duelCfg = "mp_maxrounds 30 // first to 16\nmp_startmoney 16000; sv_password nope\nbot_quota 2\nmp_warmup_end\nmp_restartgame 1\n";
    await enable(owner, [serverId], {
      modes: {
        competitive: { enabled: true, maps: ["de_mirage"], config: "" },
        wingman: { enabled: false, maps: ["de_vertigo"], config: "" },
        duel: { enabled: true, maps: ["de_vertigo"], config: duelCfg, keepWeapons: true },
      },
    });
    const cookies = await Promise.all(P.slice(0, 2).map((id, i) => playerCookie(id, ["Alpha", "Bravo"][i]!)));
    for (const c of cookies) await play(c, "POST", "/api/lobby/join", { mode: "duel" });
    await play(cookies[0]!, "POST", "/api/teams");
    const draft = (await play(cookies[0]!, "GET", "/api/state")).body.drafts[0];
    const { matchId } = (await play(cookies[0]!, "POST", `/api/teams/${draft.id}/start`)).body;
    const m = (await play(cookies[0]!, "GET", "/api/state")).body.matches[0];
    const picker = m.sidePicker === "a" ? m.captainA : m.captainB;
    await play(cookies[P.indexOf(picker)]!, "POST", `/api/matches/${matchId}/side`, { side: "t" });
    await settle(async () => (await play(cookies[0]!, "GET", "/api/state")).body.matches[0].phase !== "starting");
    expect((await play(cookies[0]!, "GET", "/api/state")).body.matches[0].phase).toBe("live");

    const [cfgFile] = findFile(dir, "cs2panel_match.cfg");
    const cfg = readFileSync(cfgFile!, "utf8");
    expect(cfg).toContain("mp_maxrounds 30\nmp_startmoney 16000\n");
    expect(cfg).not.toMatch(/sv_password|bot_quota|mp_warmup_end|mp_restartgame|first to/);
    expect(JSON.parse(readFileSync(findFile(dir, "match.json")[0]!, "utf8"))).toMatchObject({ exec: "cs2panel_match.cfg", keepWeapons: true });
  });

  // ------------------------------------------------------------- Discord channels by server

  /** Two players make teams in a lobby and start; returns the match as the first player sees it once it's live. */
  async function liveIn(mode: string, cs: string[], ids: string[]) {
    for (const c of cs) await play(c, "POST", "/api/lobby/join", { mode });
    await play(cs[0]!, "POST", "/api/teams");
    const draft = (await play(cs[0]!, "GET", "/api/state")).body.drafts.find((d: { mode: string }) => d.mode === mode);
    const { matchId } = (await play(cs[0]!, "POST", `/api/teams/${draft.id}/start`)).body;
    const m = await toLive(cs, ids, matchId);
    expect(m.phase, m.error).toBe("live");
    return m;
  }

  it("gives new 1v1 servers the shared 1v1 channel with no extra setup, and lets one server have its own", async () => {
    const owner = await adminCookie();
    const old = await setupServer(owner, { name: "1v1 #1", port: 27015 });
    const shared = "https://discord.com/channels/111/500";
    await enable(owner, [], {
      modes: {
        competitive: { enabled: false, maps: ["de_mirage"], serverIds: [] },
        wingman: { enabled: false, maps: ["de_vertigo"], serverIds: [] },
        duel: { enabled: true, maps: ["de_vertigo"], serverIds: [old] },
      },
      discord: { invite: "", channels: {}, casual: "", duel: shared },
    });
    // Two more 1v1 servers, ticked in the lobby: nothing else set up for Discord.
    const n2 = await setupServer(owner, { name: "1v1 #2", port: 27025 });
    const n3 = await setupServer(owner, { name: "1v1 #3", port: 27035 });
    const settings = (await admin(owner, "GET", "/api/matchmaking")).body.settings;
    settings.modes.duel.serverIds = [n2, n3];
    expect((await admin(owner, "PUT", "/api/matchmaking", { settings })).status).toBe(200);
    expect((await admin(owner, "GET", "/api/matchmaking")).body.settings.discord).toMatchObject({ duel: shared, duelServers: {}, channels: {} });

    const cookies = await Promise.all(P.slice(0, 4).map((id, i) => playerCookie(id, ["Alpha", "Bravo", "Charlie", "Delta"][i]!)));
    const m1 = await liveIn("duel", cookies.slice(0, 2), P.slice(0, 2));
    expect(["1v1 #2", "1v1 #3"]).toContain(m1.serverName);
    for (const c of cookies.slice(0, 2)) expect((await play(c, "GET", "/api/state")).body.matches[0].discord).toEqual({ channel: shared, invite: null });

    // The other new server gets its own channel; the shared one stays as it was.
    const other = m1.serverName === "1v1 #2" ? n3 : n2;
    const own = "https://discord.com/channels/111/501";
    const s2 = (await admin(owner, "GET", "/api/matchmaking")).body.settings;
    s2.discord.duelServers = { [String(other)]: own };
    await admin(owner, "PUT", "/api/matchmaking", { settings: s2 });
    const m2 = await liveIn("duel", cookies.slice(2, 4), P.slice(2, 4));
    expect((await play(cookies[2]!, "GET", "/api/state")).body.matches.find((x: { id: number }) => x.id === m2.id).discord).toEqual({
      channel: own,
      invite: null,
    });
    expect((await admin(owner, "GET", "/api/matchmaking")).body.settings.discord.duel).toBe(shared);
  });

  it("picks the channel by the match's lobby when one server serves Wingman and 1v1", async () => {
    const owner = await adminCookie();
    const both = await setupServer(owner, { name: "Small #1", port: 27015 });
    const [t1, t2, duel] = ["600", "601", "602"].map((c) => `https://discord.com/channels/111/${c}`);
    await enable(owner, [], {
      modes: {
        competitive: { enabled: false, maps: ["de_mirage"], serverIds: [] },
        wingman: { enabled: true, maps: ["de_vertigo"], serverIds: [both] },
        duel: { enabled: true, maps: ["de_vertigo"], serverIds: [both] },
      },
      discord: { invite: "", channels: { [String(both)]: { a: t1!, b: t2! } }, casual: "", duel: duel! },
    });
    const cookies = await Promise.all(P.slice(0, 4).map((id, i) => playerCookie(id, ["Alpha", "Bravo", "Charlie", "Delta"][i]!)));
    // Wingman with 2 players (1v1 in Wingman's lobby): the team channels.
    const w = await liveIn("wingman", cookies.slice(0, 2), P.slice(0, 2));
    const seen = await Promise.all(cookies.slice(0, 2).map(async (c) => (await play(c, "GET", "/api/state")).body.matches[0].discord.channel));
    expect(seen.sort()).toEqual([t1, t2].sort());
    await play(cookies[0]!, "POST", `/api/matches/${w.id}/cancel`);
    // The same server in the 1v1 lobby: the shared 1v1 channel.
    const d = await liveIn("duel", cookies.slice(2, 4), P.slice(2, 4));
    expect(d.serverName).toBe("Small #1");
    expect((await play(cookies[2]!, "GET", "/api/state")).body.matches.find((x: { id: number }) => x.id === d.id).discord.channel).toBe(duel);
  });

  it("gives casual servers the shared channel or their own, and forgets links of deleted servers", async () => {
    const owner = await adminCookie();
    const a = await setupServer(owner, { name: "Casual #1", port: 27015 });
    const b = await setupServer(owner, { name: "Casual #2", port: 27025 });
    const gone = await setupServer(owner, { name: "Gone", port: 27035 });
    const [sharedCh, ownCh, goneCh] = ["700", "701", "702"].map((c) => `https://discord.com/channels/111/${c}`);
    await enable(owner, [gone], {
      casual: { name: "Fun", serverIds: [a, b] },
      discord: { invite: "", channels: { [String(gone)]: { a: goneCh!, b: "" } }, casual: sharedCh!, duel: "", casualServers: { [String(b)]: ownCh! } },
    });
    await app.services.matchmaking.refreshCasual();
    const casual = (await play(null, "GET", "/api/state")).body.casual;
    expect(casual.discord).toEqual({ channel: sharedCh, invite: null });
    expect(casual.servers.map((x: { name: string; discord: { channel: string } }) => [x.name, x.discord.channel])).toEqual([
      ["Casual #1", sharedCh],
      ["Casual #2", ownCh],
    ]);

    // Deleting a server: its links go on the next save; everyone else's stay.
    const slug = (await admin(owner, "GET", `/api/servers/${gone}`)).body.server.slug;
    expect((await admin(owner, "DELETE", `/api/servers/${gone}`, { confirm: slug })).status).toBe(200);
    const settings = (await admin(owner, "GET", "/api/matchmaking")).body.settings;
    expect((await admin(owner, "PUT", "/api/matchmaking", { settings })).status).toBe(200);
    expect((await admin(owner, "GET", "/api/matchmaking")).body.settings.discord).toMatchObject({
      channels: {},
      casual: sharedCh,
      casualServers: { [String(b)]: ownCh },
    });
  });

  it("keeps Discord links saved before per-server channels", async () => {
    const owner = await adminCookie();
    const id = await setupServer(owner);
    const ch = "https://discord.com/channels/111/800";
    (app.services.matchmaking as any).d.settings.set("matchmaking", {
      enabled: false,
      serverIds: [id],
      discord: { invite: "https://discord.gg/fredag", channels: { [String(id)]: { a: ch, b: ch } }, casual: ch, duel: ch },
    });
    expect((await admin(owner, "GET", "/api/matchmaking")).body.settings.discord).toEqual({
      invite: "https://discord.gg/fredag",
      channels: { [String(id)]: { a: ch, b: ch } },
      casual: ch,
      duel: ch,
      duelServers: {},
      casualServers: {},
    });
  });

  it("tells the Discord bot when a match goes live and ends, and carries on when the bot fails", async () => {
    const owner = await adminCookie();
    await enable(owner, [await setupServer(owner)]);
    const calls: string[] = [];
    app.services.matchmaking.voice = {
      matchLive: async (m) => {
        calls.push(`live ${m.id} ${m.mode} a=${m.teams.a.length} b=${m.teams.b.length}`);
        throw new Error("Discord is down");
      },
      matchEnded: async (id) => {
        calls.push(`ended ${id}`);
        throw new Error("Discord is down");
      },
      channelLinkFor: (_id, steamId) => (steamId === P[0] ? "https://discord.com/channels/1/2" : null),
    };
    const cookies = await Promise.all(P.slice(0, 2).map((id, i) => playerCookie(id, ["Alpha", "Bravo"][i]!)));
    for (const c of cookies) await play(c, "POST", "/api/lobby/join", { mode: "duel" });
    await play(cookies[0]!, "POST", "/api/teams");
    const draft = (await play(cookies[0]!, "GET", "/api/state")).body.drafts[0];
    const { matchId } = (await play(cookies[0]!, "POST", `/api/teams/${draft.id}/start`)).body;
    const m = await toLive(cookies, P, matchId);
    expect(m.phase).toBe("live");
    expect(calls).toEqual([`live ${matchId} duel a=1 b=1`]);
    // A linked player sees the bot's temporary channel; the other keeps the configured one (none here).
    expect((await play(cookies[0]!, "GET", "/api/state")).body.matches[0].discord).toEqual({ channel: "https://discord.com/channels/1/2", invite: null });
    expect((await play(cookies[1]!, "GET", "/api/state")).body.matches[0].discord).toBeNull();
    expect((await play(cookies[0]!, "POST", `/api/matches/${matchId}/cancel`)).status).toBe(200);
    expect(calls).toContain(`ended ${matchId}`);
    expect((await play(cookies[0]!, "GET", "/api/state")).body.matches[0].phase).toBe("cancelled");
  });

  // ------------------------------------------------------------- servers per lobby

  it("runs each lobby on its own servers", async () => {
    const owner = await adminCookie();
    const comp = await setupServer(owner, { name: "Comp #1", port: 27015 });
    const duel = await setupServer(owner, { name: "1v1 #1", port: 27020 });
    await enable(owner, [], {
      modes: {
        competitive: { enabled: true, maps: ["de_mirage"], serverIds: [comp] },
        wingman: { enabled: false, maps: ["de_vertigo"], serverIds: [] },
        duel: { enabled: true, maps: ["de_vertigo"], serverIds: [duel] },
      },
    });
    const settings = (await admin(owner, "GET", "/api/matchmaking")).body.settings;
    // The shared list is every lobby's servers together (Discord channels, cleanup and so on use it).
    expect(settings.serverIds.sort()).toEqual([comp, duel].sort());
    expect(settings.modes.duel.serverIds).toEqual([duel]);

    const cookies = await Promise.all(P.slice(0, 4).map((id, i) => playerCookie(id, ["Alpha", "Bravo", "Charlie", "Delta"][i]!)));
    for (const c of cookies.slice(0, 2)) await play(c, "POST", "/api/lobby/join", { mode: "duel" });
    await play(cookies[0]!, "POST", "/api/teams");
    const draft = (await play(cookies[0]!, "GET", "/api/state")).body.drafts[0];
    expect((await play(cookies[0]!, "POST", `/api/teams/${draft.id}/start`)).status).toBe(200);
    const state = (await play(cookies[0]!, "GET", "/api/state")).body;
    expect(state.matches[0].serverName).toBe("1v1 #1");
    // The 1v1 server is taken; the Competitive one is still free, but only for Competitive.
    const lobby = (mode: string) => state.lobbies.find((l: { mode: string }) => l.mode === mode);
    expect(lobby("duel")).toMatchObject({ freeServers: 0, matchServers: 1 });
    expect(lobby("competitive")).toMatchObject({ freeServers: 1, matchServers: 1 });
    for (const c of cookies.slice(2, 4)) await play(c, "POST", "/api/lobby/join", { mode: "duel" });
    const busy = await play(cookies[2]!, "POST", "/api/teams");
    expect(busy.status).toBe(400);
    expect(busy.body.error).toBe("Every 1v1 server is busy. Wait for a match to finish.");
  });

  it("keeps a casual server out of every lobby, and gives old settings all match servers per lobby", async () => {
    const owner = await adminCookie();
    const a = await setupServer(owner, { name: "Match #1", port: 27015 });
    const b = await setupServer(owner, { name: "Casual #1", port: 27020 });
    // Saved before lobbies had their own servers: every lobby uses the shared list.
    (app.services.matchmaking as any).d.settings.set("matchmaking", { enabled: false, serverIds: [a, b] });
    let settings = (await admin(owner, "GET", "/api/matchmaking")).body.settings;
    expect(settings.modes.competitive.serverIds).toEqual([a, b]);
    expect(settings.modes.duel.serverIds).toEqual([a, b]);

    settings.casual = { name: "Casual", serverIds: [b] };
    expect((await admin(owner, "PUT", "/api/matchmaking", { settings })).status).toBe(200);
    settings = (await admin(owner, "GET", "/api/matchmaking")).body.settings;
    expect(settings.modes.competitive.serverIds).toEqual([a]);
    expect(settings.serverIds).toEqual([a]);
  });

  // ------------------------------------------------------------- cleanup after a match

  describe("server cleanup after a match", () => {
    let owner: string;
    let serverId: number;
    let cookies: string[];

    const db = () => (app.services.servers as any).store.db;
    const cleanupRows = () => db().prepare("SELECT server_id, attempts, last_error FROM mm_cleanup").all() as any[];
    const serverState = async () => (await admin(owner, "GET", "/api/matchmaking")).body.state.serverStates[0];
    const matchJson = () => JSON.parse(readFileSync(findFile(dir, "match.json")[0]!, "utf8"));
    const kicks = () => rconLog.filter((c) => c.startsWith("cs2panel_kick_all")).length;

    /** These two make teams and start a 1v1 (anyone else leaves the lobby). Returns the failing reply if there's no server. */
    async function startDuel(cs: string[]) {
      for (const c of cookies) if (!cs.includes(c)) await play(c, "POST", "/api/lobby/leave");
      for (const c of cs) await play(c, "POST", "/api/lobby/join", { mode: "duel" });
      let draft = (await play(cs[0]!, "GET", "/api/state")).body.drafts[0];
      if (!draft) {
        const teams = await play(cs[0]!, "POST", "/api/teams");
        if (teams.status !== 200) return teams;
        draft = (await play(cs[0]!, "GET", "/api/state")).body.drafts[0];
      }
      return play(cs[0]!, "POST", `/api/teams/${draft.id}/start`);
    }

    /** A live 1v1 on the one match server, with both players on it. */
    async function liveDuel(): Promise<number> {
      owner = await adminCookie();
      serverId = await setupServer(owner);
      await enable(owner, [serverId]);
      cookies = await Promise.all(P.slice(0, 4).map((id, i) => playerCookie(id, ["Alpha", "Bravo", "Charlie", "Delta"][i]!)));
      const { matchId } = (await startDuel(cookies.slice(0, 2))).body;
      expect(matchId).toBeTypeOf("number");
      const m = await toLive(cookies, P, matchId);
      expect(m.phase).toBe("live");
      expect(serverPassword).toBe(m.joinInfo.password);
      humansOn = 2;
      return matchId;
    }

    /** The key check: the server can't go to another match. */
    async function expectNotAssignable() {
      expect((await admin(owner, "GET", "/api/matchmaking")).body.state.freeServers).toBe(0);
      const res = await startDuel(cookies.slice(2, 4));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/busy/);
    }

    async function retryAfter(ms: number) {
      now += ms;
      await app.services.matchmaking.tick();
      await settle(async () => cleanupRows().every((r) => !app.services.matchmaking["cleanups"].get(r.server_id)?.running));
    }

    async function expectCleanAndFree() {
      expect(cleanupRows()).toEqual([]);
      expect(await serverState()).toMatchObject({ state: "free" });
      expect(matchJson().active).toBe(false);
      expect(serverPassword).toBe("");
      expect(humansOn).toBe(0);
    }

    it("cleans up, checks it, and frees the server", async () => {
      const id = await liveDuel();
      await play(cookies[0]!, "POST", `/api/matches/${id}/cancel`);
      await expectCleanAndFree();
      expect(kicks()).toBe(1);
      expect((await startDuel(cookies.slice(2, 4))).status).toBe(200);
    });

    it("keeps the server out after an RCON timeout, and retries with growing delays", async () => {
      const id = await liveDuel();
      failRcon = /^cs2panel_kick_all/;
      await play(cookies[0]!, "POST", `/api/matches/${id}/cancel`);
      expect(cleanupRows()).toMatchObject([{ server_id: serverId, attempts: 1, last_error: "RCON timed out" }]);
      expect(await serverState()).toMatchObject({ state: "cleanup-failed", label: expect.stringMatching(/RCON timed out.*Trying again in 5 s/) });
      await expectNotAssignable();

      // Not before the delay is up; then 5 s, 10 s.
      await retryAfter(4_000);
      expect(kicks()).toBe(1);
      await retryAfter(1_000);
      expect(kicks()).toBe(2);
      expect(cleanupRows()[0].attempts).toBe(2);
      await retryAfter(9_000);
      expect(kicks()).toBe(2);
      failRcon = null;
      await retryAfter(1_000);
      await expectCleanAndFree();
      expect((await startDuel(cookies.slice(2, 4))).status).toBe(200);
    });

    it("doesn't trust a kick that didn't empty the server", async () => {
      const id = await liveDuel();
      kickWorks = false;
      await play(cookies[0]!, "POST", `/api/matches/${id}/cancel`);
      expect(cleanupRows()[0].last_error).toBe("2 people are still on it after the kick");
      // The match settings stay on while people are still there.
      expect(matchJson().active).toBe(true);
      await expectNotAssignable();
      kickWorks = true;
      await retryAfter(5_000);
      await expectCleanAndFree();
    });

    it("keeps the server out when the bridge doesn't drop the match", async () => {
      const id = await liveDuel();
      failRcon = /^cs2panel_match_reload$/;
      await play(cookies[0]!, "POST", `/api/matches/${id}/cancel`);
      expect(cleanupRows()[0].last_error).toBe("RCON timed out");
      await expectNotAssignable();
      failRcon = null;
      await retryAfter(5_000);
      await expectCleanAndFree();
    });

    it("keeps the server out until its own password is back", async () => {
      const id = await liveDuel();
      failRcon = /^sv_password ""$/;
      await play(cookies[0]!, "POST", `/api/matches/${id}/cancel`);
      expect(cleanupRows()[0].last_error).toBe("RCON timed out");
      // The command goes through but the password doesn't change: caught by the bridge's check.
      failRcon = null;
      passwordSticks = false;
      await retryAfter(5_000);
      expect(cleanupRows()[0]).toMatchObject({ attempts: 2, last_error: "The server's own password didn't come back" });
      await expectNotAssignable();
      passwordSticks = true;
      await retryAfter(10_000);
      await expectCleanAndFree();
    });

    it("keeps the server out when match.json can't be written", async () => {
      const id = await liveDuel();
      const file = findFile(dir, "match.json")[0]!;
      rmSync(file);
      mkdirSync(file); // Something in the way: the write fails.
      await play(cookies[0]!, "POST", `/api/matches/${id}/cancel`);
      expect(cleanupRows()[0].attempts).toBe(1);
      await expectNotAssignable();
      rmSync(file, { recursive: true });
      await retryAfter(5_000);
      await expectCleanAndFree();
    });

    it("finishes the cleanup without RCON when the server stops in the middle", async () => {
      const id = await liveDuel();
      failRcon = /./;
      await play(cookies[0]!, "POST", `/api/matches/${id}/cancel`);
      expect(await serverState()).toMatchObject({ state: "cleanup-failed" });
      await expectNotAssignable();
      expect((await admin(owner, "POST", `/api/servers/${serverId}/stop`)).status).toBe(200);
      rconLog = [];
      await retryAfter(5_000);
      // A stopped server needs no RCON: match.json is all the bridge reads when it starts.
      expect(rconLog).toEqual([]);
      expect(cleanupRows()).toEqual([]);
      expect(matchJson().active).toBe(false);
      expect(await serverState()).toMatchObject({ state: "free" });
    });

    it("cleans up a stopped server from its files alone", async () => {
      const id = await liveDuel();
      await admin(owner, "POST", `/api/servers/${serverId}/stop`);
      rconLog = [];
      await play(cookies[0]!, "POST", `/api/matches/${id}/cancel`);
      expect(rconLog).toEqual([]);
      expect(matchJson().active).toBe(false);
      expect(cleanupRows()).toEqual([]);
      expect(await serverState()).toMatchObject({ state: "free" });
    });

    it("picks up pending cleanups and running matches after a restart", async () => {
      const id = await liveDuel();
      failRcon = /./;
      // The panel restarts while the match runs and RCON is down.
      await site.close();
      await app.fastify.close();
      await boot();
      await app.services.matchmaking.recover();
      const rows = cleanupRows();
      expect(rows).toMatchObject([{ server_id: serverId, attempts: 1 }]);
      expect(db().prepare("SELECT status FROM mm_matches WHERE id = ?").get(id).status).toBe("abandoned");
      expect(await serverState()).toMatchObject({ state: "cleanup-failed" });
      expect((await admin(owner, "GET", "/api/matchmaking")).body.state.freeServers).toBe(0);

      // And again, with the cleanup still pending from before.
      await site.close();
      await app.fastify.close();
      await boot();
      await app.services.matchmaking.recover();
      expect(cleanupRows()[0].attempts).toBe(2);
      failRcon = null;
      await retryAfter(10_000);
      await expectCleanAndFree();
    });

    it("never runs two cleanups of a server at once", async () => {
      const id = await liveDuel();
      let open!: () => void;
      rconGate = { match: /^cs2panel_kick_all/, wait: new Promise<void>((r) => (open = r)) };
      const cancelling = play(cookies[0]!, "POST", `/api/matches/${id}/cancel`);
      await settle(async () => kicks() === 1);
      // Meanwhile: the timer, an admin's "try again", and a restart-style recover.
      now += 60_000;
      await app.services.matchmaking.tick();
      await admin(owner, "POST", `/api/matchmaking/servers/${serverId}/cleanup`, { action: "retry" });
      expect(kicks()).toBe(1);
      expect(await serverState()).toMatchObject({ state: "freeing" });
      open();
      await cancelling;
      expect(kicks()).toBe(1);
      await expectCleanAndFree();
    });

    it("cleans up again when a match is cancelled while the server is still starting it", async () => {
      owner = await adminCookie();
      serverId = await setupServer(owner);
      await enable(owner, [serverId]);
      cookies = await Promise.all(P.slice(0, 4).map((id, i) => playerCookie(id, ["Alpha", "Bravo", "Charlie", "Delta"][i]!)));
      // The launch hangs just before it sets the match password.
      let open!: () => void;
      rconGate = { match: /^sv_password "[^"]+"$/, wait: new Promise<void>((r) => (open = r)) };
      const { matchId } = (await startDuel(cookies.slice(0, 2))).body;
      let m = (await play(cookies[0]!, "GET", "/api/state")).body.matches[0];
      await play(cookies[P.indexOf(m.sidePicker === "a" ? m.captainA : m.captainB)]!, "POST", `/api/matches/${matchId}/side`, { side: "ct" });
      await settle(async () => rconLog.some((c) => /^sv_password "[^"]+"$/.test(c)));

      // Cancelled now: the cleanup runs and passes...
      await play(cookies[0]!, "POST", `/api/matches/${matchId}/cancel`);
      expect(cleanupRows()).toEqual([]);
      // ...then the launch carries on and puts the match password on the server.
      open();
      await settle(async () => cleanupRows().length > 0);
      expect(await serverState()).toMatchObject({ state: "freeing" });
      await expectNotAssignable();
      await retryAfter(1_000);
      await expectCleanAndFree();
      m = (await play(cookies[0]!, "GET", "/api/state")).body.matches[0];
      expect(m.phase).toBe("cancelled");
    });

    it("never gives one server to two teams starting at the same moment", async () => {
      owner = await adminCookie();
      serverId = await setupServer(owner);
      await enable(owner, [serverId]);
      cookies = await Promise.all(P.slice(0, 4).map((id, i) => playerCookie(id, ["Alpha", "Bravo", "Charlie", "Delta"][i]!)));
      for (const c of cookies.slice(0, 2)) await play(c, "POST", "/api/lobby/join", { mode: "duel" });
      for (const c of cookies.slice(2, 4)) await play(c, "POST", "/api/lobby/join", { mode: "wingman" });
      await play(cookies[0]!, "POST", "/api/teams");
      await play(cookies[2]!, "POST", "/api/teams");
      const drafts = (await play(cookies[0]!, "GET", "/api/state")).body.drafts as { id: number; mode: string }[];
      const draftOf = (mode: string) => drafts.find((d) => d.mode === mode)!.id;
      const [a, b] = await Promise.all([
        play(cookies[0]!, "POST", `/api/teams/${draftOf("duel")}/start`),
        play(cookies[2]!, "POST", `/api/teams/${draftOf("wingman")}/start`),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 400]);
      expect((a.status === 400 ? a : b).body.error).toMatch(/busy/);
    });

    it("lets an admin free a server by hand", async () => {
      const id = await liveDuel();
      failRcon = /./;
      await play(cookies[0]!, "POST", `/api/matches/${id}/cancel`);
      expect((await admin(owner, "POST", `/api/matchmaking/servers/${serverId}/cleanup`, { action: "release" })).status).toBe(200);
      expect(cleanupRows()).toEqual([]);
      expect(matchJson().active).toBe(false);
      expect(await serverState()).toMatchObject({ state: "free" });
    });
  });
});

describe("cleanup retries", () => {
  it("backs off from 5 seconds to at most 5 minutes", () => {
    expect([1, 2, 3, 4, 7, 8, 20].map(cleanupDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 300_000, 300_000, 300_000]);
    expect(parseMatchStatus(`CS2PANEL_MATCH {"active":false,"humans":0,"password":"hunter2"}`)).toMatchObject({
      active: false,
      humans: 0,
      password: "hunter2",
    });
  });
});

describe("lobby rules config", () => {
  it("drops comments and match-controlled commands, and reads the rounds to win", () => {
    expect(cleanModeConfig("// x\nmp_freezetime 2 // short\nmap de_dust2; mp_buytime 15\nexec other.cfg")).toEqual({
      text: "mp_freezetime 2\nmp_buytime 15",
      ignored: ["map", "exec"],
    });
    expect(winRoundsFromConfig("mp_maxrounds 30")).toBe(16);
    expect(winRoundsFromConfig('mp_maxrounds "24"\nmp_maxrounds 16')).toBe(9);
    expect(winRoundsFromConfig("mp_freezetime 2")).toBeNull();
    // The built-in 1v1 rules: 90-second rounds; earlier built-ins are recognised so saved copies follow along.
    expect(DUEL_CONFIG).toContain("mp_roundtime 1.5\n");
    expect(OLD_DUEL_CONFIGS.some((c) => c.includes("mp_roundtime 10\n"))).toBe(true);
    expect(OLD_DUEL_CONFIGS.some((c) => c.includes("mp_roundtime 1\n"))).toBe(true);
  });
});
