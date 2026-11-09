import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { BANS_FILE, parseBridgePlayers } from "../src/players/bans.js";
import { MAP_CYCLE_FILE, parseCycleStatus } from "../src/servers/map-cycle.js";

const OWNER = "76561198000000001";
const ALICE = "76561198000000011";
const BOB = "76561198000000012";

const STATUS = `---------players--------
  id     time ping loss      state   rate adr name
     1      BOT    0    0     active      0 'Bot Albert'
     2    01:08   26    0     active 786432 192.168.1.10:27005 'Alice'
#end
`;
const BRIDGE_PLAYERS = `CS2PANEL_PLAYERS [{"userId":2,"steamId":"${ALICE}","name":"Alice"}]\n`;

describe("bridge output", () => {
  it("reads the player list and ignores junk around it", () => {
    const ids = parseBridgePlayers(`L 11/06/2026 - noise\n${BRIDGE_PLAYERS}[{"bad":1}]`);
    expect([...ids]).toEqual([[2, ALICE]]);
    expect(() => parseBridgePlayers("Unknown command 'cs2panel_players'")).toThrow();
  });
});

let dir: string;
let fixtures: string;
let app: App;
let host: FakeHost;
let db: Db;
const rconCalls: string[] = [];

function zip(out: string, files: Record<string, string>) {
  const src = mkdtempSync(path.join(tmpdir(), "zsrc-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    writeFileSync(path.join(src, f), c);
  }
  if (out.endsWith(".zip")) execFileSync("zip", ["-qr", out, "."], { cwd: src });
  else execFileSync("tar", ["-czf", out, "-C", src, "."]);
  rmSync(src, { recursive: true, force: true });
}

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("api.github.com/repos/roflmuffin/CounterStrikeSharp/releases")) {
    return new Response(
      JSON.stringify([
        {
          tag_name: "v370",
          draft: false,
          prerelease: false,
          published_at: "2026-11-01T00:00:00Z",
          assets: [
            {
              name: "counterstrikesharp-with-runtime-linux-1.0.370.zip",
              browser_download_url: "https://dl.test/counterstrikesharp-with-runtime-linux-1.0.370.zip",
              size: 1,
            },
          ],
        },
      ]),
    );
  }
  if (url.endsWith("mmsource-latest-linux")) return new Response("mmsource-2.0.0-git1350-linux.tar.gz\n");
  const file = /(?:dl\.test|mmsdrop\/2\.0)\/(.+)$/.exec(url)?.[1];
  if (file && existsSync(path.join(fixtures, file))) return new Response(readFileSync(path.join(fixtures, file)));
  return new Response("not found", { status: 404 });
}) as typeof fetch;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-bans-"));
  fixtures = path.join(dir, "fixtures");
  mkdirSync(fixtures);
  zip(path.join(fixtures, "mmsource-2.0.0-git1350-linux.tar.gz"), { "addons/metamod.vdf": "vdf", "addons/metamod/bin/linuxsteamrt64/libserver.so": "mm" });
  zip(path.join(fixtures, "counterstrikesharp-with-runtime-linux-1.0.370.zip"), {
    "addons/counterstrikesharp/bin/linuxsteamrt64/counterstrikesharp.so": "css",
    "addons/metamod/counterstrikesharp.vdf": "vdf",
  });
  // What the release ships in bridge/.
  const bridgeDir = path.join(dir, "bridge");
  mkdirSync(bridgeDir);
  zip(path.join(bridgeDir, "cs2panel-bridge.zip"), { "counterstrikesharp/plugins/Cs2PanelBridge/Cs2PanelBridge.dll": "bridge" });
  writeFileSync(path.join(bridgeDir, "VERSION"), "v0.3.0\n");

  rconCalls.length = 0;
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    ownerSteamId: OWNER,
    secretKey: "44".repeat(32),
    dataDir: dir,
    cs2Root: path.join(dir, "cs2"),
    instanceEnvDir: path.join(dir, "env"),
    cs2ctl: "/bin/false",
    webDir: path.join(dir, "no-web"),
    bridgeDir,
    dev: true,
  };
  installFakeBase(config.cs2Root);
  host = new FakeHost(config.cs2Root, config.instanceEnvDir);
  db = openDb(path.join(dir, "panel.db"));
  app = await buildApp({
    config,
    db,
    host,
    fetchFn: fakeFetch,
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    rcon: async (_o, cmd) => {
      rconCalls.push(cmd);
      if (cmd === "status") return STATUS;
      if (cmd === "cs2panel_players") return BRIDGE_PLAYERS;
      if (cmd === "cs2panel_mapcycle_status") return 'CS2PANEL_MAPCYCLE {"active":true,"next":"workshop:3070244931"}\n';
      return "";
    },
  });
});

