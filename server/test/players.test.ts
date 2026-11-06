import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, type Db } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { parseStatus } from "../src/players/status.js";
import { parsePlayers, toIso } from "../src/plugins/integrations/simpleadmin.js";

const OWNER = "76561198000000001";
const ADMIN = "76561198000000002";
const MOD = "76561198000000003";
const ALICE = "76561198000000011";
const BOB = "76561198000000012";

const STATUS = `Server:  Running [0.0.0.0:27015]
Client:  Disconnected
@ Current  :  game
---------players--------
  id     time ping loss      state   rate adr name
65535 [NoChan]    0    0 challenging      0unknown ''
     1      BOT    0    0     active      0 'Bot Albert'
     2    01:08   26    0     active 786432 192.168.1.10:27005 'Alice'
     3 1:02:44   41    1     active 786432 85.1.2.3:27005 'Bob the "Builder"'
#end
`;

const CSS_PLAYERS = `--------- PLAYER LIST ---------
• [#2] "Alice" (IP Address: "192.168.1.10" SteamID64: "${ALICE}")
• [#3] "Bob the "Builder"" (IP Address: "85.1.2.3" SteamID64: "${BOB}")
--------- END PLAYER LIST ---------`;

describe("parsing", () => {
  it("reads CS2's status players section", () => {
    const p = parseStatus(STATUS);
    expect(p.map((x) => [x.userId, x.name, x.bot])).toEqual([
      [1, "Bot Albert", true],
      [2, "Alice", false],
      [3, 'Bob the "Builder"', false],
    ]);
    expect(p[1]).toMatchObject({ time: "01:08", ping: 26, address: "192.168.1.10:27005", state: "active" });
    expect(p[2]!.time).toBe("1:02:44");
    expect(parseStatus("no players section")).toEqual([]);
  });

  it("reads SimpleAdmin's css_players list", () => {
    expect(parsePlayers(CSS_PLAYERS)).toEqual([
      { userId: 2, steamId: ALICE },
      { userId: 3, steamId: BOB },
    ]);
  });

  it("reads SimpleAdmin timestamps as UTC", () => {
    expect(toIso("2026-11-06 10:24:25.1234567")).toBe("2026-11-06T10:24:25.123Z");
    expect(toIso("2026-11-06T10:24:25")).toBe("2026-11-06T10:24:25.000Z");
    expect(toIso(null)).toBeNull();
    expect(toIso("nonsense")).toBeNull();
  });
});

// ---------------------------------------------------------------- end to end

let dir: string;
let app: App;
let db: Db;
let host: FakeHost;
let online: string;
let sa: DatabaseSync | null;
const commands: string[] = [];

/** The parts of SimpleAdmin's schema the panel reads. */
function createSimpleAdminDb(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec(`
    CREATE TABLE sa_bans (id INTEGER PRIMARY KEY AUTOINCREMENT, player_name VARCHAR(128), player_steamid VARCHAR(64), player_ip VARCHAR(128),
      admin_steamid VARCHAR(64) NOT NULL, admin_name VARCHAR(128) NOT NULL, reason VARCHAR(255) NOT NULL, duration INTEGER NOT NULL,
      ends TIMESTAMP NULL, created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, server_id INTEGER NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', unban_id INTEGER NULL);
    CREATE TABLE sa_admins (id INTEGER PRIMARY KEY AUTOINCREMENT, player_name VARCHAR(128) NOT NULL, player_steamid VARCHAR(64) NOT NULL, flags TEXT NULL,
      immunity INTEGER NOT NULL DEFAULT 0, server_id INTEGER NULL, ends TIMESTAMP NULL, created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, group_id INTEGER NULL);
    CREATE TABLE sa_admins_flags (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, flag VARCHAR(64) NOT NULL);
    CREATE TABLE sa_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) NOT NULL, immunity INTEGER NOT NULL DEFAULT 0);
  `);
  return d;
}

