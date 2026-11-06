import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { CATALOG, dependencyOrder, pickAsset } from "../src/plugins/catalog.js";
import { mapArchiveFiles } from "../src/plugins/archive.js";

const OWNER = "76561198000000001";
const ADMIN = "76561198000000002";

// ---------------------------------------------------------------- pure helpers

describe("catalog", () => {
  it("orders dependencies before the plugin", () => {
    expect(dependencyOrder("cs2-simpleadmin")).toEqual(["metamod", "counterstrikesharp", "anybaselib", "playersettings", "menumanager"]);
    expect(dependencyOrder("metamod")).toEqual([]);
  });

  it("picks the Linux with-runtime build of CounterStrikeSharp", () => {
    const css = CATALOG.find((e) => e.id === "counterstrikesharp")!.source;
    if (css.type !== "github") throw new Error();
    const assets = [
      { name: "counterstrikesharp-windows-1.0.370.zip" },
      { name: "counterstrikesharp-linux-1.0.370.zip" },
      { name: "counterstrikesharp-with-runtime-windows-1.0.370.zip" },
      { name: "counterstrikesharp-with-runtime-linux-1.0.370.zip" },
    ];
    expect(pickAsset(assets, css)?.name).toBe("counterstrikesharp-with-runtime-linux-1.0.370.zip");
  });

  it("only takes SimpleAdmin's main zip", () => {
    const sa = CATALOG.find((e) => e.id === "cs2-simpleadmin")!.source;
    if (sa.type !== "github") throw new Error();
    expect(pickAsset([{ name: "Source code.zip" }, { name: "Extra.zip" }, { name: "CS2-SimpleAdmin-1.9.1.zip" }], sa)?.name).toBe("CS2-SimpleAdmin-1.9.1.zip");
  });
});

describe("archive layouts", () => {
  it("handles the layouts plugins ship in", () => {
    expect([...mapArchiveFiles(["addons/metamod.vdf", "addons/metamod/bin/x.so"]).values()]).toEqual(["addons/metamod.vdf", "addons/metamod/bin/x.so"]);
    expect([...mapArchiveFiles(["counterstrikesharp/plugins/A/A.dll", "README.md"]).values()]).toEqual(["addons/counterstrikesharp/plugins/A/A.dll"]);
    expect([...mapArchiveFiles(["Pack/plugins/B/B.dll", "Pack/shared/BApi/BApi.dll"]).values()]).toEqual([
      "addons/counterstrikesharp/plugins/B/B.dll",
      "addons/counterstrikesharp/shared/BApi/BApi.dll",
    ]);
    expect([...mapArchiveFiles(["Lib/Lib.dll", "Lib/Lib.deps.json"], "shared/Lib").values()]).toEqual([
      "addons/counterstrikesharp/shared/Lib/Lib.dll",
      "addons/counterstrikesharp/shared/Lib/Lib.deps.json",
    ]);
    expect([...mapArchiveFiles(["__MACOSX/addons/x", "addons/y/z.dll"]).values()]).toEqual(["addons/y/z.dll"]);
  });

  it("drops anything that would land outside addons/", () => {
    expect(mapArchiveFiles(["x/addons/../../etc/passwd"]).size).toBe(0);
    expect(mapArchiveFiles(["loose.dll"]).size).toBe(0);
  });
});

// ---------------------------------------------------------------- end to end with a fake GitHub

let dir: string;
let app: App;
let host: FakeHost;
let fixtures: string;
let assetFail = false;
const rconCalls: string[] = [];

