import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";

const OWNER = "76561198000000001";
const ADMIN = "76561198000000002";
const MOD = "76561198000000003";

let dir: string;
let app: App;
let host: FakeHost;
let rconLog: string[];

const profileXml = (id: string, name: string) =>
  `<profile><steamID64>${id}</steamID64><steamID><![CDATA[${name}]]></steamID><avatarMedium>https://a/${id}.jpg</avatarMedium></profile>`;

async function setup(opts: { baseInstalled?: boolean } = {}) {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-test-"));
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
  if (opts.baseInstalled !== false) installFakeBase(config.cs2Root);
  host = new FakeHost(config.cs2Root, config.instanceEnvDir);
  rconLog = [];
  const fetchFn = (async (url: string | URL | Request) => {
    const m = /profiles\/(\d+)|id\/(\w+)/.exec(String(url));
    return new Response(profileXml(m?.[1] ?? ADMIN, m?.[1] ? `Name ${m[1].slice(-1)}` : "Vanity"));
  }) as typeof fetch;
  app = await buildApp({
    config,
    db: openDb(path.join(dir, "panel.db")),
    host,
    fetchFn,
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    rcon: async (o, cmd) => {
      rconLog.push(`${o.port}:${cmd}`);
      return `ok ${cmd}`;
    },
  });
  return config;
}

async function login(steamId = OWNER): Promise<string> {
  const res = await app.fastify.inject({ method: "GET", url: `/api/auth/dev?steamId=${steamId}` });
  expect(res.statusCode).toBe(302);
  const cookie = res.cookies.find((c) => c.name === "cs2p_session");
  return `cs2p_session=${cookie!.value}`;
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

async function presetId(cookie: string, key: string): Promise<number> {
  const { body } = await call(cookie, "GET", "/api/presets");
  return body.presets.find((p: { key: string }) => p.key === key).id;
}

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await app.fastify.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth", () => {
  it("requires a session", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/api/servers" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the owner with all permissions", async () => {
    const c = await login();
    const { body } = await call(c, "GET", "/api/me");
    expect(body.user.steamId).toBe(OWNER);
    expect(body.user.role).toBe("owner");
    expect(body.permissions).toContain("users.manage");
  });

  it("blocks cross-site state changes", async () => {
    const c = await login();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: c, host: "panel.lan", origin: "http://evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("stores display preferences per user, defaulting to 24-hour time", async () => {
    const c = await login();
    expect((await call(c, "GET", "/api/me")).body.user.prefs).toEqual({ timeFormat: "24h", dateFormat: "dmy" });
    expect((await call(c, "PUT", "/api/me/prefs", { timeFormat: "12h", dateFormat: "ymd" })).status).toBe(200);
    expect((await call(c, "GET", "/api/me")).body.user.prefs).toEqual({ timeFormat: "12h", dateFormat: "ymd" });
    expect((await call(c, "PUT", "/api/me/prefs", { timeFormat: "25h" })).status).toBe(400);
  });

  it("logs out", async () => {
    const c = await login();
    await call(c, "POST", "/api/auth/logout", {});
    expect((await call(c, "GET", "/api/me")).status).toBe(401);
  });
});