/** Plays the server: answers status, and acts like SimpleAdmin on its commands. */
async function fakeRcon(_o: unknown, cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "status") return online;
  if (cmd === "css_players") return sa ? CSS_PLAYERS : "Unknown command 'css_players'!";
  if (!sa) return `Unknown command '${cmd.split(" ")[0]}'!`;
  let m: RegExpExecArray | null;
  if ((m = /^css_addban (\d+) (\d+) "(.*)"$/.exec(cmd)) || (m = /^css_ban #(\d+) (\d+) "(.*)"$/.exec(cmd))) {
    const steam = cmd.startsWith("css_ban") ? (m[1] === "2" ? ALICE : BOB) : m[1]!;
    const minutes = Number(m[2]);
    sa.prepare(
      "INSERT INTO sa_bans (player_name, player_steamid, admin_steamid, admin_name, reason, duration, ends) VALUES (?, ?, '0', 'Console', ?, ?, ?)",
    ).run(steam === ALICE ? "Alice" : null, steam, m[3]!, minutes, minutes ? new Date(Date.now() + minutes * 60_000).toISOString().replace("T", " ").slice(0, 19) : null);
    return "";
  }
  if ((m = /^css_unban (\d+) "(.*)"$/.exec(cmd))) {
    sa.prepare("UPDATE sa_bans SET status = 'UNBANNED' WHERE player_steamid = ? AND status = 'ACTIVE'").run(m[1]!);
    return "";
  }
  if ((m = /^css_addadmin (\d+) "(.*)" (\S+) (\d+) (\d+)$/.exec(cmd))) {
    const r = sa.prepare("INSERT INTO sa_admins (player_name, player_steamid, immunity) VALUES (?, ?, ?)").run(m[2]!, m[1]!, Number(m[4]));
    for (const f of m[3]!.split(",")) sa.prepare("INSERT INTO sa_admins_flags (admin_id, flag) VALUES (?, ?)").run(Number(r.lastInsertRowid), f);
    return "";
  }
  if ((m = /^css_deladmin (\d+)$/.exec(cmd))) {
    sa.prepare("DELETE FROM sa_admins WHERE player_steamid = ?").run(m[1]!);
    return "";
  }
  if (cmd.startsWith("kickid")) return "";
  return "";
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-players-"));
  online = STATUS;
  sa = null;
  commands.length = 0;
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    ownerSteamId: OWNER,
    secretKey: "33".repeat(32),
    dataDir: dir,
    cs2Root: path.join(dir, "cs2"),
    instanceEnvDir: path.join(dir, "env"),
    cs2ctl: "/bin/false",
    webDir: path.join(dir, "no-web"),
    bridgeDir: path.join(dir, "no-bridge"),
    dev: true,
  };
  installFakeBase(config.cs2Root);
  host = new FakeHost(config.cs2Root, config.instanceEnvDir);
  db = openDb(path.join(dir, "panel.db"));
  app = await buildApp({ config, db, host, logLevel: "silent", pluginCheckDelayMs: 0, rcon: fakeRcon, fetchFn: (async () => new Response("")) as typeof fetch });
});

