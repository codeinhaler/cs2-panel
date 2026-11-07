import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import type { A2sInfo } from "../src/game/a2s.js";
import { parseMeminfo, parseNetDev, parseProcStat, parseServiceStats } from "../src/host/stats.js";

const OWNER = "76561198000000001";

describe("stats parsing", () => {
  it("reads systemd, /proc/stat, /proc/meminfo and /proc/net/dev", () => {
    expect(parseServiceStats("CPUUsageNSec=123456789\nMemoryCurrent=1288490188\nNRestarts=2\n")).toEqual({ cpuNs: 123456789, memBytes: 1288490188, restarts: 2 });
    expect(parseServiceStats("CPUUsageNSec=[not set]\nMemoryCurrent=18446744073709551615\nNRestarts=0\n")).toEqual({ cpuNs: null, memBytes: null, restarts: 0 });
    expect(parseProcStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 25 0 12 200 12 0 0 0 0 0\ncpu1 25 0 13 200 13 0 0 0 0 0\nintr 1\n")).toEqual({ busy: 150, total: 1000, cpuCount: 2 });
    expect(parseMeminfo("MemTotal:       16000000 kB\nMemFree:  1000 kB\nMemAvailable:   12000000 kB\n")).toEqual({ total: 16000000 * 1024, available: 12000000 * 1024 });
    const net = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000      10    0    0    0     0          0         0     5000      10    0    0    0     0       0          0
  eth0: 1000      10    0    0    0     0          0         0     2000      10    0    0    0     0       0          0
  wg0:   500      10    0    0    0     0          0         0      300      10    0    0    0     0       0          0
`;
    expect(parseNetDev(net)).toEqual({ rx: 1500, tx: 2300 });
  });
});

let dir: string;
let app: App;
let host: FakeHost;
let db: Db;
let now: number;
const live = new Map<number, A2sInfo | null>();
let statusText = "";

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-monitor-"));
  now = Date.now() - 20 * 60_000;
  live.clear();
  statusText = "";
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    ownerSteamId: OWNER,
    secretKey: "77".repeat(32),
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
  host.clock = () => now;
  db = openDb(path.join(dir, "panel.db"));
  app = await buildApp({
    config,
    db,
    host,
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    rcon: async (_o, cmd) => (cmd === "status" ? statusText : ""),
    a2sQuery: async (port) => (live.has(port) ? live.get(port)! : { name: "x", map: "de_dust2", players: 5, maxPlayers: 10, bots: 3, version: "1" }),
  });
});

afterEach(async () => {
  await app.fastify.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login() {
  const res = await app.fastify.inject({ method: "GET", url: `/api/auth/dev?steamId=${OWNER}` });
  return `cs2p_session=${res.cookies.find((c) => c.name === "cs2p_session")!.value}`;
}
async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.fastify.inject({ method: method as "GET", url, headers: { cookie, host: "panel.lan" }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}
async function runningServer(c: string, name = "A", port = 27015) {
  const presets = (await call(c, "GET", "/api/presets")).body.presets;
  const s = (await call(c, "POST", "/api/servers", { name, presetId: presets[0].id, port })).body.server as { id: number; slug: string; port: number };
  await call(c, "POST", `/api/servers/${s.id}/start`, {});
  return s;
}
/** Takes n samples a minute apart. */
async function minutes(n: number) {
  for (let i = 0; i < n; i++) {
    now += 60_000;
    await app.services.monitor.sample(now);
  }
}
const actions = async (c: string) => ((await call(c, "GET", "/api/audit")).body.entries as { action: string; details: Record<string, unknown> }[]).map((e) => e.action);

describe("monitor", () => {
  it("records CPU, memory and players per server, and the machine's CPU, memory, disk and network", async () => {
    const c = await login();
    const s = await runningServer(c);
    host.cpuShare.set(s.slug, 0.5);
    await app.services.monitor.sample(now);
    await minutes(1);
    const m = (await call(c, "GET", "/api/monitor")).body;
    expect(m.latest[s.id]).toMatchObject({ cpu: 50, mem: 1.2 * 1024 ** 3, players: 2, bots: 3 });
    expect(m.latest[0]).toMatchObject({ cpu: 25, memTotal: 16 * 1024 ** 3, netRx: 50000, netTx: 120000 });
    expect(m.latest[0].diskUsed / m.latest[0].diskTotal).toBeCloseTo(0.3);
    expect(m.cpuCount).toBeGreaterThan(0);

    await minutes(10);
    const series = (await call(c, "GET", `/api/metrics?scope=${s.id}&range=1h`)).body;
    expect(series.bucketMs).toBe(60_000);
    expect(series.points.length).toBeGreaterThanOrEqual(11);
    expect(series.points.at(-1)).toMatchObject({ cpu: 50, players: 2 });
    expect((await call(c, "GET", "/api/metrics?scope=999&range=1h")).status).toBe(404);
  });

  it("warns about a server using its whole core for 10 minutes, and clears it", async () => {
    const c = await login();
    const s = await runningServer(c);
    host.cpuShare.set(s.slug, 0.97);
    await app.services.monitor.sample(now);
    await minutes(9);
    expect((await call(c, "GET", "/api/alerts")).body.alerts).toEqual([]);
    await minutes(1);
    const alerts = (await call(c, "GET", "/api/alerts")).body.alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "server.cpu", serverName: "A" });
    expect(alerts[0].message).toMatch(/97% of its CPU core/);
    await minutes(2); // still high: no second alert
    expect((await call(c, "GET", "/api/alerts?all=1")).body.alerts).toHaveLength(1);

    host.cpuShare.set(s.slug, 0.2);
    await minutes(5);
    expect((await call(c, "GET", "/api/alerts")).body.alerts).toEqual([]);
    expect((await actions(c)).slice(0, 2)).toEqual(["alert.cleared", "alert.raised"]);
  });

  it("warns when a running server stops answering, and notices crashes", async () => {
    const c = await login();
    const s = await runningServer(c);
    host.since.set(s.slug, new Date(now - 10 * 60_000).toISOString());
    live.set(s.port, null);
    await app.services.monitor.sample(now);
    await minutes(4);
    expect((await call(c, "GET", "/api/alerts")).body.alerts).toEqual([]);
    await minutes(1);
    expect((await call(c, "GET", "/api/alerts")).body.alerts[0]).toMatchObject({ kind: "server.not_answering" });
    live.delete(s.port);
    await minutes(1);
    expect((await call(c, "GET", "/api/alerts")).body.alerts).toEqual([]);

    host.crashRestarts.set(s.slug, 1);
    await minutes(1);
    expect(await actions(c)).toContain("server.crashed");
  });

  it("warns about a nearly full disk and high memory", async () => {
    const c = await login();
    host.machine.diskUsedShare = 0.95;
    host.machine.memUsedShare = 0.93;
    await app.services.monitor.sample(now);
    await minutes(5);
    const kinds = (await call(c, "GET", "/api/alerts")).body.alerts.map((a: { kind: string }) => a.kind).sort();
    expect(kinds).toEqual(["disk", "machine.mem"]);
  });

  it("keeps hourly averages for the long ranges", async () => {
    const c = await login();
    const s = await runningServer(c);
    host.cpuShare.set(s.slug, 0.4);
    await app.services.monitor.sample(now);
    await minutes(125); // crosses two hour boundaries
    const hourly = db.prepare("SELECT COUNT(*) AS n FROM metrics WHERE res = 1 AND scope = ?").get(s.id) as { n: number };
    expect(hourly.n).toBeGreaterThanOrEqual(2);
    const long = (await call(c, "GET", `/api/metrics?scope=${s.id}&range=30d`)).body;
    expect(long.bucketMs).toBeGreaterThanOrEqual(3_600_000);
    // The very first sample has no CPU yet (it is measured between samples), so skip an hour holding only that one.
    expect(long.points.find((p: { cpu: number | null }) => p.cpu !== null).cpu).toBeCloseTo(40, 0);
  });

  it("counts people and bots from the server's own status when Steam's query gets them wrong", async () => {
    const c = await login();
    const s = await runningServer(c);
    // Steam's query: 10 players of which 8 bots (so "2 people"); the real status: 1 person, 9 bots.
    live.set(s.port, { name: "x", map: "de_inferno", players: 10, maxPlayers: 20, bots: 8, version: "1" });
    statusText = `---------players--------
  id     time ping loss      state   rate adr name
${Array.from({ length: 9 }, (_, i) => `     ${i + 1}      BOT    0    0     active      0 'Bot${i}'`).join("\n")}
    10    29:22   25    0     active 786432 2.110.18.243:21046 'tsunamo'
#end
`;
    await app.services.players.live(s.id);
    expect(app.services.players.recentCounts(s.id)).toEqual({ humans: 1, bots: 9 });
    await app.services.monitor.sample(now);
    expect((await call(c, "GET", "/api/monitor")).body.latest[s.id]).toMatchObject({ players: 1, bots: 9 });
  });
});

