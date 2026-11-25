import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { builtInTitle, parseActions } from "../src/ingame/admins.js";

const OWNER = "76561198000000001";
const MOD = "76561198000000003";
const ALICE = "76561198000000101";
const BOB = "76561198000000102";

let dir: string;
let app: App;
let host: FakeHost;
let rconLog: string[];
let actionsReply: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-ingame-"));
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
  const maps = path.join(config.cs2Root, "base", "game", "csgo", "maps");
  mkdirSync(maps, { recursive: true });
  for (const m of ["de_dust2", "de_mirage", "cs_office", "de_dust2_vanity"]) writeFileSync(path.join(maps, `${m}.vpk`), "");
  rconLog = [];
  actionsReply = "CS2PANEL_ACTIONS []";
  host = new FakeHost(config.cs2Root, config.instanceEnvDir);
  app = await buildApp({
    config,
    db: openDb(path.join(dir, "panel.db")),
    host,
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    a2sQuery: async () => ({ name: "t", map: "de_dust2", players: 0, maxPlayers: 10, bots: 0, version: "1" }),
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname === "api.steampowered.com") {
        if (u.pathname.includes("GetCollectionDetails")) return Response.json({ response: { collectiondetails: [{ result: 9 }] } });
        const id = new URLSearchParams(String(init?.body ?? "")).get("publishedfileids[0]");
        const d = id === "111" ? { result: 1, title: "Aim Botz", consumer_app_id: 730, visibility: 0 } : { result: 9 };
        return Response.json({ response: { publishedfiledetails: [d] } });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
    rcon: async (_o, cmd) => {
      rconLog.push(cmd);
      if (cmd === "cs2panel_actions") {
        // Like the bridge: handed over once.
        const r = actionsReply;
        actionsReply = "CS2PANEL_ACTIONS []";
        return r;
      }
      return `ok ${cmd}`;
    },
  });
});

afterEach(async () => {
  await app.fastify.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login(steamId = OWNER): Promise<string> {
  const res = await app.fastify.inject({ method: "GET", url: `/api/auth/dev?steamId=${steamId}` });
  return `cs2p_session=${res.cookies.find((c) => c.name === "cs2p_session")!.value}`;
}
async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.fastify.inject({ method: method as "GET", url, headers: { cookie }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}
async function newServer(c: string, name: string, port: number, bridge = true): Promise<{ id: number; slug: string }> {
  const presets = (await call(c, "GET", "/api/presets")).body.presets;
  const res = await call(c, "POST", "/api/servers", { name, presetId: presets[0].id, port });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const s = res.body.server as { id: number; slug: string };
  if (bridge) {
    (app.services.servers as any).store.db
      .prepare("INSERT INTO plugin_installs (server_id, plugin_id, name, version, asset) VALUES (?, 'cs2panel-bridge', 'CS2 Panel Bridge', 'dev', 'x')")
      .run(s.id);
  }
  return s;
}
function adminsFile(slug: string): any {
  const find = (d: string): string | null => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) {
        const f = find(p);
        if (f) return f;
      } else if (n === "admins.json" && p.includes(`/${slug}/`)) return p;
    }
    return null;
  };
  const f = find(dir);
  return f ? JSON.parse(readFileSync(f, "utf8")) : null;
}

