import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, type Db } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";

const OWNER = "76561198000000001";
const ADMIN = "76561198000000002";

let dir: string;
let app: App;
let db: Db;
let host: FakeHost;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-backups-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    ownerSteamId: OWNER,
    secretKey: "99".repeat(32),
    dataDir: dir,
    cs2Root: path.join(dir, "cs2"),
    instanceEnvDir: path.join(dir, "env"),
    cs2ctl: "/bin/false",
    webDir: path.join(dir, "no-web"),
    bridgeDir: path.join(dir, "no-bridge"),
    dev: true,
  };
  installFakeBase(config.cs2Root);
  db = openDb(path.join(dir, "panel.db"));
  host = new FakeHost(config.cs2Root, config.instanceEnvDir);
  app = await buildApp({ config, db, host, logLevel: "silent", pluginCheckDelayMs: 0, rcon: async () => "", a2sQuery: async () => null });
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
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? (res.json() as Record<string, any>) : {}, raw: res.rawPayload };
}
async function newServer(c: string, name = "A", port = 27015) {
  const presets = (await call(c, "GET", "/api/presets")).body.presets;
  return (await call(c, "POST", "/api/servers", { name, presetId: presets[0].id, port })).body.server as { id: number; slug: string };
}
const writeCfg = (c: string, id: number, file: string, content: string) => call(c, "PUT", `/api/servers/${id}/configs/file`, { path: `cfg/${file}`, content });
const readCfg = async (c: string, id: number, file: string) => (await call(c, "GET", `/api/servers/${id}/configs/file?path=${encodeURIComponent(`cfg/${file}`)}`)).body.content as string | null;

describe("backups", () => {
  it("backs up a server's files and what the panel knows about it, and restores them", async () => {
    const c = await login();
    const s = await newServer(c);
    await writeCfg(c, s.id, "practice.cfg", "sv_gravity 400\n");
    await call(c, "PUT", `/api/servers/${s.id}/exec-configs`, { configs: ["practice.cfg"] });
    db.prepare("INSERT INTO plugin_installs (server_id, plugin_id, name, version, asset, files) VALUES (?, 'metamod', 'Metamod:Source', '2.0.0-git1350', 'mm.tar.gz', '[]')").run(s.id);
    await call(c, "POST", `/api/servers/${s.id}/start`, {});

    const made = await call(c, "POST", `/api/servers/${s.id}/backups`, {});
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body.backup).toMatchObject({ kind: "server", serverId: s.id, serverName: "A", trigger: "manual", createdBy: OWNER });
    expect(made.body.backup.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, "cs2/backups/servers", s.slug, made.body.backup.file))).toBe(true);

    // Things change after the backup...
    await writeCfg(c, s.id, "practice.cfg", "sv_gravity 800\n");
    await call(c, "PUT", `/api/servers/${s.id}/exec-configs`, { configs: [] });
    db.prepare("UPDATE plugin_installs SET removed_at = datetime('now') WHERE server_id = ?").run(s.id);

    const r = await call(c, "POST", "/api/backups/restore", { id: made.body.backup.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.restarted).toBe(true);
    expect(await readCfg(c, s.id, "practice.cfg")).toBe("sv_gravity 400\n");
    expect((await call(c, "GET", `/api/servers/${s.id}`)).body.execConfigs).toEqual(["practice.cfg"]);
    expect(app.services.plugins.installedIds(s.id)).toEqual(["metamod"]);
    expect((await call(c, "GET", `/api/servers/${s.id}`)).body.server.status.state).toBe("active");
    expect(host.calls.filter((x) => x.startsWith("restore"))).toHaveLength(1);

    // The state before the restore was saved too.
    const list = (await call(c, "GET", "/api/backups")).body.backups as { trigger: string; file: string }[];
    expect(list.map((b) => b.trigger).sort()).toEqual(["before-restore", "manual"]);
    expect(list.find((b) => b.trigger === "before-restore")!.file).toBe(r.body.safetyBackup);
    const actions = (await call(c, "GET", "/api/audit")).body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("backup.restore");
  });

  it("copies the panel's database, Owner only, and it opens as a working database", async () => {
    const c = await login();
    await call(c, "POST", "/api/users", { steam: ADMIN, role: "admin" });
    const a = await login(ADMIN);
    expect((await call(a, "POST", "/api/backups/panel", {})).status).toBe(403);
    const made = (await call(c, "POST", "/api/backups/panel", {})).body.backup;
    expect(made).toMatchObject({ kind: "panel", trigger: "manual" });
    const copy = new DatabaseSync(path.join(dir, "backups", made.file), { readOnly: true });
    const users = copy.prepare("SELECT steam_id FROM users ORDER BY id").all() as { steam_id: string }[];
    copy.close();
    expect(users.map((u) => u.steam_id)).toEqual([OWNER, ADMIN]);
    expect((await call(a, "GET", `/api/backups/download?id=${encodeURIComponent(made.id)}`)).status).toBe(403);
    const dl = await call(c, "GET", `/api/backups/download?id=${encodeURIComponent(made.id)}`);
    expect(dl.status).toBe(200);
    expect(dl.raw.subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  it("refuses ids outside the backup folders and deletes backups", async () => {
    const c = await login();
    for (const bad of ["server/a/../../panel.db", "panel/../panel.db", "server/A/x.tar.gz", "../etc/passwd"]) {
      expect((await call(c, "GET", `/api/backups/download?id=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    }
    const s = await newServer(c);
    const b = (await call(c, "POST", `/api/servers/${s.id}/backups`, {})).body.backup;
    expect((await call(c, "DELETE", `/api/backups?id=${encodeURIComponent(b.id)}`)).status).toBe(200);
    expect((await call(c, "GET", "/api/backups")).body.backups).toEqual([]);
    expect(readdirSync(path.join(dir, "cs2/backups/servers", s.slug))).toEqual([]);
  });

  it("makes nightly backups at the set time and keeps the newest few", async () => {
    const c = await login();
    const s = await newServer(c);
    expect((await call(c, "PUT", "/api/backups/settings", { enabled: true, time: "25:00", keep: 2 })).status).toBe(400);
    await call(c, "PUT", "/api/backups/settings", { enabled: true, time: "04:30", keep: 2 });
    const manual = (await call(c, "POST", `/api/servers/${s.id}/backups`, {})).body.backup;
    const tick = async (day: number, h: number, m: number) => {
      await app.services.backups.tick(new Date(2027, 0, day, h, m));
      await app.services.backups.idle();
    };
    await tick(1, 4, 0); // before the time
    expect((await call(c, "GET", "/api/backups")).body.backups).toHaveLength(1);
    await tick(1, 4, 30);
    await tick(1, 4, 31); // once per night
    let list = (await call(c, "GET", "/api/backups")).body.backups as { trigger: string; kind: string; id: string }[];
    expect(list.filter((b) => b.trigger === "nightly").map((b) => b.kind).sort()).toEqual(["panel", "server"]);
    await tick(2, 4, 30);
    await tick(3, 4, 30);
    list = (await call(c, "GET", "/api/backups")).body.backups;
    expect(list.filter((b) => b.trigger === "nightly" && b.kind === "server")).toHaveLength(2);
    expect(list.filter((b) => b.trigger === "nightly" && b.kind === "panel")).toHaveLength(2);
    expect(list.map((b) => b.id)).toContain(manual.id); // manual ones stay
    await tick(4, 12, 0); // missed by 7.5 hours: skipped
    expect((await call(c, "GET", "/api/backups")).body.backups).toHaveLength(list.length);
  });
});
