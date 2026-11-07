import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { latestPublicBuild, manifestBuild } from "../src/game/steam-vdf.js";
import { isNewer } from "../src/automation/updates.js";
import { lastSlot, nextSlot } from "../src/automation/restarts.js";

const OWNER = "76561198000000001";
const MOD = "76561198000000003";

const WITH_PLAYER = `---------players--------
  id     time ping loss      state   rate adr name
     1      BOT    0    0     active      0 'Bot Albert'
     2    01:08   26    0     active 786432 192.168.1.10:27005 'Alice'
#end
`;
const BOTS_ONLY = `---------players--------
  id     time ping loss      state   rate adr name
     1      BOT    0    0     active      0 'Bot Albert'
#end
`;

describe("Steam build info", () => {
  it("reads the public build from SteamCMD output and the installed build from the manifest", async () => {
    const host = new FakeHost("/nonexistent", "/nonexistent");
    host.latestBuildId = "20109876";
    expect(latestPublicBuild(await host.steamAppInfo())).toEqual({ buildId: "20109876", updatedAt: "2025-11-06T17:26:40.000Z" });
    expect(() => latestPublicBuild("Connecting anonymously... FAILED")).toThrow(/no app info/);
    expect(manifestBuild('"AppState"\n{\n\t"appid"\t"730"\n\t"buildid"\t"123"\n}')).toBe("123");
    expect(manifestBuild("garbage")).toBeNull();
    expect(isNewer("20001300", "20001234")).toBe(true);
    expect(isNewer("20001234", "20001234")).toBe(false);
    expect(isNewer("20001300", null)).toBe(false);
  });

  it("works out restart times in local time", () => {
    const now = new Date(2026, 10, 7, 7, 30);
    expect(lastSlot("06:00", now)).toEqual(new Date(2026, 10, 7, 6, 0));
    expect(lastSlot("08:00", now)).toEqual(new Date(2026, 10, 6, 8, 0));
    expect(nextSlot("06:00", now)).toEqual(new Date(2026, 10, 8, 6, 0));
    expect(nextSlot("08:00", now)).toEqual(new Date(2026, 10, 7, 8, 0));
  });
});