describe("in-game admins", () => {
  it("ships three roles, and checks roles and people", async () => {
    const c = await login();
    const info = (await call(c, "GET", "/api/ingame")).body;
    expect(info.roles.map((r: any) => [r.name, r.perms])).toEqual([
      ["Map changer", ["map"]],
      ["Moderator", ["map", "restart", "kick"]],
      ["Admin", ["map", "restart", "kick", "cvar", "rcon", "interrupt"]],
    ]);
    expect(info.perms.map((p: any) => p.id)).toEqual(["map", "restart", "kick", "cvar", "rcon", "interrupt"]);

    expect((await call(c, "POST", "/api/ingame/roles", { name: "Odd", perms: ["fly"] })).status).toBe(400);
    expect((await call(c, "POST", "/api/ingame/roles", { name: "Empty", perms: [] })).status).toBe(400);
    expect((await call(c, "POST", "/api/ingame/roles", { name: "map changer", perms: ["map"] })).body.error).toMatch(/already a role/);
    const role = (await call(c, "POST", "/api/ingame/roles", { name: "Kicker", perms: ["kick", "map"] })).body.role;
    expect(role.perms).toEqual(["map", "kick"]);

    expect((await call(c, "POST", "/api/ingame/admins", { steam: "123", roleId: role.id, serverId: null })).body.error).toMatch(/SteamID64/);
    const a = await call(c, "POST", "/api/ingame/admins", { steam: ALICE, name: "Alice", roleId: role.id, serverId: null });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect((await call(c, "POST", "/api/ingame/admins", { steam: ALICE, roleId: 1, serverId: null })).body.error).toMatch(/already has a role/);
    // A role in use can't be deleted.
    expect((await call(c, "DELETE", `/api/ingame/roles/${role.id}`)).body.error).toMatch(/Give them another role first/);

    // Only the Owner changes them; others may look.
    await call(c, "POST", "/api/users", { steam: MOD, role: "admin" });
    const m = await login(MOD);
    expect((await call(m, "GET", "/api/ingame")).body.admins).toHaveLength(1);
    expect((await call(m, "POST", "/api/ingame/admins", { steam: BOB, roleId: 1, serverId: null })).status).toBe(403);
    expect((await call(m, "PUT", `/api/ingame/roles/${role.id}`, { name: "x", perms: ["map"] })).status).toBe(403);

    const audit = (await call(c, "GET", "/api/audit")).body.entries.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["ingame.role.add", "ingame.admin.add"]));
  });

  it("writes each bridge server its people and maps, and reloads running servers", async () => {
    const c = await login();
    const one = await newServer(c, "One", 27015);
    const two = await newServer(c, "Two", 27016);
    const plain = await newServer(c, "Plain", 27017, false);
    await call(c, "POST", "/api/ingame/admins", { steam: ALICE, name: "Alice", roleId: 1, serverId: null });
    await call(c, "POST", "/api/ingame/admins", { steam: ALICE, name: "Alice", roleId: 2, serverId: two.id });
    await call(c, "POST", "/api/ingame/admins", { steam: BOB, name: "Bob", roleId: 3, serverId: one.id, expiresAt: "2001-01-01T00:00:00Z" });
    expect((await call(c, "POST", "/api/ingame/maps", { id: "111" })).body.maps).toEqual([{ id: "111", title: "Aim Botz" }]);
    await app.services.ingame.sync();

    const f1 = adminsFile(one.slug);
    // Bob's role ended, so only Alice; maps by name, built-in first, Workshop by its Steam title.
    expect(f1.admins).toEqual([{ steamId: ALICE, name: "Alice", role: "Map changer", perms: ["map"], expiresAt: null }]);
    expect(f1.maps).toEqual([
      { map: "de_dust2", title: "Dust2" },
      { map: "de_mirage", title: "Mirage" },
      { map: "cs_office", title: "Office" },
      { workshop: "111", title: "Aim Botz" },
    ]);
    // On Two, Alice also has Moderator there: both merged.
    expect(adminsFile(two.slug).admins).toEqual([{ steamId: ALICE, name: "Alice", role: "Moderator", perms: ["map", "restart", "kick"], expiresAt: null }]);
    expect(adminsFile(plain.slug)).toBeNull();

    // Running servers reload a changed file and hand over what people did.
    await call(c, "POST", `/api/servers/${one.id}/start`, {});
    actionsReply = `junk\nCS2PANEL_ACTIONS ${JSON.stringify([
      { steamId: ALICE, name: "Alice", action: "map", detail: "Mirage (de_mirage)", match: true },
      { steamId: "x", name: "bad", action: "map" },
    ])}`;
    await call(c, "PUT", `/api/ingame/roles/1`, { name: "Map changer", perms: ["map", "restart"] });
    await app.services.ingame.sync();
    expect(rconLog).toContain("cs2panel_admins_reload");
    expect(adminsFile(one.slug).admins[0].perms).toEqual(["map", "restart"]);
    const entries = (await call(c, "GET", `/api/audit?serverId=${one.id}`)).body.entries;
    const act = entries.filter((e: any) => e.action === "ingame.action");
    expect(act).toHaveLength(1);
    expect(act[0].details).toEqual({ steamId: ALICE, name: "Alice", action: "map", detail: "Mirage (de_mirage)", duringMatch: true });

    // Nothing changed: no reload.
    rconLog.length = 0;
    actionsReply = "CS2PANEL_ACTIONS []";
    await app.services.ingame.sync();
    expect(rconLog).toEqual(["cs2panel_actions"]);
  });

  it("names maps and reads the bridge's actions", () => {
    expect(builtInTitle("de_dust2")).toBe("Dust2");
    expect(builtInTitle("ar_baggage")).toBe("Baggage");
    expect(builtInTitle("cs_italy")).toBe("Italy");
    expect(parseActions("nothing here")).toEqual([]);
    expect(parseActions("CS2PANEL_ACTIONS {broken")).toEqual([]);
    expect(parseActions(`CS2PANEL_ACTIONS [{"steamId":"${ALICE}","name":"A","action":"kick","detail":"Bob (1)"}]`)).toEqual([
      { steamId: ALICE, name: "A", action: "kick", detail: "Bob (1)", match: false },
    ]);
  });
});