function zip(name: string, files: Record<string, string>): string {
  const src = mkdtempSync(path.join(tmpdir(), "zsrc-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    writeFileSync(path.join(src, f), c);
  }
  const out = path.join(fixtures, name);
  if (name.endsWith(".zip")) execFileSync("zip", ["-qr", out, "."], { cwd: src });
  else execFileSync("tar", ["-czf", out, "-C", src, "."]);
  rmSync(src, { recursive: true, force: true });
  return out;
}

function buildFixtures() {
  fixtures = mkdtempSync(path.join(tmpdir(), "fixtures-"));
  zip("mmsource-2.0.0-git1350-linux.tar.gz", {
    "addons/metamod.vdf": '"Plugin" { "file" "addons/metamod/bin/linuxsteamrt64/metamod.2.cs2" }',
    "addons/metamod/bin/linuxsteamrt64/libserver.so": "metamod 1350",
  });
  zip("counterstrikesharp-with-runtime-linux-1.0.369.zip", {
    "addons/counterstrikesharp/bin/linuxsteamrt64/counterstrikesharp.so": "css 369",
    "addons/counterstrikesharp/configs/core.json": '{"stock": 369}',
    "addons/metamod/counterstrikesharp.vdf": "vdf",
  });
  zip("counterstrikesharp-with-runtime-linux-1.0.370.zip", {
    "addons/counterstrikesharp/bin/linuxsteamrt64/counterstrikesharp.so": "css 370",
    "addons/counterstrikesharp/configs/core.json": '{"stock": 370}',
    "addons/metamod/counterstrikesharp.vdf": "vdf",
  });
  zip("counterstrikesharp-windows-1.0.370.zip", { "x.dll": "win" });
  zip("AnyBaseLib.zip", { "AnyBaseLib/AnyBaseLib.dll": "abl" });
  zip("PlayerSettings.zip", { "plugins/PlayerSettings/PlayerSettings.dll": "ps", "shared/PlayerSettingsApi/PlayerSettingsApi.dll": "psapi" });
  zip("MenuManager.zip", { "MenuManager/plugins/MenuManagerCore/MenuManagerCore.dll": "mm", "MenuManager/shared/MenuManagerApi/MenuManagerApi.dll": "mmapi" });
  zip("CS2-SimpleAdmin-1.9.0.zip", {
    "counterstrikesharp/plugins/CS2-SimpleAdmin/CS2-SimpleAdmin.dll": "sa 190",
    "counterstrikesharp/plugins/CS2-SimpleAdmin/OldHelper.dll": "old",
    "counterstrikesharp/shared/CS2-SimpleAdminApi/CS2-SimpleAdminApi.dll": "api 190",
  });
  zip("CS2-SimpleAdmin-1.9.1.zip", {
    "counterstrikesharp/plugins/CS2-SimpleAdmin/CS2-SimpleAdmin.dll": "sa 191",
    "counterstrikesharp/shared/CS2-SimpleAdminApi/CS2-SimpleAdminApi.dll": "api 191",
  });
  zip("MyPlugin-v2.zip", { "MyPlugin/MyPlugin.dll": "mine" });
}

const release = (tag: string, assets: string[], prerelease = false) => ({
  tag_name: tag,
  draft: false,
  prerelease,
  published_at: "2026-11-01T00:00:00Z",
  assets: assets.map((a) => ({ name: a, browser_download_url: `https://dl.test/${a}`, size: 10 })),
});

const RELEASES: Record<string, unknown[]> = {
  "roflmuffin/CounterStrikeSharp": [
    release("v370", ["counterstrikesharp-windows-1.0.370.zip", "counterstrikesharp-with-runtime-linux-1.0.370.zip"]),
    release("v369", ["counterstrikesharp-with-runtime-linux-1.0.369.zip"]),
  ],
  "NickFox007/AnyBaseLibCS2": [release("v1.0", ["AnyBaseLib.zip"])],
  "NickFox007/PlayerSettingsCS2": [release("v0.9", ["PlayerSettings.zip"])],
  "NickFox007/MenuManagerCS2": [release("v1.3", ["MenuManager.zip"])],
  "daffyyyy/CS2-SimpleAdmin": [
    release("build-1.9.2-beta", ["CS2-SimpleAdmin-1.9.1.zip"], true),
    release("build-1.9.1", ["CS2-SimpleAdmin-1.9.1.zip"]),
    release("build-1.9.0", ["CS2-SimpleAdmin-1.9.0.zip"]),
  ],
};

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const gh = /api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases/.exec(url);
  if (gh) return new Response(JSON.stringify(RELEASES[gh[1]!] ?? []), { status: RELEASES[gh[1]!] ? 200 : 404 });
  if (url.endsWith("mmsource-latest-linux")) return new Response("mmsource-2.0.0-git1350-linux.tar.gz\n");
  const file = /(?:dl\.test|mmsdrop\/2\.0)\/(.+)$/.exec(url)?.[1];
  if (file && !assetFail && existsSync(path.join(fixtures, file))) return new Response(readFileSync(path.join(fixtures, file)));
  return new Response("not found", { status: 404 });
}) as typeof fetch;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-plugins-"));
  buildFixtures();
  assetFail = false;
  rconCalls.length = 0;
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    ownerSteamId: OWNER,
    secretKey: "22".repeat(32),
    dataDir: dir,
    cs2Root: path.join(dir, "cs2"),
    instanceEnvDir: path.join(dir, "env"),
    cs2ctl: "/bin/false",
    webDir: path.join(dir, "no-web"),
    dev: true,
    mysql: { host: "127.0.0.1", port: 3306, user: "cs2sa", password: "pw-secret", database: "cs2_simpleadmin" },
  };
  installFakeBase(config.cs2Root);
  host = new FakeHost(config.cs2Root, config.instanceEnvDir);
  app = await buildApp({
    config,
    db: openDb(path.join(dir, "panel.db")),
    host,
    fetchFn: fakeFetch,
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    rcon: async (_o, cmd) => {
      rconCalls.push(cmd);
      if (cmd === "meta list") return "Listing 1 plugin:\n  [01] CounterStrikeSharp (1.0.370) by Roflmuffin\n";
      if (cmd === "css_plugins list") return '[#1:LOADED]: "CS2-SimpleAdmin" (1.9.1) by daffyyyy\n';
      return "";
    },
  });
});

