import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { formatCpuList, normalizeCpuList, parseCpuList } from "../src/cpu/cpulist.js";
import { readTopology, type SysReader } from "../src/cpu/topology.js";
import { allocate, conflictsOf, DEFAULT_POLICY, type CpuPolicy } from "../src/cpu/allocate.js";
import { buildBlocks, groupBlocks, summarize, type ServerCpuRow } from "../src/cpu/overview.js";
import { CpuUsageSampler, cpuPercents, groupPercent, parsePerCpuStat } from "../src/cpu/usage.js";

// ------------------------------------------------------------------ fake /sys and /proc

type Tree = Record<string, string>;

/** A SysReader over an in-memory file tree; pass a function to swap the tree between calls. */
function memSys(src: Tree | (() => Tree)): SysReader {
  const tree = () => (typeof src === "function" ? src() : src);
  return {
    read: async (rel) => (rel in tree() ? tree()[rel]!.trim() : null),
    list: async (rel) => {
      const prefix = rel.replace(/\/$/, "") + "/";
      return [
        ...new Set(
          Object.keys(tree())
            .filter((k) => k.startsWith(prefix))
            .map((k) => k.slice(prefix.length).split("/")[0]!),
        ),
      ];
    },
  };
}

interface CpuSpec {
  id: number;
  core: number | null;
  pkg?: number;
  siblings?: number[];
  llc?: string;
}

function machine(opts: {
  model?: string;
  cpus: CpuSpec[];
  online?: string;
  allowed?: string;
  vm?: string;
  pCores?: string;
  eCores?: string;
  nodes?: Record<number, string>;
}): Tree {
  const t: Tree = {};
  const ids = opts.cpus.map((c) => c.id);
  t["proc/cpuinfo"] = `processor\t: 0\nmodel name\t: ${opts.model ?? "Test CPU"}\nflags\t\t: fpu sse2${opts.vm ? " hypervisor" : ""}\n`;
  t["sys/devices/system/cpu/online"] = opts.online ?? formatCpuList(ids);
  t["proc/self/status"] = `Name:\tnode\nCpus_allowed_list:\t${opts.allowed ?? formatCpuList(ids)}\n`;
  if (opts.vm) t["sys/class/dmi/id/sys_vendor"] = opts.vm;
  if (opts.pCores) t["sys/devices/cpu_core/cpus"] = opts.pCores;
  if (opts.eCores) t["sys/devices/cpu_atom/cpus"] = opts.eCores;
  for (const [n, list] of Object.entries(opts.nodes ?? {})) t[`sys/devices/system/node/node${n}/cpulist`] = list;
  for (const c of opts.cpus) {
    const base = `sys/devices/system/cpu/cpu${c.id}`;
    if (c.core !== null) t[`${base}/topology/core_id`] = String(c.core);
    t[`${base}/topology/physical_package_id`] = String(c.pkg ?? 0);
    t[`${base}/topology/thread_siblings_list`] = formatCpuList(c.siblings ?? [c.id]);
    t[`${base}/cache/index0/level`] = "1";
    t[`${base}/cache/index0/shared_cpu_list`] = formatCpuList(c.siblings ?? [c.id]);
    if (c.llc) {
      t[`${base}/cache/index3/level`] = "3";
      t[`${base}/cache/index3/shared_cpu_list`] = c.llc;
    }
  }
  return t;
}

/** Ryzen 9 9900X-like: 12 cores, SMT (CPU n and n+12), two CCDs with their own L3. */
const amd = () =>
  machine({
    model: "AMD Ryzen 9 9900X 12-Core Processor",
    cpus: Array.from({ length: 24 }, (_, id) => {
      const core = id % 12;
      return { id, core, siblings: [core, core + 12], llc: core < 6 ? "0-5,12-17" : "6-11,18-23" };
    }),
  });