describe("team management", () => {
  it("owner adds, changes, disables and removes admins; all audited", async () => {
    const c = await login();
    const add = await call(c, "POST", "/api/users", { steam: `https://steamcommunity.com/profiles/${ADMIN}`, role: "admin" });
    expect(add.status).toBe(200);
    expect(add.body.user.displayName).toBe("Name 2");
    const id = add.body.user.id;

    expect((await call(c, "POST", "/api/users", { steam: ADMIN, role: "admin" })).body.error).toMatch(/already/);

    const adminCookie = await login(ADMIN);
    expect((await call(adminCookie, "GET", "/api/me")).body.user.role).toBe("admin");
    expect((await call(adminCookie, "GET", "/api/users")).status).toBe(403);

    expect((await call(c, "PATCH", `/api/users/${id}`, { role: "moderator" })).body.user.role).toBe("moderator");
    await call(c, "PATCH", `/api/users/${id}`, { disabled: true });
    expect((await call(adminCookie, "GET", "/api/me")).status).toBe(401);

    expect((await call(c, "DELETE", `/api/users/${id}`)).status).toBe(200);
    // Can be re-added after removal.
    expect((await call(c, "POST", "/api/users", { steam: ADMIN, role: "moderator" })).status).toBe(200);

    const actions = (await call(c, "GET", "/api/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["user.add", "user.update", "user.remove"]));
  });

  it("the owner can't be demoted or removed", async () => {
    const c = await login();
    const owner = (await call(c, "GET", "/api/me")).body.user;
    expect((await call(c, "PATCH", `/api/users/${owner.id}`, { role: "admin" })).status).toBe(400);
    expect((await call(c, "DELETE", `/api/users/${owner.id}`)).status).toBe(400);
  });
});

describe("servers", () => {
  it("creates a server with files, launch env and service enabled", async () => {
    const c = await login();
    const pid = await presetId(c, "competitive");
    const res = await call(c, "POST", "/api/servers", { name: "Comp #1", presetId: pid, port: 27015, gsltToken: "ABCDEF0123456789", password: "pw1" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = res.body.server;
    expect(s.slug).toBe("comp-1");
    expect(s.map).toBe("de_mirage");
    expect(s.maxPlayers).toBe(10);
    expect(s.gsltHint).toBe("…6789");
    expect(s).not.toHaveProperty("rconPassword");
    expect(s).not.toHaveProperty("gsltToken");

    const cfg = app.services.servers.require(s.id);
    const env = readFileSync(path.join(dir, "env", "comp-1.env"), "utf8");
    expect(env).toContain("CS2_CPU=0");
    expect(env).toContain("+ip 0.0.0.0 -port 27015 -usercon -maxplayers 10 +game_type 0 +game_mode 1 +exec cs2panel_generated.cfg +sv_setsteamaccount ABCDEF0123456789 +map de_mirage");
    const generated = readFileSync(path.join(dir, "cs2/instances/comp-1/upper/game/csgo/cfg/cs2panel_generated.cfg"), "utf8");
    expect(generated).toContain('hostname "Comp #1"');
    expect(generated).toContain('sv_password "pw1"');
    expect(generated).toContain(`rcon_password "${cfg.rconPassword}"`);
    expect(existsSync(path.join(dir, "cs2/instances/comp-1/upper/game/csgo/cfg/server.cfg"))).toBe(true);
    expect(host.calls).toEqual(["mount comp-1", "enable comp-1"]);

    // Secrets are encrypted in the database.
    const db = readFileSync(path.join(dir, "panel.db")).toString("latin1");
    expect(db).not.toContain("ABCDEF0123456789");
  });

  it("validates ports manually chosen by the admin", async () => {
    const c = await login();
    const pid = await presetId(c, "casual");
    expect((await call(c, "POST", "/api/servers", { name: "A", presetId: pid, port: 27015 })).status).toBe(200);
    expect((await call(c, "POST", "/api/servers", { name: "B", presetId: pid, port: 27015 })).body.error).toMatch(/already used by "A"/);
    expect((await call(c, "POST", "/api/servers", { name: "B", presetId: pid, port: 27018 })).body.error).toMatch(/too close/);
    host.busyPorts.add(27045);
    expect((await call(c, "POST", "/api/servers", { name: "B", presetId: pid, port: 27045 })).body.error).toMatch(/another program/);
    expect((await call(c, "GET", "/api/ports/check?port=27025")).body.problem).toBeNull();
    expect((await call(c, "POST", "/api/servers", { name: "B", presetId: pid, port: 27025 })).status).toBe(200);
    expect((await call(c, "GET", "/api/host")).body.usedPorts.map((p: { port: number }) => p.port)).toEqual([27015, 27025]);
  });

  it("rejects duplicate short names and unsafe input", async () => {
    const c = await login();
    const pid = await presetId(c, "casual");
    await call(c, "POST", "/api/servers", { name: "Same", presetId: pid, port: 27015 });
    expect((await call(c, "POST", "/api/servers", { name: "Same", presetId: pid, port: 27025 })).status).toBe(409);
    expect((await call(c, "POST", "/api/servers", { name: 'x"; quit', presetId: pid, port: 27035 })).status).toBe(400);
    expect((await call(c, "POST", "/api/servers", { name: "Map", presetId: pid, port: 27035, map: "de_dust2; quit" })).status).toBe(400);
  });

  it("rolls back a create that fails half-way", async () => {
    const c = await login();
    const pid = await presetId(c, "casual");
    const orig = host.cs2ctl.bind(host);
    host.cs2ctl = async (verb, slug) => {
      if (verb === "enable") throw new Error("systemd said no");
      return orig(verb, slug);
    };
    const res = await call(c, "POST", "/api/servers", { name: "Broken", presetId: pid, port: 27015 });
    expect(res.body.error).toMatch(/systemd said no/);
    expect((await call(c, "GET", "/api/servers")).body.servers).toHaveLength(0);
    expect(host.calls).toContain("archive broken");
    // The slug is free again.
    host.cs2ctl = orig;
    expect((await call(c, "POST", "/api/servers", { name: "Broken", presetId: pid, port: 27015 })).status).toBe(200);
  });

  it("starts, stops and edits; port changes need a stopped server", async () => {
    const c = await login();
    const pid = await presetId(c, "casual");
    const id = (await call(c, "POST", "/api/servers", { name: "S", presetId: pid, port: 27015 })).body.server.id;
    expect((await call(c, "POST", `/api/servers/${id}/start`, {})).body.server.status.state).toBe("active");

    const edit = await call(c, "PATCH", `/api/servers/${id}`, { map: "de_nuke", port: 27025 });
    expect(edit.body.error).toMatch(/Stop the server/);
    const edit2 = await call(c, "PATCH", `/api/servers/${id}`, { map: "de_nuke", presetId: await presetId(c, "deathmatch") });
    expect(edit2.body.restartRequired).toBe(true);
    expect(edit2.body.server.gameType).toBe(1);
    expect(readFileSync(path.join(dir, "env", "s.env"), "utf8")).toContain("+game_type 1 +game_mode 2");

    await call(c, "POST", `/api/servers/${id}/stop`, {});
    expect((await call(c, "PATCH", `/api/servers/${id}`, { port: 27025 })).body.server.port).toBe(27025);
  });

  it("force stops a server, even during an update, and audits it", async () => {
    const c = await login();
    const pid = await presetId(c, "casual");
    const id = (await call(c, "POST", "/api/servers", { name: "Ghost", presetId: pid, port: 27015 })).body.server.id;
    await call(c, "POST", `/api/servers/${id}/start`, {});
    app.services.servers["gate"].busy = "a CS2 update";
    const res = await call(c, "POST", `/api/servers/${id}/kill`, {});
    expect(res.status).toBe(200);
    expect(res.body.server.status.state).toBe("inactive");
    expect(host.calls).toContain("kill ghost");
    expect((await call(c, "GET", `/api/audit?serverId=${id}`)).body.entries[0].action).toBe("server.kill");
    app.services.servers["gate"].busy = null;
  });

  it("moderators can't force stop", async () => {
    const c = await login();
    await call(c, "POST", "/api/users", { steam: MOD, role: "moderator" });
    const pid = await presetId(c, "casual");
    const id = (await call(c, "POST", "/api/servers", { name: "S", presetId: pid, port: 27015 })).body.server.id;
    expect((await call(await login(MOD), "POST", `/api/servers/${id}/kill`, {})).status).toBe(403);
  });

  it("only the owner sets raw launch args", async () => {
    const c = await login();
    await call(c, "POST", "/api/users", { steam: ADMIN, role: "admin" });
    const a = await login(ADMIN);
    const pid = await presetId(a, "casual");
    expect((await call(a, "POST", "/api/servers", { name: "S", presetId: pid, port: 27015, extraArgs: "+sv_infinite_ammo 1" })).status).toBe(403);
    const id = (await call(a, "POST", "/api/servers", { name: "S", presetId: pid, port: 27015 })).body.server.id;
    expect((await call(a, "PATCH", `/api/servers/${id}`, { extraArgs: "+tv_enable 1" })).status).toBe(403);
    expect((await call(c, "PATCH", `/api/servers/${id}`, { extraArgs: "+tv_enable 1" })).status).toBe(200);
  });

  it("moderators can view but not change servers", async () => {
    const c = await login();
    await call(c, "POST", "/api/users", { steam: MOD, role: "moderator" });
    const pid = await presetId(c, "casual");
    const id = (await call(c, "POST", "/api/servers", { name: "S", presetId: pid, port: 27015, password: "secret" })).body.server.id;
    const m = await login(MOD);
    expect((await call(m, "GET", "/api/servers")).status).toBe(200);
    expect((await call(m, "GET", `/api/servers/${id}`)).body.server.password).toBe("••••");
    expect((await call(m, "POST", `/api/servers/${id}/start`, {})).status).toBe(403);
    expect((await call(m, "POST", "/api/servers", { name: "X", presetId: pid, port: 27025 })).status).toBe(403);
    expect((await call(m, "POST", `/api/servers/${id}/rcon`, { command: "status" })).status).toBe(403);
  });

  it("duplicates a server with its configs but new secrets", async () => {
    const c = await login();
    const pid = await presetId(c, "competitive");
    const src = (await call(c, "POST", "/api/servers", { name: "Src", presetId: pid, port: 27015 })).body.server;
    await call(c, "PUT", `/api/servers/${src.id}/configs/file`, { path: "cfg/custom.cfg", content: "sv_gravity 300\n" });
    const dup = await call(c, "POST", `/api/servers/${src.id}/duplicate`, { name: "Copy", port: 27025 });
    expect(dup.status, JSON.stringify(dup.body)).toBe(200);
    expect(dup.body.server.map).toBe(src.map);
    expect(readFileSync(path.join(dir, "cs2/instances/copy/upper/game/csgo/cfg/custom.cfg"), "utf8")).toBe("sv_gravity 300\n");
    const a = app.services.servers.require(src.id);
    const b = app.services.servers.require(dup.body.server.id);
    expect(b.rconPassword).not.toBe(a.rconPassword);
    expect(readFileSync(path.join(dir, "cs2/instances/copy/upper/game/csgo/cfg/cs2panel_generated.cfg"), "utf8")).toContain('hostname "Copy"');
  });

  it("delete is owner-only and needs the short name typed", async () => {
    const c = await login();
    await call(c, "POST", "/api/users", { steam: ADMIN, role: "admin" });
    const pid = await presetId(c, "casual");
    const id = (await call(c, "POST", "/api/servers", { name: "Gone", presetId: pid, port: 27015 })).body.server.id;
    const a = await login(ADMIN);
    expect((await call(a, "DELETE", `/api/servers/${id}`, { confirm: "gone" })).status).toBe(403);
    expect((await call(c, "DELETE", `/api/servers/${id}`, { confirm: "wrong" })).status).toBe(400);
    expect((await call(c, "DELETE", `/api/servers/${id}`, { confirm: "gone" })).status).toBe(200);
    expect(host.calls).toContain("archive gone");
    expect((await call(c, "GET", "/api/servers")).body.servers).toHaveLength(0);
    // Port and short name are free again.
    expect((await call(c, "POST", "/api/servers", { name: "Gone", presetId: pid, port: 27015 })).status).toBe(200);
  });

  it("sends RCON commands and audits them", async () => {
    const c = await login();
    const pid = await presetId(c, "casual");
    const id = (await call(c, "POST", "/api/servers", { name: "S", presetId: pid, port: 27015 })).body.server.id;
    expect((await call(c, "POST", `/api/servers/${id}/rcon`, { command: "status" })).body.output).toBe("ok status");
    const entry = (await call(c, "GET", `/api/audit?serverId=${id}`)).body.entries[0];
    expect(entry.action).toBe("server.rcon");
    expect(entry.details.command).toBe("status");
  });
});

describe("config editor", () => {
  it("lists stock and server files, saves with history, reverts and rolls back", async () => {
    const c = await login();
    const pid = await presetId(c, "competitive");
    const id = (await call(c, "POST", "/api/servers", { name: "S", presetId: pid, port: 27015 })).body.server.id;

    const list = (await call(c, "GET", `/api/servers/${id}/configs`)).body.files;
    const byPath = Object.fromEntries(list.map((f: { path: string }) => [f.path, f]));
    expect(byPath["cfg/gamemode_competitive.cfg"].source).toBe("stock");
    expect(byPath["cfg/server.cfg"].source).toBe("custom");
    expect(byPath["cfg/cs2panel_generated.cfg"].readOnly).toBe(true);

    // Edit a stock file: creates the server's own copy, baseline revision recorded.
    const save = await call(c, "PUT", `/api/servers/${id}/configs/file`, {
      path: "cfg/gamemode_competitive.cfg",
      content: "mp_maxrounds 30\n",
      comment: "MR15",
    });
    expect(save.body.changed).toBe(true);
    expect(save.body.file.source).toBe("modified");
    expect(save.body.file.revisions.map((r: { comment: string }) => r.comment)).toEqual(["MR15", "Original (stock)"]);

    // Saving identical content is a no-op.
    expect((await call(c, "PUT", `/api/servers/${id}/configs/file`, { path: "cfg/gamemode_competitive.cfg", content: "mp_maxrounds 30\n" })).body.changed).toBe(false);

    // Revert to stock.
    expect((await call(c, "DELETE", `/api/servers/${id}/configs/file?path=cfg/gamemode_competitive.cfg`)).body.result).toBe("stock");
    let file = (await call(c, "GET", `/api/servers/${id}/configs/file?path=cfg/gamemode_competitive.cfg`)).body;
    expect(file.source).toBe("stock");
    const mr15 = file.revisions.find((r: { comment: string }) => r.comment === "MR15");

    // Roll back to the MR15 revision.
    await call(c, "POST", `/api/servers/${id}/configs/rollback`, { revisionId: mr15.id });
    file = (await call(c, "GET", `/api/servers/${id}/configs/file?path=cfg/gamemode_competitive.cfg`)).body;
    expect(file.content).toBe("mp_maxrounds 30\n");

    // Rolling back to the original stock content returns to stock instead of keeping a copy.
    const original = file.revisions.find((r: { comment: string }) => r.comment === "Original (stock)");
    await call(c, "POST", `/api/servers/${id}/configs/rollback`, { revisionId: original.id });
    file = (await call(c, "GET", `/api/servers/${id}/configs/file?path=cfg/gamemode_competitive.cfg`)).body;
    expect(file.source).toBe("stock");
  });

  it("refuses the generated file, bad paths and symlinks", async () => {
    const c = await login();
    const pid = await presetId(c, "casual");
    const id = (await call(c, "POST", "/api/servers", { name: "S", presetId: pid, port: 27015 })).body.server.id;
    expect((await call(c, "PUT", `/api/servers/${id}/configs/file`, { path: "cfg/cs2panel_generated.cfg", content: "x" })).status).toBe(400);
    expect((await call(c, "PUT", `/api/servers/${id}/configs/file`, { path: "cfg/../../../../etc/x.cfg", content: "x" })).status).toBe(400);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(tmpdir(), path.join(dir, "cs2/instances/s/upper/game/csgo/cfg/link"));
    expect((await call(c, "PUT", `/api/servers/${id}/configs/file`, { path: "cfg/link/evil.cfg", content: "x" })).body.error).toMatch(/Symbolic/);
  });

  it("never deletes through a mounted overlay; reverting a stock file while running is finished on the next start", async () => {
    const c = await login();
    const pid = await presetId(c, "competitive");
    const id = (await call(c, "POST", "/api/servers", { name: "S", presetId: pid, port: 27015 })).body.server.id;
    await call(c, "POST", `/api/servers/${id}/start`, {});
    expect(host.mounted.has("s")).toBe(true);
    const f = "cfg/gamemode_competitive.cfg";
    const upperCopy = path.join(dir, "cs2/instances/s/upper/game/csgo", f);
    await call(c, "PUT", `/api/servers/${id}/configs/file`, { path: f, content: "mp_maxrounds 30\n" });
    expect(readFileSync(upperCopy, "utf8")).toBe("mp_maxrounds 30\n");

    // Revert while running: the copy now holds the stock text, and the UI calls it stock.
    expect((await call(c, "DELETE", `/api/servers/${id}/configs/file?path=${f}`)).body.result).toBe("stock");
    expect(existsSync(upperCopy)).toBe(true);
    expect((await call(c, "GET", `/api/servers/${id}/configs/file?path=${f}`)).body.source).toBe("stock");

    // Restart: unmount, drop the identical copy, start again.
    await call(c, "POST", `/api/servers/${id}/restart`, {});
    expect(existsSync(upperCopy)).toBe(false);
    expect(host.running.has("s")).toBe(true);
    const order = host.calls.slice(host.calls.lastIndexOf("stop s"));
    expect(order).toEqual(["stop s", "umount s", "start s"]);
  });

  it("can exec a saved cfg on a running server", async () => {
    const c = await login();
    const pid = await presetId(c, "casual");
    const id = (await call(c, "POST", "/api/servers", { name: "S", presetId: pid, port: 27015 })).body.server.id;
    await call(c, "POST", `/api/servers/${id}/start`, {});
    const res = await call(c, "PUT", `/api/servers/${id}/configs/file`, { path: "cfg/practice.cfg", content: "sv_cheats 1\n", apply: "exec" });
    expect(res.body.applied).toBe("executed");
    expect(rconLog).toContain("27015:exec practice");
  });
});

describe("game update", () => {
  async function waitForJob(c: string) {
    for (let i = 0; i < 100; i++) {
      const { body } = await call(c, "GET", "/api/game");
      if (body.job.state !== "running") return body;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("update did not finish");
  }

  it("stops all servers, updates, re-patches gameinfo for Metamod servers and restarts the running ones", async () => {
    const c = await login();
    const pid = await presetId(c, "casual");
    const a = (await call(c, "POST", "/api/servers", { name: "A", presetId: pid, port: 27015 })).body.server;
    const b = (await call(c, "POST", "/api/servers", { name: "B", presetId: pid, port: 27025 })).body.server;
    await call(c, "POST", `/api/servers/${a.id}/start`, {});
    // Pretend B has Metamod installed, plus a stray file that shadows the base.
    mkdirSync(path.join(dir, "cs2/instances/b/upper/game/csgo/addons/metamod"), { recursive: true });
    writeFileSync(path.join(dir, "cs2/instances/b/upper/game/csgo/steam.inf"), "stale");

    expect((await call(c, "POST", "/api/game/update", { warnSeconds: 0 })).status).toBe(200);
    // Server actions are blocked while it runs.
    expect((await call(c, "POST", `/api/servers/${b.id}/start`, {})).status).toBe(409);
    const done = await waitForJob(c);
    expect(done.job.state).toBe("succeeded");
    const text = done.lines.join("\n");
    expect(text).toContain("A: started");
    expect(text).toContain("B: gameinfo.gi regenerated with Metamod");
    expect(text).toMatch(/B: WARNING game\/csgo\/steam.inf overrides a CS2 file/);

    expect(host.running.has("a")).toBe(true);
    expect(host.running.has("b")).toBe(false);
    expect(readFileSync(path.join(dir, "cs2/instances/b/upper/game/csgo/gameinfo.gi"), "utf8")).toContain("csgo/addons/metamod");
    expect(existsSync(path.join(dir, "cs2/instances/a/upper/game/csgo/gameinfo.gi"))).toBe(false);
    // Unmount happened before steam-update.
    expect(host.calls.indexOf("umount a")).toBeLessThan(host.calls.indexOf("steam-update"));
  });

  it("warns players over RCON before stopping", async () => {
    const c = await login();
    const pid = await presetId(c, "casual");
    const a = (await call(c, "POST", "/api/servers", { name: "A", presetId: pid, port: 27015 })).body.server;
    await call(c, "POST", `/api/servers/${a.id}/start`, {});
    await call(c, "POST", "/api/game/update", { warnSeconds: 1 });
    await waitForJob(c);
    expect(rconLog[0]).toMatch(/^27015:say Server restarting in 1 seconds/);
  });
});

describe("first install", () => {
  it("creates servers before CS2 is installed and mounts them after the first update", async () => {
    await app.fastify.close();
    rmSync(dir, { recursive: true, force: true });
    await setup({ baseInstalled: false });
    const c = await login();
    expect((await call(c, "GET", "/api/host")).body.cs2.installed).toBe(false);
    const pid = await presetId(c, "casual");
    const s = (await call(c, "POST", "/api/servers", { name: "Early", presetId: pid, port: 27015 })).body.server;
    expect(host.calls).not.toContain("mount early");
    expect((await call(c, "POST", `/api/servers/${s.id}/start`, {})).body.error).toMatch(/isn't installed/);
    await call(c, "POST", "/api/game/update", { warnSeconds: 0 });
    for (let i = 0; i < 100 && (await call(c, "GET", "/api/game")).body.job.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect((await call(c, "GET", "/api/host")).body.cs2.patchVersion).toBe("1.40.9.1");
    expect(host.mounted.has("early")).toBe(true);
  });
});