afterEach(async () => {
  await app.fastify.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(fixtures, { recursive: true, force: true });
});

async function login(steamId = OWNER) {
  const res = await app.fastify.inject({ method: "GET", url: `/api/auth/dev?steamId=${steamId}` });
  return `cs2p_session=${res.cookies.find((c) => c.name === "cs2p_session")!.value}`;
}
async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.fastify.inject({ method: method as "GET", url, headers: { cookie, host: "panel.lan" }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}
async function newServer(c: string, name = "S", port = 27015) {
  const presets = (await call(c, "GET", "/api/presets")).body.presets;
  return (await call(c, "POST", "/api/servers", { name, presetId: presets[0].id, port })).body.server as { id: number; slug: string };
}
const csgo = (slug: string, rel = "") => path.join(dir, "cs2/instances", slug, "upper/game/csgo", rel);

describe("plugin management", () => {
  it("installs SimpleAdmin with all its dependencies, patches gameinfo and points it at MariaDB", async () => {
    const c = await login();
    const s = await newServer(c);
    const res = await call(c, "POST", `/api/servers/${s.id}/plugins/cs2-simpleadmin/install`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.installed.map((p: { id: string }) => p.id)).toEqual(["metamod", "counterstrikesharp", "anybaselib", "playersettings", "menumanager", "cs2-simpleadmin"]);
    // Pre-releases are skipped by default.
    expect(res.body.installed.at(-1).version).toBe("build-1.9.1");

    expect(readFileSync(csgo(s.slug, "addons/metamod/bin/linuxsteamrt64/libserver.so"), "utf8")).toBe("metamod 1350");
    expect(readFileSync(csgo(s.slug, "addons/counterstrikesharp/bin/linuxsteamrt64/counterstrikesharp.so"), "utf8")).toBe("css 370");
    expect(existsSync(csgo(s.slug, "addons/counterstrikesharp/shared/AnyBaseLib/AnyBaseLib.dll"))).toBe(true);
    expect(existsSync(csgo(s.slug, "addons/counterstrikesharp/plugins/MenuManagerCore/MenuManagerCore.dll"))).toBe(true);
    expect(existsSync(csgo(s.slug, "addons/counterstrikesharp/shared/CS2-SimpleAdminApi/CS2-SimpleAdminApi.dll"))).toBe(true);
    expect(readFileSync(csgo(s.slug, "gameinfo.gi"), "utf8")).toContain("csgo/addons/metamod");

    const saConfig = JSON.parse(readFileSync(csgo(s.slug, "addons/counterstrikesharp/configs/plugins/CS2-SimpleAdmin/CS2-SimpleAdmin.json"), "utf8"));
    expect(saConfig.DatabaseConfig).toMatchObject({ DatabaseType: "MySQL", DatabaseUser: "cs2sa", DatabaseName: "cs2_simpleadmin" });
    expect(saConfig.MultiServerMode).toBe(true);

    const list = (await call(c, "GET", `/api/servers/${s.id}/plugins`)).body;
    expect(list.databaseConfigured).toBe(true);
    expect(list.plugins.find((p: { id: string }) => p.id === "cs2-simpleadmin").databaseBenefit).toMatch(/every server/);
    expect(list.plugins.find((p: { id: string }) => p.id === "metamod").databaseBenefit).toBeNull();
    const css = list.plugins.find((p: { id: string }) => p.id === "counterstrikesharp");
    expect(css.installed.version).toBe("v370");
    expect(css.dependents.sort()).toEqual(["AnyBaseLib", "CS2-SimpleAdmin"]);

    const audit = (await call(c, "GET", `/api/audit?serverId=${s.id}`)).body.entries[0];
    expect(audit.action).toBe("plugin.install");
    expect(audit.details.alsoInstalled).toHaveLength(5);
  });

  it("restarts a running server around the install, with the overlay unmounted while files change", async () => {
    const c = await login();
    const s = await newServer(c);
    await call(c, "POST", `/api/servers/${s.id}/start`, {});
    host.calls.length = 0;
    const res = await call(c, "POST", `/api/servers/${s.id}/plugins/metamod/install`, {});
    expect(res.body.restarted).toBe(true);
    expect(host.calls).toEqual([`stop ${s.slug}`, `umount ${s.slug}`, `start ${s.slug}`]);
    expect(host.running.has(s.slug)).toBe(true);
  });

  it("keeps edited plugin configs on update and rolls back to the previous version", async () => {
    const c = await login();
    const s = await newServer(c);
    await call(c, "POST", `/api/servers/${s.id}/plugins/counterstrikesharp/install`, { version: "v369" });
    expect(readFileSync(csgo(s.slug, "addons/counterstrikesharp/configs/core.json"), "utf8")).toBe('{"stock": 369}');
    await call(c, "PUT", `/api/servers/${s.id}/configs/file`, { path: "addons/counterstrikesharp/configs/core.json", content: '{"mine": true}' });

    await call(c, "POST", `/api/servers/${s.id}/plugins/counterstrikesharp/install`, {});
    expect(readFileSync(csgo(s.slug, "addons/counterstrikesharp/bin/linuxsteamrt64/counterstrikesharp.so"), "utf8")).toBe("css 370");
    expect(readFileSync(csgo(s.slug, "addons/counterstrikesharp/configs/core.json"), "utf8")).toBe('{"mine": true}');
    expect((await call(c, "GET", `/api/audit?serverId=${s.id}`)).body.entries[0].action).toBe("plugin.update");

    // Rollback works from the local cache even if the download site is gone.
    assetFail = true;
    const rb = await call(c, "POST", `/api/servers/${s.id}/plugins/counterstrikesharp/rollback`, {});
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(rb.body.version).toBe("v369");
    expect(readFileSync(csgo(s.slug, "addons/counterstrikesharp/bin/linuxsteamrt64/counterstrikesharp.so"), "utf8")).toBe("css 369");
  });

  it("removes files an update no longer ships", async () => {
    const c = await login();
    const s = await newServer(c);
    await call(c, "POST", `/api/servers/${s.id}/plugins/cs2-simpleadmin/install`, { version: "build-1.9.0" });
    expect(existsSync(csgo(s.slug, "addons/counterstrikesharp/plugins/CS2-SimpleAdmin/OldHelper.dll"))).toBe(true);
    await call(c, "POST", `/api/servers/${s.id}/plugins/cs2-simpleadmin/install`, { version: "build-1.9.1" });
    expect(existsSync(csgo(s.slug, "addons/counterstrikesharp/plugins/CS2-SimpleAdmin/OldHelper.dll"))).toBe(false);
    expect(readFileSync(csgo(s.slug, "addons/counterstrikesharp/plugins/CS2-SimpleAdmin/CS2-SimpleAdmin.dll"), "utf8")).toBe("sa 191");
  });

  it("refuses to remove a plugin others need; removing keeps configs and restores stock gameinfo", async () => {
    const c = await login();
    const s = await newServer(c);
    await call(c, "POST", `/api/servers/${s.id}/plugins/counterstrikesharp/install`, {});
    expect((await call(c, "DELETE", `/api/servers/${s.id}/plugins/metamod`)).body.error).toMatch(/Remove CounterStrikeSharp first/);
    expect((await call(c, "DELETE", `/api/servers/${s.id}/plugins/counterstrikesharp`)).status).toBe(200);
    expect(existsSync(csgo(s.slug, "addons/counterstrikesharp/bin"))).toBe(false);
    expect(existsSync(csgo(s.slug, "addons/counterstrikesharp/configs/core.json"))).toBe(true);
    expect((await call(c, "DELETE", `/api/servers/${s.id}/plugins/metamod`)).status).toBe(200);
    expect(existsSync(csgo(s.slug, "addons/metamod"))).toBe(false);
    expect(existsSync(csgo(s.slug, "gameinfo.gi"))).toBe(false);
  });

  it("lets only the Owner upload custom plugins", async () => {
    const c = await login();
    await call(c, "POST", "/api/users", { steam: ADMIN, role: "admin" });
    const s = await newServer(c);
    const upload = (cookie: string) =>
      app.fastify.inject({
        method: "POST",
        url: `/api/servers/${s.id}/plugins/upload?name=MyPlugin-v2.zip`,
        headers: { cookie, host: "panel.lan", "content-type": "application/zip" },
        payload: readFileSync(path.join(fixtures, "MyPlugin-v2.zip")),
      });
    expect((await upload(await login(ADMIN))).statusCode).toBe(403);
    const res = await upload(c);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().pluginId).toBe("custom:myplugin");
    expect(readFileSync(csgo(s.slug, "addons/counterstrikesharp/plugins/myplugin/MyPlugin.dll"), "utf8")).toBe("mine");
    const list = (await call(c, "GET", `/api/servers/${s.id}/plugins`)).body.plugins;
    expect(list.find((p: { id: string }) => p.id === "custom:myplugin").custom).toBe(true);
  });

  it("copies plugin records when a server is duplicated", async () => {
    const c = await login();
    const s = await newServer(c);
    await call(c, "POST", `/api/servers/${s.id}/plugins/metamod/install`, {});
    const dup = (await call(c, "POST", `/api/servers/${s.id}/duplicate`, { name: "Copy", port: 27025 })).body.server;
    const list = (await call(c, "GET", `/api/servers/${dup.id}/plugins`)).body.plugins;
    expect(list.find((p: { id: string }) => p.id === "metamod").installed.version).toBe("2.0.0-git1350");
    expect(existsSync(csgo("copy", "addons/metamod/bin/linuxsteamrt64/libserver.so"))).toBe(true);
  });

  it("reports plugin health over RCON and checks it after a CS2 update", async () => {
    const c = await login();
    const s = await newServer(c);
    await call(c, "POST", `/api/servers/${s.id}/plugins/counterstrikesharp/install`, {});
    await call(c, "POST", `/api/servers/${s.id}/start`, {});
    const h = (await call(c, "GET", `/api/servers/${s.id}/plugins/health`)).body;
    expect(h).toMatchObject({ reachable: true, metamodLoaded: true, cssharpLoaded: true });
    expect(h.cssharpOutput).toContain("CS2-SimpleAdmin");

    await call(c, "POST", "/api/game/update", { warnSeconds: 0 });
    let body: Record<string, any> = {};
    for (let i = 0; i < 100; i++) {
      body = (await call(c, "GET", "/api/game")).body;
      if (body.job.state !== "running") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(body.lines.join("\n")).toContain(`${"S"}: plugins loaded`);
  });

  it("explains download problems instead of failing silently", async () => {
    const c = await login();
    const s = await newServer(c);
    assetFail = true;
    const res = await call(c, "POST", `/api/servers/${s.id}/plugins/metamod/install`, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Downloading Metamod:Source failed/);
    expect(existsSync(csgo(s.slug, "addons/metamod"))).toBe(false);
  });
});