afterEach(async () => {
  sa?.close();
  await app.fastify.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login(steamId = OWNER) {
  const res = await app.fastify.inject({ method: "GET", url: `/api/auth/dev?steamId=${steamId}` });
  return `cs2p_session=${res.cookies.find((c) => c.name === "cs2p_session")!.value}`;
}
async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.fastify.inject({ method: method as "GET", url, headers: { cookie, host: "panel.lan" }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}
async function runningServer(c: string) {
  const presets = (await call(c, "GET", "/api/presets")).body.presets;
  const s = (await call(c, "POST", "/api/servers", { name: "S", presetId: presets[0].id, port: 27015 })).body.server;
  await call(c, "POST", `/api/servers/${s.id}/start`, {});
  return s as { id: number; slug: string };
}
/** Pretends SimpleAdmin is installed on the server and has created its SQLite file. */
function installSimpleAdmin(serverId: number, slug: string) {
  db.prepare("INSERT INTO plugin_installs (server_id, plugin_id, name, version, asset, files) VALUES (?, 'cs2-simpleadmin', 'CS2-SimpleAdmin', '1.9.1', 'x.zip', '[]')").run(serverId);
  const csgo = path.join(dir, "cs2/instances", slug, "upper/game/csgo");
  sa = createSimpleAdminDb(path.join(csgo, "addons/counterstrikesharp/plugins/CS2-SimpleAdmin/cs2-simpleadmin.sqlite"));
  mkdirSync(path.join(csgo, "addons/counterstrikesharp/configs/plugins/CS2-SimpleAdmin"), { recursive: true });
  writeFileSync(path.join(csgo, "addons/counterstrikesharp/configs/plugins/CS2-SimpleAdmin/CS2-SimpleAdmin.json"), JSON.stringify({ DatabaseConfig: { DatabaseType: "SQLite" } }));
}

describe("players without plugins", () => {
  it("lists players and kicks one; moderators may kick, history is kept", async () => {
    const c = await login();
    await call(c, "POST", "/api/users", { steam: MOD, role: "moderator" });
    const s = await runningServer(c);
    const live = (await call(c, "GET", `/api/servers/${s.id}/players`)).body;
    expect(live.running).toBe(true);
    expect(live.players.map((p: { name: string }) => p.name)).toEqual(["Bot Albert", "Alice", 'Bob the "Builder"']);
    expect(live.players[1].steamId).toBeNull();
    expect(commands).not.toContain("css_players");

    const m = await login(MOD);
    expect((await call(m, "POST", `/api/servers/${s.id}/players/2/kick`, { reason: 'Be "nice"; please' })).status).toBe(200);
    expect(commands).toContain('kickid 2 "Be nice please"');
    expect((await call(m, "POST", `/api/servers/${s.id}/players/99/kick`, {})).body.error).toMatch(/isn't on the server/);

    const audit = (await call(c, "GET", `/api/audit?serverId=${s.id}`)).body.entries[0];
    expect(audit).toMatchObject({ action: "player.kick", details: { name: "Alice" } });

    // Alice leaves; history shows both, Alice offline.
    online = STATUS.replace(/^\s+2 .*Alice.*\n/m, "");
    await call(c, "GET", `/api/servers/${s.id}/players`);
    const recent = (await call(c, "GET", `/api/players/recent?serverId=${s.id}`)).body.players;
    expect(recent.map((r: { name: string; online: boolean }) => [r.name, r.online]).sort()).toEqual([
      ["Alice", false],
      ['Bob the "Builder"', true],
    ]);
  });

  it("reports a stopped server and has no ban features without a plugin", async () => {
    const c = await login();
    const s = await runningServer(c);
    await call(c, "POST", `/api/servers/${s.id}/stop`, {});
    expect((await call(c, "GET", `/api/servers/${s.id}/players`)).body).toEqual({ running: false, players: [], error: null });
    expect((await call(c, "GET", `/api/servers/${s.id}/moderation`)).body.provider).toBeNull();
    expect((await call(c, "GET", `/api/servers/${s.id}/moderation/bans`)).body.error).toMatch(/need a plugin/);
  });
});

describe("bans and admins through SimpleAdmin", () => {
  it("adds SteamIDs to the player list and bans an online player", async () => {
    const c = await login();
    const s = await runningServer(c);
    installSimpleAdmin(s.id, s.slug);
    const info = (await call(c, "GET", `/api/servers/${s.id}/moderation`)).body;
    expect(info).toMatchObject({ provider: "CS2-SimpleAdmin", shared: false, canAct: true });
    expect(info.flagPresets[0].flags).toBe("@css/root");

    const live = (await call(c, "GET", `/api/servers/${s.id}/players`)).body;
    expect(live.players[1]).toMatchObject({ name: "Alice", steamId: ALICE });

    expect((await call(c, "POST", `/api/servers/${s.id}/moderation/bans`, { userId: 2, minutes: 60, reason: "Spawn camping" })).status).toBe(200);
    expect(commands).toContain('css_ban #2 60 "Spawn camping"');
    const bans = (await call(c, "GET", `/api/servers/${s.id}/moderation/bans`)).body.bans;
    expect(bans).toHaveLength(1);
    expect(bans[0]).toMatchObject({ steamId: ALICE, playerName: "Alice", reason: "Spawn camping", duration: 60, status: "active" });
    expect(Date.parse(bans[0].endsAt)).toBeGreaterThan(Date.now());
    const audit = (await call(c, "GET", `/api/audit?serverId=${s.id}`)).body.entries[0];
    expect(audit).toMatchObject({ action: "player.ban", details: { steamId: ALICE, minutes: 60 } });
  });

  it("bans offline by SteamID or profile link, unbans, and keeps history when asked", async () => {
    const c = await login();
    const s = await runningServer(c);
    installSimpleAdmin(s.id, s.slug);
    await call(c, "POST", `/api/servers/${s.id}/moderation/bans`, { steam: `https://steamcommunity.com/profiles/${BOB}`, minutes: 0, reason: "Cheating" });
    expect(commands).toContain(`css_addban ${BOB} 0 "Cheating"`);
    let bans = (await call(c, "GET", `/api/servers/${s.id}/moderation/bans`)).body.bans;
    expect(bans[0]).toMatchObject({ steamId: BOB, duration: 0, endsAt: null, status: "active" });

    await call(c, "POST", `/api/servers/${s.id}/moderation/bans/unban`, { steamId: BOB, reason: "Appeal accepted" });
    expect((await call(c, "GET", `/api/servers/${s.id}/moderation/bans`)).body.bans).toEqual([]);
    bans = (await call(c, "GET", `/api/servers/${s.id}/moderation/bans?all=true`)).body.bans;
    expect(bans[0].status).toBe("unbanned");

    // Expired bans aren't active even if the plugin hasn't marked them yet.
    sa!.prepare("INSERT INTO sa_bans (player_steamid, admin_steamid, admin_name, reason, duration, ends) VALUES (?, '0', 'x', 'old', 10, '2020-01-01 00:00:00')").run(ALICE);
    expect((await call(c, "GET", `/api/servers/${s.id}/moderation/bans`)).body.bans).toEqual([]);
  });

  it("validates bans and needs a running server", async () => {
    const c = await login();
    const s = await runningServer(c);
    installSimpleAdmin(s.id, s.slug);
    expect((await call(c, "POST", `/api/servers/${s.id}/moderation/bans`, { steam: BOB, minutes: 60, reason: "" })).body.error).toMatch(/reason/);
    expect((await call(c, "POST", `/api/servers/${s.id}/moderation/bans`, { steam: "nope", minutes: 60, reason: "x" })).status).toBe(400);
    await call(c, "POST", `/api/servers/${s.id}/stop`, {});
    expect((await call(c, "POST", `/api/servers/${s.id}/moderation/bans`, { steam: BOB, minutes: 60, reason: "x" })).body.error).toMatch(/Start the server/);
    // Reading still works while stopped.
    expect((await call(c, "GET", `/api/servers/${s.id}/moderation/bans`)).status).toBe(200);
  });

  it("explains when the plugin doesn't answer (not loaded or hibernating)", async () => {
    const c = await login();
    const s = await runningServer(c);
    installSimpleAdmin(s.id, s.slug);
    const keep = sa;
    sa = null;
    expect((await call(c, "POST", `/api/servers/${s.id}/moderation/bans`, { steam: BOB, minutes: 60, reason: "x" })).body.error).toMatch(/didn't respond/);
    sa = keep;
  });

  it("only the Owner manages in-game admins", async () => {
    const c = await login();
    await call(c, "POST", "/api/users", { steam: ADMIN, role: "admin" });
    const s = await runningServer(c);
    installSimpleAdmin(s.id, s.slug);
    const a = await login(ADMIN);
    const body = { steam: ALICE, name: "Alice", flags: "@css/generic,@css/kick", immunity: 10, minutes: 0 };
    expect((await call(a, "POST", `/api/servers/${s.id}/moderation/admins`, body)).status).toBe(403);
    expect((await call(c, "POST", `/api/servers/${s.id}/moderation/admins`, { ...body, flags: "@css/root; quit" })).status).toBe(400);
    expect((await call(c, "POST", `/api/servers/${s.id}/moderation/admins`, body)).status).toBe(200);
    expect(commands).toContain(`css_addadmin ${ALICE} "Alice" @css/generic,@css/kick 10 0`);
    const admins = (await call(a, "GET", `/api/servers/${s.id}/moderation/admins`)).body.admins;
    expect(admins).toEqual([{ steamId: ALICE, name: "Alice", flags: ["@css/generic", "@css/kick"], group: null, immunity: 10, endsAt: null }]);
    expect((await call(c, "DELETE", `/api/servers/${s.id}/moderation/admins/${ALICE}`)).status).toBe(200);
    expect((await call(c, "GET", `/api/servers/${s.id}/moderation/admins`)).body.admins).toEqual([]);
  });
});