let dir: string;
let app: App;
let host: FakeHost;
let status = BOTS_ONLY;
const said: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-auto-"));
  status = BOTS_ONLY;
  said.length = 0;
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    ownerSteamId: OWNER,
    secretKey: "55".repeat(32),
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
  app = await buildApp({
    config,
    db: openDb(path.join(dir, "panel.db")),
    host,
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    automationSleep: async () => undefined,
    rcon: async (_o, cmd) => {
      if (cmd === "status") return status;
      if (cmd.startsWith("say ")) said.push(cmd.slice(4));
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
async function runningServer(c: string, name = "A", port = 27015) {
  const presets = (await call(c, "GET", "/api/presets")).body.presets;
  const s = (await call(c, "POST", "/api/servers", { name, presetId: presets[0].id, port })).body.server as { id: number; slug: string };
  await call(c, "POST", `/api/servers/${s.id}/start`, {});
  return s;
}
async function until(cond: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}
const updateDone = () => until(() => app.services.updater.job.state !== "running");
const audit = async (c: string) => (await call(c, "GET", "/api/audit")).body.entries as { action: string; details: Record<string, unknown> }[];
async function auto(c: string) {
  return (await call(c, "GET", "/api/game")).body.auto as Record<string, any>;
}
const t = (h: number, m = 0, day = 7) => new Date(2026, 10, day, h, m);

describe("automatic CS2 updates", () => {
  it("notify: checks on its interval and only reports the update", async () => {
    const c = await login();
    await app.services.automation.tick(t(12));
    let a = await auto(c);
    expect(a).toMatchObject({ installedBuild: "20001234", latestBuild: "20001234", updateAvailable: false, settings: { policy: "notify" } });

    host.latestBuildId = "20001300";
    await app.services.automation.tick(t(12, 5));
    expect(host.calls.filter((x) => x === "steam-check")).toHaveLength(1); // not due yet
    await app.services.automation.tick(t(12, 10));
    a = await auto(c);
    expect(a).toMatchObject({ latestBuild: "20001300", updateAvailable: true });
    expect(host.calls).not.toContain("steam-update");
    expect((await audit(c)).map((e) => e.action)).toContain("game.update.available");

    // Check now
    host.latestBuildId = "20001301";
    expect((await call(c, "POST", "/api/game/check", {})).body.auto.latestBuild).toBe("20001301");
  });

  it("off: never asks Steam", async () => {
    const c = await login();
    await call(c, "PUT", "/api/game/auto", { policy: "off", checkMinutes: 10, maxWaitMinutes: 60, warnSeconds: 0 });
    await app.services.automation.tick(t(12));
    expect(host.calls).not.toContain("steam-check");
  });

  it("now: updates as soon as a new build shows up, and restarts running servers", async () => {
    const c = await login();
    const s = await runningServer(c);
    await call(c, "PUT", "/api/game/auto", { policy: "now", checkMinutes: 10, maxWaitMinutes: 60, warnSeconds: 0 });
    host.latestBuildId = "20001300";
    await app.services.automation.tick(t(12));
    await updateDone();
    expect(app.services.updater.job).toMatchObject({ state: "succeeded", startedBy: null, trigger: "new CS2 build 20001300" });
    expect((await auto(c))).toMatchObject({ installedBuild: "20001300", updateAvailable: false });
    expect((await call(c, "GET", `/api/servers/${s.id}`)).body.server.status.state).toBe("active");
    const start = (await audit(c)).find((e) => e.action === "game.update.start")!;
    expect(start.details.trigger).toBe("new CS2 build 20001300");
  });

  it("when-empty: waits for players to leave, or the longest wait", async () => {
    const c = await login();
    await runningServer(c);
    await call(c, "PUT", "/api/game/auto", { policy: "when-empty", checkMinutes: 10, maxWaitMinutes: 60, warnSeconds: 0 });
    host.latestBuildId = "20001300";
    status = WITH_PLAYER;
    await app.services.automation.tick(t(12));
    await app.services.automation.tick(t(12, 30));
    expect(host.calls).not.toContain("steam-update");
    expect((await auto(c)).deadline).toBe(new Date(t(13)).toISOString());

    status = BOTS_ONLY;
    await app.services.automation.tick(t(12, 31));
    await updateDone();
    expect(app.services.updater.job.trigger).toBe("new CS2 build 20001300, no players online");
  });

  it("when-empty: updates anyway once the longest wait is over", async () => {
    const c = await login();
    await runningServer(c);
    await call(c, "PUT", "/api/game/auto", { policy: "when-empty", checkMinutes: 10, maxWaitMinutes: 60, warnSeconds: 0 });
    host.latestBuildId = "20001300";
    status = WITH_PLAYER;
    await app.services.automation.tick(t(12));
    await app.services.automation.tick(t(13));
    await updateDone();
    expect(app.services.updater.job.trigger).toMatch(/waited 60 minutes/);
  });

  it("doesn't retry a failed update every minute", async () => {
    const c = await login();
    await call(c, "PUT", "/api/game/auto", { policy: "now", checkMinutes: 10, maxWaitMinutes: 60, warnSeconds: 0 });
    host.latestBuildId = "20001300";
    let attempts = 0;
    host.steamUpdate = async () => {
      attempts++;
      throw new Error("steamcmd failed after 3 attempts");
    };
    await app.services.automation.tick(t(12));
    await updateDone();
    expect(app.services.updater.job.state).toBe("failed");
    await app.services.automation.tick(t(12, 1));
    await app.services.automation.tick(t(12, 20));
    expect(attempts).toBe(1);
    await app.services.automation.tick(t(12, 31));
    await updateDone();
    expect(attempts).toBe(2);
  });

  it("keeps the Steam error for the page", async () => {
    const c = await login();
    host.steamCheckError = "steamcmd not found at /srv/cs2/steamcmd/steamcmd.sh";
    await app.services.automation.tick(t(12));
    expect((await auto(c)).error).toMatch(/steamcmd not found/);
  });

  it("only users who may update change the settings", async () => {
    const c = await login();
    await call(c, "POST", "/api/users", { steam: MOD, role: "moderator" });
    const m = await login(MOD);
    expect((await call(m, "PUT", "/api/game/auto", { policy: "now", checkMinutes: 10, maxWaitMinutes: 60, warnSeconds: 0 })).status).toBe(403);
    const r = await call(c, "PUT", "/api/game/auto", { policy: "now", checkMinutes: 1, maxWaitMinutes: 99999, warnSeconds: 60 });
    expect(r.body.auto.settings).toEqual({ policy: "now", checkMinutes: 5, maxWaitMinutes: 1440, warnSeconds: 60 });
  });
});

describe("scheduled restarts", () => {
  /** Restarts the scheduler did (no user) on one server. */
  const restarts = async (c: string, id: number) =>
    (await audit(c)).filter((e) => e.action === "server.restart" && (e as unknown as { serverId: number }).serverId === id && e.details.trigger);

  it("restarts once a day at the set time when nobody's on", async () => {
    const c = await login();
    const s = await runningServer(c);
    const set = app.services.automation.restarts.set(s.id, { restartAt: "06:00", ifPlayers: "wait", maxWaitMinutes: 120 }, 1, t(7));
    expect(set.restartAt).toBe("06:00");
    // Set after today's time: nothing happens today.
    await app.services.automation.tick(t(7, 1));
    expect((await restarts(c, s.id)).length).toBe(0);
    expect(app.services.automation.restarts.view(s.id, t(7, 1)).nextAt).toBe(t(6, 0, 8).toISOString());

    await app.services.automation.tick(t(6, 0, 8));
    await until(async () => (await restarts(c, s.id)).length === 1);
    expect((await restarts(c, s.id))[0]!.details.trigger).toBe("scheduled restart");
    expect(said).toEqual([]);
    await app.services.automation.tick(t(6, 5, 8));
    await new Promise((r) => setTimeout(r, 50));
    expect((await restarts(c, s.id)).length).toBe(1);
  });

  it("waits for players to leave, then restarts without a warning", async () => {
    const c = await login();
    const s = await runningServer(c);
    app.services.automation.restarts.set(s.id, { restartAt: "06:00", ifPlayers: "wait", maxWaitMinutes: 120 }, 1, t(5));
    status = WITH_PLAYER;
    await app.services.automation.tick(t(6));
    await app.services.automation.tick(t(6, 30));
    const v = app.services.automation.restarts.view(s.id, t(6, 30));
    expect(v.waitingSince).toBe(t(6).toISOString());
    expect(v.deadline).toBe(t(8).toISOString());
    expect((await restarts(c, s.id)).length).toBe(0);
    status = BOTS_ONLY;
    await app.services.automation.tick(t(6, 40));
    await until(async () => (await restarts(c, s.id)).length === 1);
    expect(said).toEqual([]);
  });

  it("warns players and restarts when the wait runs out, or right away in restart mode", async () => {
    const c = await login();
    const a = await runningServer(c, "A", 27015);
    const b = await runningServer(c, "B", 27025);
    app.services.automation.restarts.set(a.id, { restartAt: "06:00", ifPlayers: "wait", maxWaitMinutes: 60 }, 1, t(5));
    app.services.automation.restarts.set(b.id, { restartAt: "06:00", ifPlayers: "restart", maxWaitMinutes: 60 }, 1, t(5));
    status = WITH_PLAYER;
    await app.services.automation.tick(t(6));
    await until(async () => (await restarts(c, b.id)).length === 1);
    expect(said).toEqual(["Scheduled server restart in 60 seconds.", "Scheduled server restart in 10 seconds."]);
    await app.services.automation.tick(t(7));
    await until(async () => (await restarts(c, a.id)).length === 1);
    expect((await restarts(c, a.id))[0]!.details.trigger).toBe("scheduled restart, players still on after waiting 60 minutes");
  });

  it("leaves stopped servers alone and skips slots the panel missed", async () => {
    const c = await login();
    const s = await runningServer(c);
    app.services.automation.restarts.set(s.id, { restartAt: "06:00", ifPlayers: "restart", maxWaitMinutes: 60 }, 1, t(5));
    await app.services.automation.tick(t(11)); // panel was down at 06:00
    await call(c, "POST", `/api/servers/${s.id}/stop`, {});
    await app.services.automation.tick(t(6, 0, 8));
    await new Promise((r) => setTimeout(r, 50));
    expect((await restarts(c, s.id)).length).toBe(0);
  });

  it("validates the schedule and checks permissions", async () => {
    const c = await login();
    const s = await runningServer(c);
    expect((await call(c, "PUT", `/api/servers/${s.id}/schedule`, { restartAt: "25:00", ifPlayers: "wait", maxWaitMinutes: 60 })).status).toBe(400);
    expect((await call(c, "PUT", `/api/servers/${s.id}/schedule`, { restartAt: "06:00", ifPlayers: "wait", maxWaitMinutes: 1 })).status).toBe(400);
    const ok = await call(c, "PUT", `/api/servers/${s.id}/schedule`, { restartAt: "06:00", ifPlayers: "wait", maxWaitMinutes: 90 });
    expect(ok.body).toMatchObject({ schedule: { restartAt: "06:00", ifPlayers: "wait", maxWaitMinutes: 90 } });
    expect(ok.body.nextAt).toBeTruthy();
    expect((await call(c, "PUT", `/api/servers/${s.id}/schedule`, { restartAt: null, ifPlayers: "wait", maxWaitMinutes: 90 })).body.nextAt).toBeNull();
    await call(c, "POST", "/api/users", { steam: MOD, role: "moderator" });
    const m = await login(MOD);
    expect((await call(m, "PUT", `/api/servers/${s.id}/schedule`, { restartAt: "06:00", ifPlayers: "wait", maxWaitMinutes: 90 })).status).toBe(403);
    expect((await call(m, "GET", `/api/servers/${s.id}/schedule`)).status).toBe(200);
  });
});

describe("commands tab", () => {
  it("turns buttons into fixed RCON commands and keeps typed text from adding commands", async () => {
    const c = await login();
    const s = await runningServer(c);
    const send = async (body: object) => call(c, "POST", `/api/servers/${s.id}/commands`, body);
    expect((await send({ action: "changemap", map: "de_nuke" })).status).toBe(200);
    expect((await send({ action: "changemap", map: "workshop:3070288532" })).status).toBe(200);
    expect((await send({ action: "changemap", map: "de_dust2; quit" })).status).toBe(400);
    expect((await send({ action: "bot-quota", count: 99 })).status).toBe(400);
    expect((await send({ action: "rcon_password", value: "x" })).status).toBe(400);
    expect((await send({ action: "say", text: 'hi"; quit; say "' })).status).toBe(200);
    expect(said.at(-1)).toBe("hi quit say");
    expect((await send({ action: "say", text: " ;; " })).status).toBe(400);
    const log = (await audit(c)).filter((e) => e.action === "server.command").map((e) => e.details.action);
    expect(log).toEqual(["say", "changemap", "changemap"]);
  });

  it("lets moderators send chat messages only, and needs a running server", async () => {
    const c = await login();
    const s = await runningServer(c);
    await call(c, "POST", "/api/users", { steam: MOD, role: "moderator" });
    const m = await login(MOD);
    expect((await call(m, "POST", `/api/servers/${s.id}/commands`, { action: "say", text: "Be nice" })).status).toBe(200);
    expect((await call(m, "POST", `/api/servers/${s.id}/commands`, { action: "restart-game" })).status).toBe(403);
    await call(c, "POST", `/api/servers/${s.id}/stop`, {});
    expect((await call(c, "POST", `/api/servers/${s.id}/commands`, { action: "restart-game" })).body.error).toMatch(/Start the server/);
  });
});

describe("rconFor", () => {
  it("builds the command for every action", async () => {
    const { rconFor } = await import("../src/servers/commands.js");
    expect(rconFor({ action: "changemap", map: "collection:125499818" })).toBe("host_workshop_collection 125499818");
    expect(rconFor({ action: "bot-add", team: "ct" })).toBe("bot_add_ct");
    expect(rconFor({ action: "bot-quota", count: 4 })).toBe("bot_quota 4");
    expect(rconFor({ action: "unpause" })).toBe("mp_unpause_match");
  });
});