/** i7-1360P-like on bare metal: 4 P-cores with Hyper-Threading (0-7), 8 E-cores (8-15). */
const intelHybrid = () =>
  machine({
    model: "13th Gen Intel(R) Core(TM) i7-1360P",
    cpus: Array.from({ length: 16 }, (_, id) =>
      id < 8 ? { id, core: Math.floor(id / 2) * 4, siblings: [id - (id % 2), id - (id % 2) + 1], llc: "0-15" } : { id, core: 16 + id, llc: "0-15" },
    ),
    pCores: "0-7",
    eCores: "8-15",
  });

/** Sune's ESXi VM: 5 vCPUs, 1 core per socket, no SMT. */
const esxi = () =>
  machine({ model: "13th Gen Intel(R) Core(TM) i7-1360P", vm: "VMware, Inc.", cpus: Array.from({ length: 5 }, (_, id) => ({ id, core: 0, pkg: id })) });

/** A KVM guest that shows 2 cores with 2 threads each. */
const kvmSmt = () =>
  machine({
    vm: "QEMU",
    cpus: [
      { id: 0, core: 0, siblings: [0, 1] },
      { id: 1, core: 0, siblings: [0, 1] },
      { id: 2, core: 1, siblings: [2, 3] },
      { id: 3, core: 1, siblings: [2, 3] },
    ],
  });

// ------------------------------------------------------------------ CPU lists

describe("CPU lists", () => {
  it("parses, normalises and formats lists the way taskset and Linux write them", () => {
    expect(parseCpuList("2")).toEqual([2]);
    expect(parseCpuList("14, 2")).toEqual([2, 14]);
    expect(parseCpuList("2-4,14-16")).toEqual([2, 3, 4, 14, 15, 16]);
    expect(normalizeCpuList("4,3, 2,2")).toBe("2-4");
    expect(formatCpuList([0, 1, 3, 4, 5, 8])).toBe("0,1,3-5,8");
    for (const bad of ["", "a", "2;rm -rf /", "4-2", "1,,x", "2048"]) expect(() => parseCpuList(bad)).toThrow();
  });
});

// ------------------------------------------------------------------ topology

