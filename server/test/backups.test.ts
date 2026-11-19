import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { userInfo } from "node:os";
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
  const res = await app.fastify.inject({
    method: method as "GET",
    url,
    headers: { cookie, host: "panel.lan" },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? (res.json() as Record<string, any>) : {}, raw: res.rawPayload };
}
async function newServer(c: string, name = "A", port = 27015) {
  const presets = (await call(c, "GET", "/api/presets")).body.presets;
  return (await call(c, "POST", "/api/servers", { name, presetId: presets[0].id, port })).body.server as { id: number; slug: string };
}
const writeCfg = (c: string, id: number, file: string, content: string) => call(c, "PUT", `/api/servers/${id}/configs/file`, { path: `cfg/${file}`, content });
const readCfg = async (c: string, id: number, file: string) =>
  (await call(c, "GET", `/api/servers/${id}/configs/file?path=${encodeURIComponent(`cfg/${file}`)}`)).body.content as string | null;

describe("backups", () => {
  it("backs up a server's files and what the panel knows about it, and restores them", async () => {
    const c = await login();
    const s = await newServer(c);
    await writeCfg(c, s.id, "practice.cfg", "sv_gravity 400\n");
    await call(c, "PUT", `/api/servers/${s.id}/exec-configs`, { configs: ["practice.cfg"] });
    db.prepare(
      "INSERT INTO plugin_installs (server_id, plugin_id, name, version, asset, files) VALUES (?, 'metamod', 'Metamod:Source', '2.0.0-git1350', 'mm.tar.gz', '[]')",
    ).run(s.id);
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
    expect(
      list
        .filter((b) => b.trigger === "nightly")
        .map((b) => b.kind)
        .sort(),
    ).toEqual(["panel", "server"]);
    await tick(2, 4, 30);
    await tick(3, 4, 30);
    list = (await call(c, "GET", "/api/backups")).body.backups;
    expect(list.filter((b) => b.trigger === "nightly" && b.kind === "server")).toHaveLength(2);
    expect(list.filter((b) => b.trigger === "nightly" && b.kind === "panel")).toHaveLength(2);
    expect(list.map((b) => b.id)).toContain(manual.id); // manual ones stay
    await tick(4, 12, 0); // missed by 7.5 hours: skipped
    expect((await call(c, "GET", "/api/backups")).body.backups).toHaveLength(list.length);
  });

  it("two backups of the same server at once get their own names, both complete, with matching details", async () => {
    const c = await login();
    const s = await newServer(c);
    await writeCfg(c, s.id, "practice.cfg", "sv_gravity 400\n");
    const first = (await call(c, "POST", `/api/servers/${s.id}/backups`, {})).body.backup;
    // Same second (the fake clock doesn't move): neither may overwrite the other or the first.
    const [a, b] = await Promise.all([call(c, "POST", `/api/servers/${s.id}/backups`, {}), call(c, "POST", `/api/servers/${s.id}/backups`, {})]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const files = [first.file, a.body.backup.file, b.body.backup.file];
    expect(new Set(files).size).toBe(3);
    const folder = path.join(dir, "cs2/backups/servers", s.slug);
    for (const f of files) execFileSync("tar", ["--list", "--gzip", "--file", path.join(folder, f)]);
    expect(readdirSync(folder).filter((f) => f.endsWith(".part"))).toEqual([]);
    const list = (await call(c, "GET", "/api/backups")).body.backups as { file: string; serverId: number; trigger: string }[];
    for (const f of files) expect(list.find((x) => x.file === f)).toMatchObject({ serverId: s.id, trigger: "manual" });
    // A "-2" backup restores like any other.
    const second = list.find((x) => /-\d{6}-\d\.tar\.gz$/.test(x.file))! as unknown as { id: string };
    expect((await call(c, "POST", "/api/backups/restore", { id: second.id })).status).toBe(200);
  });
});

/**
 * The real deploy/cs2ctl backup, run as the current user in a temporary folder (root paths and the root
 * check swapped out, `date` pinned so runs land in the same second).
 */
describe("cs2ctl backup (the real script)", () => {
  let root: string;
  let script: string;
  let bin: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cs2ctl-backup-"));
    const me = userInfo().username;
    script = path.join(root, "cs2ctl");
    const src = readFileSync(path.join(__dirname, "../../deploy/cs2ctl"), "utf8")
      .replace('CS2_ROOT="/srv/cs2"', `CS2_ROOT="${root}/cs2"`)
      .replace('ENV_DIR="/etc/cs2-panel/instances"', `ENV_DIR="${root}/env"`)
      .replace('PANEL_USER="cs2panel"', `PANEL_USER="${me}"`)
      .replace('[[ $EUID -eq 0 ]] || die "must run as root (via sudo)"', "")
      // The current user may have no group of the same name (CI runners).
      .replaceAll('-g "$PANEL_USER" ', "")
      .replaceAll('"$PANEL_USER:$PANEL_USER"', '"$PANEL_USER"');
    writeFileSync(script, src);
    chmodSync(script, 0o755);
    bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "date"), "#!/bin/sh\necho 20261119-120000\n");
    chmodSync(path.join(bin, "date"), 0o755);
    const upper = path.join(root, "cs2/instances/a/upper");
    const put = (rel: string, text = "x") => {
      mkdirSync(path.dirname(path.join(upper, rel)), { recursive: true });
      writeFileSync(path.join(upper, rel), text);
    };
    // Disposable Workshop downloads (both places CS2 has used) ...
    put("game/bin/linuxsteamrt64/steamapps/workshop/content/730/3070244931/map.vpk");
    put("game/bin/linuxsteamrt64/steamapps/workshop/appworkshop_730.acf");
    put("game/csgo/maps/workshop/123/old.vpk");
    // ... and what must be kept: configs, plugins and their data, a map put there by hand.
    put("game/csgo/cfg/server.cfg", "hostname test");
    put("game/csgo/addons/counterstrikesharp/plugins/Cs2PanelBridge/Cs2PanelBridge.dll");
    put("game/csgo/addons/counterstrikesharp/configs/plugins/Foo/Foo.json", "{}");
    put("game/csgo/maps/aim_custom.vpk");
    mkdirSync(path.join(root, "env"));
    writeFileSync(path.join(root, "env/a.env"), "");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = () =>
    new Promise<string>((resolve, reject) => {
      const p = spawn("bash", [script, "backup", "a"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
    });

  it("leaves out Workshop downloads and keeps configs, plugins, plugin data and hand-installed maps", async () => {
    const name = await run();
    const listed = execFileSync("tar", ["--list", "--gzip", "--file", path.join(root, "cs2/backups/servers/a", name)], { encoding: "utf8" });
    expect(listed).not.toContain("steamapps/workshop");
    expect(listed).not.toContain("maps/workshop");
    for (const kept of [
      "./game/csgo/cfg/server.cfg",
      "./game/csgo/addons/counterstrikesharp/plugins/Cs2PanelBridge/Cs2PanelBridge.dll",
      "./game/csgo/addons/counterstrikesharp/configs/plugins/Foo/Foo.json",
      "./game/csgo/maps/aim_custom.vpk",
    ])
      expect(listed).toContain(kept);
  });

  it("backups in the same second get their own names and never overwrite one another", async () => {
    const folder = path.join(root, "cs2/backups/servers/a");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "a-20261119-120000.tar.gz"), "an existing backup");
    const names = await Promise.all([run(), run(), run()]);
    expect(names.sort()).toEqual(["a-20261119-120000-2.tar.gz", "a-20261119-120000-3.tar.gz", "a-20261119-120000-4.tar.gz"]);
    expect(readFileSync(path.join(folder, "a-20261119-120000.tar.gz"), "utf8")).toBe("an existing backup");
    for (const n of names) {
      const listed = execFileSync("tar", ["--list", "--gzip", "--file", path.join(folder, n)], { encoding: "utf8" });
      expect(listed).toContain("./game/csgo/cfg/server.cfg");
    }
    expect(readdirSync(folder).filter((f) => f.endsWith(".part"))).toEqual([]);
  });
});
