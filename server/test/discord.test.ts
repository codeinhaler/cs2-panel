import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { describeEvent } from "../src/notify/discord.js";

const OWNER = "76561198000000001";
const MOD = "76561198000000003";
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL";

let dir: string;
let app: App;
let db: Db;
let sent: { url: string; body: { username: string; embeds: { title: string; description?: string }[] } }[];
let answer: () => Response;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-discord-"));
  sent = [];
  answer = () => new Response(null, { status: 204 });
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    ownerSteamId: OWNER,
    secretKey: "88".repeat(32),
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
  app = await buildApp({
    config,
    db,
    host: new FakeHost(config.cs2Root, config.instanceEnvDir),
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    rcon: async () => "",
    a2sQuery: async () => null,
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://discord.com/")) {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return answer();
      }
      return new Response("", { status: 404 });
    }) as typeof fetch,
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
const titles = () => sent.map((s) => s.body.embeds[0]!.title);

describe("Discord notifications", () => {
  it("stores the webhook encrypted and only accepts Discord webhook links", async () => {
    const c = await login();
    expect((await call(c, "PUT", "/api/notifications", { webhook: "https://evil.example/hook" })).body.error).toMatch(/Discord webhook/);
    const r = await call(c, "PUT", "/api/notifications", { webhook: HOOK });
    expect(r.body.discord).toMatchObject({ webhookSet: true, webhookHint: "…hi-JKL", events: { problems: true, moderation: true, servers: false } });
    const raw = (db.prepare("SELECT value FROM settings WHERE key = 'discord'").get() as { value: string }).value;
    expect(raw).not.toContain("webhooks/123456789012345678");
    // Saving events alone keeps the webhook; an empty string removes it.
    expect((await call(c, "PUT", "/api/notifications", { events: { servers: true } })).body.discord).toMatchObject({ webhookSet: true, events: { servers: true } });
    expect((await call(c, "PUT", "/api/notifications", { webhook: "" })).body.discord.webhookSet).toBe(false);
  });

  it("sends a test message and reports a dead webhook", async () => {
    const c = await login();
    expect((await call(c, "POST", "/api/notifications/test", {})).body.error).toMatch(/webhook link first/);
    await call(c, "PUT", "/api/notifications", { webhook: HOOK });
    expect((await call(c, "POST", "/api/notifications/test", {})).status).toBe(200);
    expect(sent[0]).toMatchObject({ url: HOOK, body: { username: "CS2 Panel" } });
    answer = () => new Response("{}", { status: 404 });
    expect((await call(c, "POST", "/api/notifications/test", {})).body.error).toMatch(/refused.*404/);
  });

  it("forwards the chosen kinds of events only", async () => {
    const c = await login();
    await call(c, "PUT", "/api/notifications", { webhook: HOOK });
    const presets = (await call(c, "GET", "/api/presets")).body.presets;
    const s = (await call(c, "POST", "/api/servers", { name: "Fredag", presetId: presets[0].id, port: 27015 })).body.server;
    await call(c, "POST", `/api/servers/${s.id}/start`, {}); // "servers" is off by default
    await call(c, "POST", "/api/bans", { steam: "76561198000000012", name: "Bob", minutes: 1440, reason: "Wallhack" });
    app.services.audit.record(null, "alert.raised", s.id, { kind: "server.cpu", message: "Fredag has used 97% of its CPU core for 10 minutes." });
    await app.services.discord.flush();
    expect(titles()).toEqual(["Bob was banned for 1 day", "⚠ Warning"]);
    expect(sent[1]!.body.embeds[0]).toMatchObject({ description: "Fredag has used 97% of its CPU core for 10 minutes.", footer: { text: "Fredag" } });

    await call(c, "PUT", "/api/notifications", { events: { problems: false, servers: true } });
    sent = [];
    app.services.audit.record(null, "alert.raised", s.id, { kind: "disk", message: "The disk is 95% full." });
    await call(c, "POST", `/api/servers/${s.id}/stop`, {});
    await app.services.discord.flush();
    expect(titles()).toEqual(["Fredag stopped"]);
  });

  it("only Admins and the Owner can see or change it", async () => {
    const c = await login();
    await call(c, "POST", "/api/users", { steam: MOD, role: "moderator" });
    const m = await login(MOD);
    expect((await call(m, "GET", "/api/notifications")).status).toBe(403);
    expect((await call(m, "PUT", "/api/notifications", { webhook: HOOK })).status).toBe(403);
  });

  it("words events for people", () => {
    const n = { user: "Sune", server: "Fredag" };
    expect(describeEvent({ userId: 1, action: "game.update.start", serverId: null, details: { trigger: "new CS2 build 2001, no players online" } }, n)!.embed.description).toMatch(/Started automatically/);
    expect(describeEvent({ userId: null, action: "game.update.finish", serverId: null, details: { result: "failed", error: "steamcmd failed" } }, n)!.group).toBe("problems");
    expect(describeEvent({ userId: null, action: "server.restart", serverId: 1, details: { trigger: "scheduled restart" } }, n)).toMatchObject({ group: "restarts" });
    expect(describeEvent({ userId: 1, action: "server.restart", serverId: 1, details: {} }, n)).toMatchObject({ group: "servers", embed: { description: "By Sune." } });
    expect(describeEvent({ userId: 1, action: "config.save", serverId: 1, details: {} }, n)).toBeNull();
  });
});
