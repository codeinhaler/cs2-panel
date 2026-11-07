import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
import { parseMatchStatus } from "../src/matchmaking/service.js";

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

describe("parsers", () => {
  it("reads Premier from a Leetify profile", () => {
    expect(parseProfile({ ranks: { premier: 18854, competitive: [] }, privacy_mode: "public" })).toEqual({ premier: 18854, note: null });
    expect(parseProfile({ ranks: { premier: null, competitive: [] }, privacy_mode: "private" }).note).toMatch(/private/);
    expect(parseProfile({}).premier).toBeNull();
  });

  it("reads the bridge's match status", () => {
    const out = `junk\nCS2PANEL_MATCH {"active":true,"matchId":"3","phase":"live","connected":10,"expected":10,"scoreA":7,"scoreB":5}\n`;
    expect(parseMatchStatus(out)).toEqual({ active: true, phase: "live", connected: 10, scoreA: 7, scoreB: 5 });
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

async function setup() {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-mm-"));
  const config: Config = {
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
  now = 1_000_000;
  rconLog = [];
  leetifyCalls = 0;
  statusReply = `CS2PANEL_MATCH {"active":true,"phase":"warmup","connected":0,"scoreA":0,"scoreB":0}`;
  const fetchFn = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.hostname === "api-public.cs-prod.leetify.com") {
      leetifyCalls++;
      const id = u.searchParams.get("steam64_id")!;
      if (!(id in LEETIFY)) return new Response("{}", { status: 404 });
      return Response.json({ name: "x", privacy_mode: "public", ranks: { premier: LEETIFY[id], competitive: [] } });
    }
    return new Response("<profile></profile>");
  }) as typeof fetch;
  app = await buildApp({
    config,
    db: openDb(path.join(dir, "panel.db")),
    host: new FakeHost(config.cs2Root, config.instanceEnvDir),
    fetchFn,
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    matchmakingClock: { now: () => now, sleep: async (ms) => void (now += ms), random: () => 0 },
    rcon: async (o, cmd) => {
      rconLog.push(cmd);
      if (cmd === "cs2panel_version") return "cs2panel bridge 1.1.0, 0 bans";
      if (cmd === "cs2panel_match_status") return statusReply;
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

async function setupServer(cookie: string, opts: { bridge?: boolean } = {}): Promise<number> {
  const presets = (await admin(cookie, "GET", "/api/presets")).body.presets as { id: number; key: string }[];
  const pid = presets.find((p) => p.key === "competitive")!.id;
  const res = await admin(cookie, "POST", "/api/servers", { name: "Match #1", presetId: pid, port: 27015 });
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
    settings: { ...current, enabled: true, serverIds, maps: ["de_mirage", "de_inferno", "de_nuke"], ...extra },
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

  it("only lets admins change the settings", async () => {
    const owner = await adminCookie();
    const res = await admin(owner, "PUT", "/api/matchmaking", {
      settings: { enabled: true, port: 8080, title: "x", serverIds: [], maps: [], gameAddress: "", vetoSeconds: 30 },
    });
    expect(res.body.error).toMatch(/at least one map/);
    const bad = await admin(owner, "PUT", "/api/matchmaking", {
      settings: { enabled: true, port: 8090, title: "x", serverIds: [], maps: ["not a map!"], gameAddress: "", vetoSeconds: 30 },
    });
    expect(bad.status).toBe(400);
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
    expect(state.draft.teamA.length).toBe(2);
    expect(state.draft.gap).toBe(3000);
    expect(state.draft.options).toBe(3);
    const delta = [...state.draft.teamA, ...state.draft.teamB].find((p: any) => p.steamId === P[3]);
    expect(delta.rating).toMatchObject({ value: 12000, source: "self" });
    const draftId = state.draft.id;

    // Echo isn't in the lobby or on these teams.
    expect((await play(cookies[4]!, "POST", `/api/teams/${draftId}/reshuffle`)).status).toBe(403);
    expect((await play(cookies[1]!, "POST", `/api/teams/${draftId}/reshuffle`)).status).toBe(200);
    expect((await play(cookies[1]!, "GET", "/api/state")).body.draft.option).toBe(2);
    await play(cookies[1]!, "POST", `/api/teams/${draftId}/reshuffle`);
    await play(cookies[1]!, "POST", `/api/teams/${draftId}/reshuffle`);
    expect((await play(cookies[1]!, "GET", "/api/state")).body.draft.option).toBe(1);

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
    expect(rconLog.at(-1)).toBe('sv_password ""');

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
    const draftId = (await play(a, "GET", "/api/state")).body.draft.id;
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
});
