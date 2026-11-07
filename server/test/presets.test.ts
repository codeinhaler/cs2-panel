import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { withBlock, modeServerCfg } from "../src/servers/exec-configs.js";
import { fakeSteamWorkshop } from "./fake-steam.js";

const OWNER = "76561198000000001";
const MOD = "76561198000000003";

describe("exec block", () => {
  it("adds, replaces and removes the panel's block without touching the rest", () => {
    const a = withBlock("mp_maxrounds 30\n", ["practice.cfg", "nades/smokes.cfg"]);
    expect(a).toContain("mp_maxrounds 30\n\n// ---- cs2-panel");
    expect(a).toContain("exec practice\nexec nades/smokes\n");
    const b = withBlock(a, ["knife.cfg"]);
    expect(b).not.toContain("exec practice");
    expect(b.match(/cs2-panel:/g)).toHaveLength(1);
    expect(withBlock(b, [])).toBe("mp_maxrounds 30\n");
    expect(withBlock("", [])).toBe("");
    expect(modeServerCfg(0, 1)).toBe("gamemode_competitive_server.cfg");
    expect(modeServerCfg(0, 2)).toBe("gamemode_competitive2v2_server.cfg");
    expect(modeServerCfg(9, 9)).toBe("server.cfg");
  });
});

let dir: string;
let app: App;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-presets-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    ownerSteamId: OWNER,
    secretKey: "66".repeat(32),
    dataDir: dir,
    cs2Root: path.join(dir, "cs2"),
    instanceEnvDir: path.join(dir, "env"),
    cs2ctl: "/bin/false",
    webDir: path.join(dir, "no-web"),
    bridgeDir: path.join(dir, "no-bridge"),
    dev: true,
  };
  installFakeBase(config.cs2Root);
  app = await buildApp({
    config,
    db: openDb(path.join(dir, "panel.db")),
    host: new FakeHost(config.cs2Root, config.instanceEnvDir),
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => (await fakeSteamWorkshop(url, init)) ?? new Response("", { status: 404 })) as typeof fetch,
    rcon: async () => "",
  });
});

