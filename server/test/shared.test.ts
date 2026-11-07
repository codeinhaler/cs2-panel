import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { validateCvars, withSharedBlock } from "../src/servers/shared-config.js";

const OWNER = "76561198000000001";
const MOD = "76561198000000003";

describe("shared settings helpers", () => {
  it("refuses commands the panel owns or that would run on every map start", () => {
    expect(validateCvars("sv_allow_votes 0\r\n// comment\nmp_autokick 0")).toBe("sv_allow_votes 0\n// comment\nmp_autokick 0\n");
    expect(() => validateCvars("mp_autokick 0\nrcon_password hunter2")).toThrow(/Line 2: rcon_password/);
    expect(() => validateCvars("sv_cheats 0; changelevel de_dust2")).toThrow(/every map start/);
    expect(() => validateCvars("HOSTNAME x")).toThrow(/hostname/);
    expect(validateCvars("   \n")).toBe("");
  });

  it("adds the exec block to the top of server.cfg once", () => {
    const once = withSharedBlock("sv_cheats 0\n");
    expect(once.startsWith("// ---- cs2-panel: shared settings")).toBe(true);
    expect(once).toContain("exec cs2panel_shared\n");
    expect(once.endsWith("sv_cheats 0\n")).toBe(true);
    expect(withSharedBlock(once)).toBe(once);
  });
});

let dir: string;
let app: App;
const rconSent: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-shared-"));
  rconSent.length = 0;
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    ownerSteamId: OWNER,
    secretKey: "aa".repeat(32),
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
    a2sQuery: async () => null,
    rcon: async (_o, cmd) => {
      rconSent.push(cmd);
      return "";
    },
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
async function newServer(c: string, name: string, port: number) {
  const presets = (await call(c, "GET", "/api/presets")).body.presets;
  return (await call(c, "POST", "/api/servers", { name, presetId: presets[0].id, port })).body.server as { id: number; slug: string };
}
const readCfg = async (c: string, id: number, file: string) =>
  ((await call(c, "GET", `/api/servers/${id}/configs/file?path=${encodeURIComponent(`cfg/${file}`)}`)).body.content as string | null) ?? "";

describe("shared settings", () => {
  it("applies the prefix, tags and cvars to every server that uses them, right away on running ones", async () => {
    const c = await login();
    const a = await newServer(c, "Fredag", 27015);
    const b = await newServer(c, "Test", 27025);
    await call(c, "POST", `/api/servers/${a.id}/start`, {});
    // Every server runs the shared file at the top of its server.cfg from the start.
    expect((await readCfg(c, a.id, "server.cfg")).startsWith("// ---- cs2-panel: shared settings")).toBe(true);

    const r = await call(c, "PUT", "/api/shared", { hostnamePrefix: "[Sune] ", tags: "casual, community ,", cvars: "sv_allow_votes 0\nmp_autokick 0", excluded: [b.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.shared).toMatchObject({ hostnamePrefix: "[Sune] ", tags: "casual,community", excluded: [b.id] });
    expect(r.body.liveOn).toEqual(["Fredag"]);
    expect(rconSent.at(-1)).toBe('hostname "[Sune] Fredag"; exec cs2panel_shared');

    const sharedA = await readCfg(c, a.id, "cs2panel_shared.cfg");
    expect(sharedA).toContain('sv_tags "casual,community"\nsv_allow_votes 0\nmp_autokick 0\n');
    expect(await readCfg(c, b.id, "cs2panel_shared.cfg")).toContain("doesn't use the shared settings");
    expect(await readCfg(c, a.id, "cs2panel_generated.cfg")).toContain('hostname "[Sune] Fredag"');
    expect(await readCfg(c, b.id, "cs2panel_generated.cfg")).toContain('hostname "Test"');
    expect((await readCfg(c, a.id, "server.cfg")).match(/cs2-panel: shared settings/g)).toHaveLength(1);

    const preview = (await call(c, "GET", "/api/shared")).body.preview;
    expect(preview).toEqual([
      { id: a.id, name: "Fredag", hostname: "[Sune] Fredag", uses: true },
      { id: b.id, name: "Test", hostname: "Test", uses: false },
    ]);

    // Renaming a server keeps the prefix.
    await call(c, "PATCH", `/api/servers/${a.id}`, { name: "Fredagsspiller" });
    expect(await readCfg(c, a.id, "cs2panel_generated.cfg")).toContain('hostname "[Sune] Fredagsspiller"');

    // A new server gets it straight away.
    const n = await newServer(c, "New", 27035);
    expect(await readCfg(c, n.id, "cs2panel_shared.cfg")).toContain("sv_allow_votes 0");
  });

  it("protects the shared file and checks input and permissions", async () => {
    const c = await login();
    const a = await newServer(c, "A", 27015);
    expect((await call(c, "PUT", `/api/servers/${a.id}/configs/file`, { path: "cfg/cs2panel_shared.cfg", content: "x" })).status).toBe(400);
    const files = (await call(c, "GET", `/api/servers/${a.id}/configs`)).body.files as { path: string; readOnly: boolean }[];
    expect(files.find((f) => f.path === "cfg/cs2panel_shared.cfg")?.readOnly).toBe(true);
    expect((await call(c, "PUT", "/api/shared", { hostnamePrefix: 'Bad"', tags: "", cvars: "" })).status).toBe(400);
    expect((await call(c, "PUT", "/api/shared", { hostnamePrefix: "", tags: "a;b", cvars: "" })).status).toBe(400);
    expect((await call(c, "PUT", "/api/shared", { hostnamePrefix: "", tags: "", cvars: "sv_password secret" })).body.error).toMatch(/Line 1: sv_password/);
    await call(c, "POST", "/api/users", { steam: MOD, role: "moderator" });
    const m = await login(MOD);
    expect((await call(m, "GET", "/api/shared")).status).toBe(200);
    expect((await call(m, "PUT", "/api/shared", { hostnamePrefix: "x", tags: "", cvars: "" })).status).toBe(403);
  });
});