afterEach(async () => {
  await app.fastify.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login() {
  const res = await app.fastify.inject({ method: "GET", url: `/api/auth/dev?steamId=${OWNER}` });
  return `cs2p_session=${res.cookies.find((c) => c.name === "cs2p_session")!.value}`;
}
async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.fastify.inject({
    method: method as "GET",
    url,
    headers: { cookie, host: "panel.lan" },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}
async function newServer(c: string, name: string, port: number) {
  const presets = (await call(c, "GET", "/api/presets")).body.presets;
  return (await call(c, "POST", "/api/servers", { name, presetId: presets[0].id, port })).body.server as { id: number; slug: string };
}
const bansFile = (slug: string) => path.join(dir, "cs2/instances", slug, "upper/game/csgo", BANS_FILE);
const fileBans = (slug: string) =>
  (JSON.parse(readFileSync(bansFile(slug), "utf8")) as { bans: { steamId: string; reason: string; expiresAt: string | null }[] }).bans;

describe("panel bans", () => {
  it("installs the bridge together with CounterStrikeSharp and gives it the ban list", async () => {
    const c = await login();
    const s = await newServer(c, "A", 27015);
    const res = await call(c, "POST", `/api/servers/${s.id}/plugins/counterstrikesharp/install`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.installed.map((p: { id: string }) => p.id)).toEqual(["metamod", "counterstrikesharp", "cs2panel-bridge"]);
    expect(res.body.installed.at(-1).version).toBe("v0.3.0");
    expect(
      readFileSync(path.join(dir, "cs2/instances", s.slug, "upper/game/csgo/addons/counterstrikesharp/plugins/Cs2PanelBridge/Cs2PanelBridge.dll"), "utf8"),
    ).toBe("bridge");
    expect(fileBans(s.slug)).toEqual([]);
    expect((await call(c, "GET", "/api/bans/coverage")).body.enforced).toEqual([{ id: s.id, name: "A" }]);
  });

  it("bans an online player on every bridge server, reloads running ones, and unbans", async () => {
    const c = await login();
    const a = await newServer(c, "A", 27015);
    const b = await newServer(c, "B", 27025);
    const plain = await newServer(c, "Plain", 27035);
    for (const s of [a, b]) await call(c, "POST", `/api/servers/${s.id}/plugins/counterstrikesharp/install`, {});
    await call(c, "POST", `/api/servers/${a.id}/start`, {});

    // SteamIDs come from the bridge.
    const live = (await call(c, "GET", `/api/servers/${a.id}/players`)).body;
    expect(live.players.find((p: { name: string }) => p.name === "Alice").steamId).toBe(ALICE);

    rconCalls.length = 0;
    const res = await call(c, "POST", "/api/bans", { serverId: a.id, userId: 2, minutes: 60, reason: "Wallhack" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ban).toMatchObject({ steamId: ALICE, name: "Alice", reason: "Wallhack", serverName: "A", status: "active" });
    expect(res.body.coverage.missing).toEqual([{ id: plain.id, name: "Plain" }]);
    // Running server reloads; the stopped one gets the file for its next start.
    expect(rconCalls.filter((x) => x === "cs2panel_reload")).toHaveLength(1);
    for (const s of [a, b]) {
      const [entry] = fileBans(s.slug);
      expect(entry).toMatchObject({ steamId: ALICE, reason: "Wallhack" });
      expect(Date.parse(entry!.expiresAt!) - Date.now()).toBeGreaterThan(59 * 60_000);
    }
    expect(existsSync(bansFile(plain.slug))).toBe(false);

    expect((await call(c, "POST", "/api/bans", { steam: ALICE, minutes: 0, reason: "Again" })).status).toBe(400);

    const un = await call(c, "POST", `/api/bans/${res.body.ban.id}/unban`, { reason: "Appeal accepted" });
    expect(un.status).toBe(200);
    expect(fileBans(a.slug)).toEqual([]);
    expect((await call(c, "GET", "/api/bans")).body.bans).toEqual([]);
    const all = (await call(c, "GET", "/api/bans?all=1")).body.bans;
    expect(all[0]).toMatchObject({ status: "unbanned", revokeReason: "Appeal accepted" });

    const actions = (await call(c, "GET", "/api/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(actions.slice(0, 2)).toEqual(["player.unban", "player.ban"]);
  });

  it("bans by SteamID while every server is stopped, permanently", async () => {
    const c = await login();
    const s = await newServer(c, "A", 27015);
    await call(c, "POST", `/api/servers/${s.id}/plugins/counterstrikesharp/install`, {});
    rconCalls.length = 0;
    const res = await call(c, "POST", "/api/bans", { steam: BOB, name: "Bob", minutes: 0, reason: "Cheating" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rconCalls).toEqual([]);
    expect(fileBans(s.slug)).toEqual([{ steamId: BOB, reason: "Cheating", expiresAt: null }]);
    expect((await call(c, "POST", "/api/bans", { steam: "nope", minutes: 0, reason: "x" })).status).toBe(400);
    expect((await call(c, "POST", "/api/bans", { steam: BOB, minutes: 0, reason: " " })).status).toBe(400);
  });

  it("writes a fresh list on start and leaves out expired bans", async () => {
    const c = await login();
    const s = await newServer(c, "A", 27015);
    await call(c, "POST", `/api/servers/${s.id}/plugins/counterstrikesharp/install`, {});
    await call(c, "POST", "/api/bans", { steam: BOB, minutes: 30, reason: "Toxic" });
    await call(c, "POST", "/api/bans", { steam: ALICE, minutes: 0, reason: "Cheating" });
    db.prepare("UPDATE bans SET expires_at = datetime('now', '-1 minute') WHERE steam_id = ?").run(BOB);
    rmSync(bansFile(s.slug));
    expect((await call(c, "POST", `/api/servers/${s.id}/start`, {})).status).toBe(200);
    expect(fileBans(s.slug).map((b) => b.steamId)).toEqual([ALICE]);
    expect((await call(c, "GET", "/api/bans?all=1")).body.bans.map((b: { status: string }) => b.status)).toEqual(["active", "expired"]);
  });

  it("explains when a server can't see SteamIDs", async () => {
    const c = await login();
    const s = await newServer(c, "Plain", 27015);
    await call(c, "POST", `/api/servers/${s.id}/start`, {});
    const res = await call(c, "POST", "/api/bans", { serverId: s.id, userId: 2, minutes: 0, reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/CS2 Panel Bridge/);
  });
});

describe("map cycle", () => {
  it("reads the bridge's map cycle status", () => {
    expect(parseCycleStatus('x\nCS2PANEL_MAPCYCLE {"active":true,"next":"de_inferno"}')).toEqual({ active: true, next: "de_inferno" });
    expect(parseCycleStatus("Unknown command")).toBeNull();
  });

  it("gives a Casual server's bridge the cycle, and turns it off in other modes", async () => {
    const c = await login();
    const s = await newServer(c, "Casual", 27015);
    const cycleFile = path.join(dir, "cs2/instances", s.slug, "upper/game/csgo", MAP_CYCLE_FILE);
    let info = (await call(c, "GET", `/api/servers/${s.id}/map-cycle`)).body;
    expect(info).toMatchObject({ casual: true, bridge: false, mapCycle: { maps: [], random: false }, next: null });

    expect((await call(c, "PUT", `/api/servers/${s.id}/map-cycle`, { maps: ["de_dust2", "workshop:123:456"], random: false })).status).toBe(400);
    expect((await call(c, "PUT", `/api/servers/${s.id}/map-cycle`, { maps: ["de_dust2", "de_dust2", "workshop:3070244931"], random: true })).status).toBe(200);
    // Without the bridge nothing is written; installing it writes the file.
    expect(existsSync(cycleFile)).toBe(false);
    await call(c, "POST", `/api/servers/${s.id}/plugins/counterstrikesharp/install`, {});
    expect(JSON.parse(readFileSync(cycleFile, "utf8"))).toEqual({
      version: 1,
      active: true,
      random: true,
      maps: [{ map: "de_dust2" }, { workshop: "3070244931" }],
    });

    await call(c, "POST", `/api/servers/${s.id}/start`, {});
    rconCalls.length = 0;
    await call(c, "PUT", `/api/servers/${s.id}/map-cycle`, { maps: ["de_dust2", "de_inferno"], random: false });
    expect(rconCalls).toContain("cs2panel_mapcycle_reload");
    info = (await call(c, "GET", `/api/servers/${s.id}/map-cycle`)).body;
    expect(info).toMatchObject({ casual: true, bridge: true, next: "workshop:3070244931" });
    expect((await call(c, "GET", `/api/servers/${s.id}`)).body.mapCycle).toEqual({ maps: ["de_dust2", "de_inferno"], random: false });
  });
});