afterEach(async () => {
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
const readCfg = async (c: string, id: number, file: string) =>
  ((await call(c, "GET", `/api/servers/${id}/configs/file?path=${encodeURIComponent(`cfg/${file}`)}`)).body.content as string | null) ?? "";

const PRACTICE = {
  name: "Practice",
  description: "Competitive rules, infinite money",
  gameType: 0,
  gameMode: 1,
  defaultMap: "de_mirage",
  maxPlayers: 10,
  configFiles: { "server.cfg": "sv_hibernate_when_empty 0\n", "practice.cfg": "sv_cheats 1\nmp_maxmoney 60000\n" },
  execConfigs: ["practice.cfg"],
};

describe("custom presets", () => {
  it("creates, edits and deletes presets; built-in ones are read-only", async () => {
    const c = await login();
    const created = await call(c, "POST", "/api/presets", PRACTICE);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.preset).toMatchObject({ name: "Practice", builtin: false, execConfigs: ["practice.cfg"] });
    const id = created.body.preset.id;
    expect((await call(c, "POST", "/api/presets", { ...PRACTICE, name: "practice" })).body.error).toMatch(/already a preset/);
    expect((await call(c, "POST", "/api/presets", { ...PRACTICE, name: "X", defaultMap: "workshop:3094994703" })).body.error).toMatch(/removed/);
    expect((await call(c, "POST", "/api/presets", { ...PRACTICE, name: "Y", execConfigs: ["server.cfg"] })).status).toBe(400);
    expect((await call(c, "POST", "/api/presets", { ...PRACTICE, name: "Z", configFiles: { "../evil.cfg": "" } })).status).toBe(400);

    const edited = await call(c, "PUT", `/api/presets/${id}`, { ...PRACTICE, maxPlayers: 12 });
    expect(edited.body.preset.maxPlayers).toBe(12);

    const builtin = (await call(c, "GET", "/api/presets")).body.presets.find((p: { builtin: boolean }) => p.builtin);
    expect((await call(c, "PUT", `/api/presets/${builtin.id}`, PRACTICE)).body.error).toMatch(/Built-in/);
    expect((await call(c, "DELETE", `/api/presets/${builtin.id}`)).status).toBe(400);

    expect((await call(c, "DELETE", `/api/presets/${id}`)).body).toEqual({ serversUsing: 0 });
    const actions = (await call(c, "GET", "/api/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(actions.slice(0, 3)).toEqual(["preset.delete", "preset.update", "preset.create"]);
  });

  it("a server made from a preset gets its files and runs its configs on every map start", async () => {
    const c = await login();
    const preset = (await call(c, "POST", "/api/presets", PRACTICE)).body.preset;
    const s = (await call(c, "POST", "/api/servers", { name: "Prac", presetId: preset.id, port: 27015 })).body.server;
    expect(s).toMatchObject({ map: "de_mirage", maxPlayers: 10, gameMode: 1 });
    expect(await readCfg(c, s.id, "practice.cfg")).toContain("mp_maxmoney 60000");
    expect(await readCfg(c, s.id, "gamemode_competitive_server.cfg")).toContain("exec practice");
    expect((await call(c, "GET", `/api/servers/${s.id}`)).body.execConfigs).toEqual(["practice.cfg"]);

    // Switching game mode moves the block to the new mode's file.
    const casual = (await call(c, "GET", "/api/presets")).body.presets.find((p: { key: string }) => p.key === "casual");
    await call(c, "PATCH", `/api/servers/${s.id}`, { presetId: casual.id });
    expect(await readCfg(c, s.id, "gamemode_casual_server.cfg")).toContain("exec practice");
    expect(await readCfg(c, s.id, "gamemode_competitive_server.cfg")).not.toContain("exec practice");

    // Deleting the preset leaves servers alone.
    const used = (await call(c, "POST", "/api/presets", { ...PRACTICE, name: "Used" })).body.preset;
    await call(c, "PATCH", `/api/servers/${s.id}`, { presetId: used.id });
    expect((await call(c, "DELETE", `/api/presets/${used.id}`)).body).toEqual({ serversUsing: 1 });
    expect((await call(c, "GET", `/api/servers/${s.id}`)).body.server.presetName).toBeNull();
  });

  it("sets configs to run per server", async () => {
    const c = await login();
    const casual = (await call(c, "GET", "/api/presets")).body.presets.find((p: { key: string }) => p.key === "casual");
    const s = (await call(c, "POST", "/api/servers", { name: "A", presetId: casual.id, port: 27015 })).body.server;
    expect((await call(c, "PUT", `/api/servers/${s.id}/exec-configs`, { configs: ["knife.cfg"] })).body.error).toMatch(/no cfg\/knife.cfg/);
    await call(c, "PUT", `/api/servers/${s.id}/configs/file`, { path: "cfg/knife.cfg", content: "mp_ct_default_secondary \"\"\n" });
    expect((await call(c, "PUT", `/api/servers/${s.id}/exec-configs`, { configs: ["knife.cfg"] })).body.execConfigs).toEqual(["knife.cfg"]);
    expect(await readCfg(c, s.id, "gamemode_casual_server.cfg")).toContain("exec knife");
    expect((await call(c, "PUT", `/api/servers/${s.id}/exec-configs`, { configs: ["gamemode_casual_server.cfg"] })).status).toBe(400);
    await call(c, "PUT", `/api/servers/${s.id}/exec-configs`, { configs: [] });
    expect(await readCfg(c, s.id, "gamemode_casual_server.cfg")).not.toContain("cs2-panel");
  });

  it("saves a server as a preset", async () => {
    const c = await login();
    const casual = (await call(c, "GET", "/api/presets")).body.presets.find((p: { key: string }) => p.key === "casual");
    const s = (await call(c, "POST", "/api/servers", { name: "Fun", presetId: casual.id, port: 27015, map: "de_inferno", maxPlayers: 16 })).body.server;
    await call(c, "PUT", `/api/servers/${s.id}/configs/file`, { path: "cfg/fun.cfg", content: "sv_gravity 300\n" });
    await call(c, "PUT", `/api/servers/${s.id}/exec-configs`, { configs: ["fun.cfg"] });
    const r = await call(c, "POST", `/api/servers/${s.id}/save-preset`, { name: "Low gravity", description: "Bouncy" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.preset).toMatchObject({ name: "Low gravity", gameType: 0, gameMode: 0, defaultMap: "de_inferno", maxPlayers: 16, execConfigs: ["fun.cfg"] });
    expect(r.body.preset.configFiles["fun.cfg"]).toBe("sv_gravity 300\n");
    expect(r.body.preset.configFiles["server.cfg"]).toContain("sv_hibernate_when_empty 0");
    // The panel's exec block isn't copied as file content; it comes back from execConfigs.
    expect(JSON.stringify(r.body.preset.configFiles)).not.toContain("cs2-panel:");
  });

  it("only shows the GSLT to those who may change it, and checks permissions", async () => {
    const c = await login();
    const casual = (await call(c, "GET", "/api/presets")).body.presets.find((p: { key: string }) => p.key === "casual");
    const s = (await call(c, "POST", "/api/servers", { name: "A", presetId: casual.id, port: 27015, gsltToken: "ABCDEF1234567890" })).body.server;
    expect((await call(c, "GET", `/api/servers/${s.id}`)).body.gslt).toBe("ABCDEF1234567890");
    await call(c, "POST", "/api/users", { steam: MOD, role: "moderator" });
    const m = await login(MOD);
    const asMod = (await call(m, "GET", `/api/servers/${s.id}`)).body;
    expect(asMod.gslt).toBeUndefined();
    expect(asMod.server.gsltHint).toBe("…7890");
    expect((await call(m, "POST", "/api/presets", PRACTICE)).status).toBe(403);
    expect((await call(m, "POST", `/api/servers/${s.id}/save-preset`, { name: "x" })).status).toBe(403);
    expect((await call(m, "PUT", `/api/servers/${s.id}/exec-configs`, { configs: [] })).status).toBe(403);
  });
});