describe("CPU topology", () => {
  it("bare-metal AMD with SMT: 12 cores of 2 threads, grouped by CCD cache", async () => {
    const t = await readTopology(memSys(amd()));
    expect(t).toMatchObject({ kind: "physical", smt: true, hybrid: false, packages: 1, llcGroups: 2, restricted: false });
    expect(t.cores).toHaveLength(12);
    expect(t.cpus).toHaveLength(24);
    expect(t.cores[0]).toMatchObject({ label: "Core 0", cpus: [0, 12], llc: "0-5,12-17" });
    expect(t.virtualization.detected).toBe(false);
  });

  it("Intel hybrid: P-cores with Hyper-Threading and E-cores told apart", async () => {
    const t = await readTopology(memSys(intelHybrid()));
    expect(t).toMatchObject({ kind: "physical", hybrid: true, smt: true });
    expect(t.cores).toHaveLength(12);
    expect(t.cores[0]).toMatchObject({ cpus: [0, 1], type: "performance" });
    expect(t.cores.at(-1)).toMatchObject({ cpus: [15], type: "efficiency" });
  });

  it("an ESXi VM without SMT shows plain vCPUs, never physical cores or 5 sockets", async () => {
    const t = await readTopology(memSys(esxi()));
    expect(t).toMatchObject({ kind: "logical", virtualization: { detected: true, vendor: "VMware" }, hybrid: false });
    expect(t.cores.map((c) => c.label)).toEqual(["vCPU 0", "vCPU 1", "vCPU 2", "vCPU 3", "vCPU 4"]);
    expect(t.notes.join(" ")).toMatch(/virtual CPUs/);
  });

  it("a KVM guest with SMT shows its own layout, labelled as virtual", async () => {
    const t = await readTopology(memSys(kvmSmt()));
    expect(t).toMatchObject({ kind: "guest", smt: true, virtualization: { vendor: "KVM/QEMU" } });
    expect(t.cores.map((c) => [c.label, c.cpus])).toEqual([
      ["Virtual core 0", [0, 1]],
      ["Virtual core 1", [2, 3]],
    ]);
    expect(t.notes.join(" ")).toMatch(/not the host's real cores/);
  });

  it("a hybrid CPU inside a VM isn't treated as hybrid (the guest can't know)", async () => {
    const tree = intelHybrid();
    tree["proc/cpuinfo"] += "flags\t\t: hypervisor\n";
    tree["sys/class/dmi/id/sys_vendor"] = "VMware, Inc.";
    const t = await readTopology(memSys(tree));
    expect(t.hybrid).toBe(false);
    expect(t.kind).toBe("guest");
  });

  it("single vCPU, non-contiguous CPUs, restricted affinity and missing files", async () => {
    expect((await readTopology(memSys(machine({ vm: "Microsoft Corporation Virtual Machine", cpus: [{ id: 0, core: 0 }] })))).cores).toHaveLength(1);

    const gaps = await readTopology(memSys(machine({ cpus: [0, 1, 4, 5].map((id) => ({ id, core: id })), online: "0-1,4-5" })));
    expect(gaps.cpus.map((c) => c.id)).toEqual([0, 1, 4, 5]);

    const limited = await readTopology(memSys(machine({ cpus: [0, 1, 2, 3].map((id) => ({ id, core: id })), allowed: "2-3" })));
    expect(limited).toMatchObject({ restricted: true });
    expect(limited.cpus.map((c) => c.id)).toEqual([2, 3]);

    // No core IDs (some containers): plain CPUs, still usable.
    const bare = await readTopology(memSys(machine({ cpus: [0, 1].map((id) => ({ id, core: null })) })));
    expect(bare.kind).toBe("logical");
    expect(bare.cores.map((c) => c.label)).toEqual(["CPU 0", "CPU 1"]);

    // Nothing readable at all: falls back to the CPUs Node sees.
    const none = await readTopology(memSys({}));
    expect(none.cpus.length).toBeGreaterThan(0);
  });

  it("handles 128 logical CPUs on two sockets and NUMA nodes", async () => {
    const t = await readTopology(
      memSys(
        machine({
          cpus: Array.from({ length: 128 }, (_, id) => {
            const core = id % 64;
            return { id, core: core % 32, pkg: core < 32 ? 0 : 1, siblings: [core, core + 64] };
          }),
          nodes: { 0: "0-31,64-95", 1: "32-63,96-127" },
        }),
      ),
    );
    expect(t).toMatchObject({ kind: "physical", packages: 2, nodes: 2 });
    expect(t.cores).toHaveLength(64);
  });
});

// ------------------------------------------------------------------ allocation

const policy = (p: Partial<CpuPolicy> = {}): CpuPolicy => ({ ...DEFAULT_POLICY, mode: "auto", ...p });

describe("automatic allocation", () => {
  it("gives each server its own physical core with its SMT sibling, skipping reserved CPUs", async () => {
    const t = await readTopology(memSys(amd()));
    expect(allocate(t, policy(), []).cpus).toEqual([0, 12]);
    expect(allocate(t, policy(), [{ serverId: 1, name: "Casual", cpus: [0, 12] }]).cpus).toEqual([1, 13]);
    expect(allocate(t, policy({ reserved: [0, 12] }), []).cpus).toEqual([1, 13]);
    // Without siblings: one thread, but never the other thread of a used core.
    expect(allocate(t, policy({ includeSmtSiblings: false }), [{ serverId: 1, name: "A", cpus: [0] }]).cpus).toEqual([1]);
  });

  it("prefers P-cores, and says so when only E-cores are left", async () => {
    const t = await readTopology(memSys(intelHybrid()));
    const pTaken = [0, 2, 4, 6].map((c, i) => ({ serverId: i, name: `S${i}`, cpus: [c, c + 1] }));
    expect(allocate(t, policy(), []).cpus).toEqual([0, 1]);
    const e = allocate(t, policy(), pTaken);
    expect(e.cpus).toEqual([8]);
    expect(e.warnings.join(" ")).toMatch(/E-core/);
    expect(allocate(t, policy({ preferPerformance: false }), []).cpus).toEqual([0, 1]);
  });

  it("falls back to vCPUs in a VM, and shares (with a warning) when everything is taken", async () => {
    const t = await readTopology(memSys(esxi()));
    expect(allocate(t, policy({ reserved: [4] }), []).cpus).toEqual([0]);
    const full = [0, 1, 2, 3].map((c) => ({ serverId: c, name: `Match #${c}`, cpus: [c] }));
    const shared = allocate(t, policy({ reserved: [4] }), full);
    expect(shared.cpus).toEqual([0]);
    expect(shared.warnings[0]).toMatch(/also used by Match #0/);
    expect(allocate(t, policy({ reserved: [4], allowSharing: true }), full).warnings[0]).toMatch(/shares vCPU 0 with Match #0/);
    expect(allocate(t, policy({ reserved: [0, 1, 2, 3, 4] }), []).warnings[0]).toMatch(/Every CPU is reserved/);
  });

  it("allocates quickly on 128 CPUs", async () => {
    const tree = machine({ cpus: Array.from({ length: 128 }, (_, id) => ({ id, core: id % 64, siblings: [id % 64, (id % 64) + 64] })) });
    const t = await readTopology(memSys(tree));
    const taken = Array.from({ length: 60 }, (_, i) => ({ serverId: i, name: `S${i}`, cpus: [i, i + 64] }));
    const start = performance.now();
    expect(allocate(t, policy(), taken).cpus).toEqual([60, 124]);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("flags servers sharing a CPU or the other thread of a core", async () => {
    const t = await readTopology(memSys(amd()));
    const a = { serverId: 1, name: "A", cpus: [0] };
    const b = { serverId: 2, name: "B", cpus: [12] };
    const c = { serverId: 3, name: "C", cpus: [0, 12] };
    expect(conflictsOf(t, a, [a, b])).toEqual([{ serverId: 2, name: "B", kind: "same-core", cpus: "12" }]);
    expect(conflictsOf(t, c, [a, c])).toEqual([{ serverId: 1, name: "A", kind: "same-cpu", cpus: "0" }]);
    // In a VM without topology, only the same vCPU counts.
    const vm = await readTopology(memSys(esxi()));
    expect(conflictsOf(vm, { serverId: 1, name: "A", cpus: [0] }, [{ serverId: 2, name: "B", cpus: [1] }])).toEqual([]);
  });
});

// ------------------------------------------------------------------ usage and overview

const stat = (cpus: [number, number, number][]) => `cpu  0 0 0 0\n${cpus.map(([id, busy, idle]) => `cpu${id} ${busy} 0 0 ${idle} 0 0 0 0`).join("\n")}\n`;

describe("CPU utilization", () => {
  it("counts a core's threads once (busy share of their combined time, never 200%)", () => {
    const a = parsePerCpuStat(
      stat([
        [0, 0, 0],
        [12, 0, 0],
      ]),
    );
    const b = parsePerCpuStat(
      stat([
        [0, 50, 50],
        [12, 0, 100],
      ]),
    );
    expect(cpuPercents(a, b).get(0)).toBe(50);
    expect(groupPercent(a, b, [0, 12])).toBe(25);
    expect(groupPercent(a, b, [0, 0, 12])).toBe(25);
    expect(groupPercent(a, b, [99])).toBeNull();
  });

  it("reads /proc/stat at most once per interval, and copes with it missing", async () => {
    let reads = 0;
    let t = 0;
    const s = new CpuUsageSampler(
      async () => (reads++, stat([[0, reads * 10, reads * 10]])),
      () => t,
    );
    expect(await s.sample()).toBeNull();
    t = 2_500;
    expect(await s.sample()).not.toBeNull();
    t = 3_000;
    await s.sample();
    expect(reads).toBe(2);
    expect(await new CpuUsageSampler(async () => null).sample()).toBeNull();
  });
});

const row = (r: Partial<ServerCpuRow> & { id: number; configured: number[] }): ServerCpuRow => ({
  name: `S${r.id}`,
  state: "inactive",
  mode: "manual",
  configuredText: formatCpuList(r.configured),
  launch: r.configured,
  actual: null,
  actualText: null,
  verify: "stopped",
  pendingRestart: false,
  missing: [],
  conflicts: [],
  ...r,
});

describe("CPU overview", () => {
  it("marks free, assigned, shared/conflicting, reserved, pending and mismatched cores, and counts cores once", async () => {
    const t = await readTopology(memSys(amd()));
    const rows = [
      row({ id: 1, configured: [0, 12] }),
      row({ id: 2, configured: [1], pendingRestart: true, state: "active", verify: "match" }),
      row({ id: 3, configured: [13], conflicts: [{ serverId: 2, name: "S2", kind: "same-core", cpus: "1" }] }),
      row({ id: 4, configured: [2, 14], verify: "mismatch", state: "active" }),
    ];
    rows[1]!.conflicts = [{ serverId: 3, name: "S3", kind: "same-core", cpus: "13" }];
    const p = policy({ reserved: [11, 23] });
    const usage = {
      prev: parsePerCpuStat(
        stat([
          [0, 0, 0],
          [12, 0, 0],
        ]),
      ),
      now: parsePerCpuStat(
        stat([
          [0, 80, 20],
          [12, 40, 60],
        ]),
      ),
    };
    const blocks = buildBlocks(t, p, rows, usage);
    const b = (i: number) => blocks[i]!;
    expect(b(0)).toMatchObject({ status: "assigned", usage: 60, servers: [{ id: 1, cpus: [0, 12] }] });
    expect(b(1).flags).toEqual(["assigned", "conflict", "pending"]);
    expect(b(1).status).toBe("conflict");
    expect(b(2).status).toBe("mismatch");
    expect(b(3).status).toBe("free");
    expect(b(11).status).toBe("reserved");
    expect(buildBlocks(t, { ...p, allowSharing: true }, rows, null)[1]!.status).toBe("pending");
    expect(summarize(t, p, blocks, rows)).toEqual({
      unit: "cores",
      cores: 12,
      logical: 24,
      assigned: 3,
      reserved: 1,
      free: 8,
      conflicts: 1,
      mismatches: 1,
      pending: 1,
      missing: 0,
    });
    expect(groupBlocks(t, blocks).map((g) => [g.label, g.blocks.length])).toEqual([
      ["Shared cache (CPUs 0-5,12-17)", 6],
      ["Shared cache (CPUs 6-11,18-23)", 6],
    ]);
  });

  it("shows vCPUs (not cores) in a VM, and P/E groups on a hybrid CPU", async () => {
    const vm = await readTopology(memSys(esxi()));
    const blocks = buildBlocks(vm, policy({ reserved: [4] }), [row({ id: 1, configured: [0] })], null);
    expect(blocks.map((x) => `${x.label}:${x.status}`)).toEqual(["vCPU 0:assigned", "vCPU 1:free", "vCPU 2:free", "vCPU 3:free", "vCPU 4:reserved"]);
    expect(summarize(vm, policy(), blocks, [])).toMatchObject({ unit: "cpus", cores: null, logical: 5, free: 3, reserved: 1 });
    expect(groupBlocks(vm, blocks).map((g) => g.label)).toEqual(["Virtual CPUs"]);
    const hybrid = await readTopology(memSys(intelHybrid()));
    expect(groupBlocks(hybrid, buildBlocks(hybrid, policy(), [], null)).map((g) => [g.label, g.blocks.length])).toEqual([
      ["Performance cores (P)", 4],
      ["Efficiency cores (E)", 8],
    ]);
  });
});

// ------------------------------------------------------------------ the panel

const OWNER = "76561198000000001";
const MOD = "76561198000000003";
let dir: string;
let app: App;
let tree: Tree;

let config: Config;
let host: FakeHost;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs2panel-cpu-"));
  tree = esxi();
  config = {
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
  host = new FakeHost(config.cs2Root, config.instanceEnvDir);
  await boot();
});

/** Builds the panel on this test's files (again, to act like an upgrade or restart). */
async function boot() {
  app = await buildApp({
    config,
    db: openDb(path.join(dir, "panel.db")),
    host,
    logLevel: "silent",
    pluginCheckDelayMs: 0,
    a2sQuery: async () => null,
    rcon: async () => "",
    cpuSys: memSys(() => tree),
  });
}

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
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}
async function newServer(c: string, name: string, port: number, extra: Record<string, unknown> = {}) {
  const presets = (await call(c, "GET", "/api/presets")).body.presets;
  const res = await call(c, "POST", "/api/servers", { name, presetId: presets[0].id, port, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.server as { id: number; slug: string; cpu: number; cpus: string; cpuMode: string };
}
const envOf = (slug: string) => readFileSync(path.join(dir, "env", `${slug}.env`), "utf8");
const cpuRow = async (c: string, id: number) => ((await call(c, "GET", "/api/cpu")).body.servers as ServerCpuRow[]).find((r) => r.id === id)!;

describe("CPU Management in the panel", () => {
  it("keeps the old behaviour by default: Legacy, one CPU per server, existing assignments untouched", async () => {
    const c = await login();
    const a = await newServer(c, "Casual", 27015);
    expect(a).toMatchObject({ cpu: 0, cpus: "0", cpuMode: "manual" });
    const overview = (await call(c, "GET", "/api/cpu")).body;
    expect(overview.policy).toMatchObject({ mode: "legacy", reserved: "" });
    expect(overview.topology).toMatchObject({ kind: "logical", virtualization: { vendor: "VMware" } });
    // The old API still works: one CPU by number.
    expect((await call(c, "PATCH", `/api/servers/${a.id}`, { cpu: 3 })).body.server).toMatchObject({ cpu: 3, cpus: "3", cpuMode: "manual" });
    expect((await call(c, "PATCH", `/api/servers/${a.id}`, { cpu: 9 })).status).toBe(400);
    await call(c, "POST", `/api/servers/${a.id}/start`);
    expect(envOf(a.slug)).toContain("CS2_CPU=3\n");
  });

  it("upgrades an existing database without touching its servers' CPUs", async () => {
    const c = await login();
    const a = await newServer(c, "Old server", 27015, { cpu: 3 });
    await app.fastify.close();
    // Back to the database as it was before CPU lists (migration 12).
    const old = new DatabaseSync(path.join(dir, "panel.db"));
    old.exec(
      "ALTER TABLE servers DROP COLUMN cpu_set; ALTER TABLE servers DROP COLUMN cpu_mode;" +
        // And without the later tables (migration 14 on), as a database from then was.
        "DROP TABLE discord_links; DROP TABLE discord_users; DROP TABLE discord_sessions; DROP TABLE discord_moves; DROP TABLE discord_channels;" +
        "PRAGMA user_version = 12;",
    );
    old.close();
    await boot();
    const c2 = await login();
    expect((await call(c2, "GET", `/api/servers/${a.id}`)).body.server).toMatchObject({ cpu: 3, cpus: "3", cpuMode: "manual" });
    expect((await call(c2, "GET", "/api/cpu")).body.policy.mode).toBe("legacy");
    await call(c2, "POST", `/api/servers/${a.id}/start`);
    expect(envOf(a.slug)).toContain("CS2_CPU=3\n");
  });

  it("changes CPUs in one place for every page: manual lists, automatic, and reset", async () => {
    const c = await login();
    const a = await newServer(c, "Match #1", 27015);
    const b = await newServer(c, "Match #2", 27025, { cpu: 1 });
    expect((await call(c, "PUT", `/api/servers/${a.id}/cpu`, { mode: "manual", cpus: "2-3" })).body.row).toMatchObject({
      configuredText: "2,3",
      mode: "manual",
    });
    // The server page sees the same.
    expect((await call(c, "GET", `/api/servers/${a.id}`)).body.server).toMatchObject({ cpu: 2, cpus: "2,3", cpuMode: "manual" });
    // Bad and unknown lists are refused before anything is written.
    expect((await call(c, "PUT", `/api/servers/${a.id}/cpu`, { mode: "manual", cpus: "2;reboot" })).status).toBe(400);
    expect((await call(c, "PUT", `/api/servers/${a.id}/cpu`, { mode: "manual", cpus: "7" })).body.error).toMatch(/no CPU 7/);
    // Conflict with sharing off: saved, but flagged.
    const shared = (await call(c, "PUT", `/api/servers/${a.id}/cpu`, { mode: "manual", cpus: "1" })).body;
    expect(shared.warnings[0]).toMatch(/Match #2/);
    expect((await cpuRow(c, b.id)).conflicts).toEqual([{ serverId: a.id, name: "Match #1", kind: "same-cpu", cpus: "1" }]);
    // Reset to automatic: the policy picks a free vCPU (reserving the E-core vCPU 4).
    await call(c, "PUT", "/api/cpu/policy", {
      mode: "auto",
      includeSmtSiblings: true,
      allowSharing: false,
      reserved: "4",
      preferPerformance: true,
      topologyAware: true,
    });
    expect((await call(c, "PUT", `/api/servers/${a.id}/cpu`, { mode: "auto" })).body.row).toMatchObject({ configuredText: "0", mode: "auto", conflicts: [] });
  });

  it("new servers follow the policy: automatic picks a free vCPU, manual pre-fills it, reserved CPUs are skipped", async () => {
    const c = await login();
    await call(c, "PUT", "/api/cpu/policy", {
      mode: "auto",
      includeSmtSiblings: true,
      allowSharing: false,
      reserved: "4",
      preferPerformance: true,
      topologyAware: true,
    });
    const names = ["Casual", "Comp #1", "Comp #2", "Wingman", "1v1"];
    const made = [];
    for (const [i, n] of names.entries()) made.push(await newServer(c, n, 27015 + i * 10));
    expect(made.map((s) => s.cpus)).toEqual(["0", "1", "2", "3", "0"]);
    expect(made[0]!.cpuMode).toBe("auto");
    expect((await call(c, "GET", "/api/cpu/suggest")).body.warnings[0]).toMatch(/also used by/);
    await call(c, "PUT", "/api/cpu/policy", {
      mode: "manual",
      includeSmtSiblings: true,
      allowSharing: true,
      reserved: "",
      preferPerformance: true,
      topologyAware: true,
    });
    expect((await call(c, "GET", "/api/cpu/suggest")).body).toMatchObject({ mode: "manual", policy: "manual" });
    expect((await newServer(c, "Listed", 27095, { cpuSet: "3-4" })).cpus).toBe("3,4");
    expect(
      (
        await call(c, "PUT", "/api/cpu/policy", {
          mode: "auto",
          includeSmtSiblings: true,
          allowSharing: false,
          reserved: "0-4",
          preferPerformance: true,
          topologyAware: true,
        })
      ).body.error,
    ).toMatch(/at least one/);
  });

  it("doesn't restart a running server: shows Restart required until the next start, and reads the real affinity", async () => {
    const c = await login();
    const a = await newServer(c, "Match #1", 27015, { cpu: 0 });
    await call(c, "POST", `/api/servers/${a.id}/start`);
    tree["proc/4242/status"] = "Name:\tcs2\nCpus_allowed_list:\t0\n";
    expect(await cpuRow(c, a.id)).toMatchObject({ verify: "match", pendingRestart: false, actualText: "0" });

    const changed = (await call(c, "PUT", `/api/servers/${a.id}/cpu`, { mode: "manual", cpus: "1-2" })).body.row;
    expect(changed).toMatchObject({ state: "active", configuredText: "1,2", actualText: "0", verify: "match", pendingRestart: true });
    const ov = (await call(c, "GET", "/api/cpu")).body;
    expect(ov.summary.pending).toBe(1);
    expect(ov.groups[0].blocks[1].flags).toContain("pending");

    await call(c, "POST", `/api/servers/${a.id}/restart`);
    expect(envOf(a.slug)).toContain("CS2_CPU=1,2\n");
    tree["proc/4242/status"] = "Name:\tcs2\nCpus_allowed_list:\t1-2\n";
    expect(await cpuRow(c, a.id)).toMatchObject({ verify: "match", pendingRestart: false });

    // Something else changed the process's affinity: flagged, never "fixed" by the panel.
    tree["proc/4242/status"] = "Name:\tcs2\nCpus_allowed_list:\t0-4\n";
    expect(await cpuRow(c, a.id)).toMatchObject({ verify: "mismatch" });
    expect((await call(c, "GET", "/api/cpu")).body.summary.mismatches).toBe(1);
    // And when /proc can't be read: unknown, not an error.
    delete tree["proc/4242/status"];
    expect(await cpuRow(c, a.id)).toMatchObject({ verify: "unknown" });
  });

  it("still starts a server whose CPUs disappeared (fewer vCPUs after a VM change)", async () => {
    const c = await login();
    const a = await newServer(c, "Match #1", 27015, { cpuSet: "3-4" });
    tree = machine({ vm: "VMware, Inc.", cpus: [0, 1, 2, 3].map((id) => ({ id, core: 0, pkg: id })) });
    const ov = (await call(c, "GET", "/api/cpu?refresh=1")).body;
    expect(ov.servers[0]).toMatchObject({ missing: [4], configuredText: "3,4" });
    expect(ov.summary.missing).toBe(1);
    await call(c, "POST", `/api/servers/${a.id}/start`);
    expect(envOf(a.slug)).toContain("CS2_CPU=3\n");
    // None left: it runs on all of them rather than not at all.
    await call(c, "POST", `/api/servers/${a.id}/stop`);
    tree = machine({ vm: "VMware, Inc.", cpus: [0, 1].map((id) => ({ id, core: 0, pkg: id })) });
    await call(c, "GET", "/api/cpu?refresh=1");
    await call(c, "POST", `/api/servers/${a.id}/start`);
    expect(envOf(a.slug)).toContain("CS2_CPU=0,1\n");
  });

  it("serves live usage, and only lets server managers change CPUs", async () => {
    const c = await login();
    const a = await newServer(c, "Match #1", 27015);
    tree["proc/stat"] = stat([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    const first = (await call(c, "GET", "/api/cpu/usage")).body;
    expect(first.available).toBe(false); // Only one reading of /proc/stat so far (it didn't change in 300 ms).
    await call(c, "POST", "/api/users", { steam: MOD, role: "moderator" });
    const m = await login(MOD);
    expect((await call(m, "GET", "/api/cpu")).status).toBe(200);
    expect((await call(m, "PUT", `/api/servers/${a.id}/cpu`, { mode: "manual", cpus: "1" })).status).toBe(403);
    expect((await call(m, "PUT", "/api/cpu/policy", { ...DEFAULT_POLICY, reserved: "" })).status).toBe(403);
  });
});
