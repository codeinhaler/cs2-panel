// CPU Management: the machine's CPUs, the allocation policy, each server's CPUs and whether the running
// process really uses them. Used by the CPU Management page, its overview, and each server's Settings tab.
import { z } from "zod";
import type { AuditLog } from "../audit.js";
import { badRequest } from "../errors.js";
import type { Host } from "../host/host.js";
import type { Settings } from "../settings.js";
import type { CpuHooks, ServerService } from "../servers/service.js";
import type { ServerRecord } from "../servers/store.js";
import { allocate, conflictsOf, DEFAULT_POLICY, type Assignment, type CpuPolicy } from "./allocate.js";
import { formatCpuList, parseCpuList, sameCpus, tryParseCpuList } from "./cpulist.js";
import { buildBlocks, groupBlocks, summarize, type ServerCpuRow } from "./overview.js";
import { readTopology, sysReader, type CpuTopology, type SysReader } from "./topology.js";
import { CpuUsageSampler, groupPercent } from "./usage.js";

const PolicySchema = z.object({
  mode: z.enum(["legacy", "auto", "manual"]),
  includeSmtSiblings: z.boolean(),
  allowSharing: z.boolean(),
  /** A CPU list; empty for none. */
  reserved: z.string().trim().max(400),
  preferPerformance: z.boolean(),
  topologyAware: z.boolean(),
});

const AssignSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  cpus: z.string().trim().max(400).optional(),
});

const TOPOLOGY_TTL_MS = 60_000;

export interface CpuDeps {
  settings: Settings;
  servers: ServerService;
  host: Host;
  audit: AuditLog;
  /** /sys and /proc; tests use a fake tree. */
  sys?: SysReader;
  now?: () => number;
}

export class CpuService implements CpuHooks {
  private readonly sys: SysReader;
  private readonly now: () => number;
  private topo: { at: number; t: CpuTopology } | null = null;
  /** The CPUs each server was last started on (from this panel run), to tell "restart to apply" from a real mismatch. */
  private startedWith = new Map<number, number[]>();
  readonly sampler: CpuUsageSampler;

  constructor(private readonly d: CpuDeps) {
    this.sys = d.sys ?? sysReader();
    this.now = d.now ?? Date.now;
    this.sampler = new CpuUsageSampler(() => this.sys.read("proc/stat"), this.now);
  }

  // ------------------------------------------------------------- topology and policy

  /** Cached for a minute; read again after a reboot, a VM change or on "Refresh". */
  async topology(refresh = false): Promise<CpuTopology> {
    if (!refresh && this.topo && this.now() - this.topo.at < TOPOLOGY_TTL_MS) return this.topo.t;
    const t = await readTopology(this.sys);
    this.topo = { at: this.now(), t };
    return t;
  }

  /** Installations from before CPU Management have no policy saved: Legacy, like before. */
  policy(): CpuPolicy {
    const stored = this.d.settings.get<Partial<CpuPolicy> | null>("cpu.policy", null) ?? {};
    return { ...DEFAULT_POLICY, ...stored, reserved: Array.isArray(stored.reserved) ? stored.reserved : [] };
  }

  async setPolicy(raw: unknown, actorId: number): Promise<CpuPolicy> {
    const p = PolicySchema.parse(raw);
    let reserved: number[] = [];
    if (p.reserved) {
      try {
        reserved = parseCpuList(p.reserved);
      } catch (e) {
        throw badRequest(`Reserved CPUs: ${(e as Error).message}`);
      }
      const t = await this.topology();
      const unknown = reserved.filter((c) => !t.cpus.some((x) => x.id === c));
      if (unknown.length)
        throw badRequest(`Reserved CPUs: this machine has no CPU ${formatCpuList(unknown)} (it has ${formatCpuList(t.cpus.map((c) => c.id))}).`);
      if (reserved.length >= t.cpus.length) throw badRequest("Leave at least one CPU unreserved for game servers.");
    }
    const policy: CpuPolicy = { ...p, reserved };
    this.d.settings.set("cpu.policy", policy);
    this.d.audit.record(actorId, "cpu.policy", null, { mode: policy.mode, reserved: formatCpuList(reserved) || "none" });
    return policy;
  }

  // ------------------------------------------------------------- assignments

  /** The CPUs a server is set to. */
  configured(s: ServerRecord): number[] {
    return tryParseCpuList(s.cpuSet) ?? [s.cpu];
  }

  private assignments(exceptId?: number): Assignment[] {
    return this.d.servers
      .listRecords()
      .filter((s) => s.id !== exceptId)
      .map((s) => ({ serverId: s.id, name: s.name, cpus: this.configured(s) }));
  }

  /** The old suggestion: one CPU, the least used, keeping the last for the panel and OS. */
  private legacyPick(): number {
    return this.d.servers.suggestCpu();
  }

  /** What a new server would get now (for the New server page). */
  async suggest(): Promise<{ mode: "auto" | "manual"; cpus: string; warnings: string[]; policy: CpuPolicy["mode"] }> {
    const policy = this.policy();
    if (policy.mode === "legacy") return { mode: "manual", cpus: String(this.legacyPick()), warnings: [], policy: policy.mode };
    const a = allocate(await this.topology(), policy, this.assignments());
    return { mode: policy.mode === "auto" ? "auto" : "manual", cpus: formatCpuList(a.cpus), warnings: a.warnings, policy: policy.mode };
  }

  /** Checks a CPU list against this machine. */
  private async validList(text: string): Promise<number[]> {
    let cpus: number[];
    try {
      cpus = parseCpuList(text);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const t = await this.topology();
    const unknown = cpus.filter((c) => !t.cpus.some((x) => x.id === c));
    if (unknown.length) throw badRequest(`This machine has no CPU ${formatCpuList(unknown)}. It has ${formatCpuList(t.cpus.map((c) => c.id))}.`);
    return cpus;
  }

  async checkCpu(cpu: number): Promise<void> {
    await this.validList(String(cpu));
  }

  async forNew(req: { cpu?: number; cpuSet?: string; cpuMode?: "auto" | "manual" }) {
    if (req.cpuSet) {
      const cpus = await this.validList(req.cpuSet);
      return { cpu: cpus[0]!, cpuSet: formatCpuList(cpus), cpuMode: "manual" as const };
    }
    if (req.cpu !== undefined) {
      await this.checkCpu(req.cpu);
      return { cpu: req.cpu, cpuSet: null, cpuMode: "manual" as const };
    }
    const policy = this.policy();
    if (policy.mode === "legacy" && req.cpuMode !== "auto") return { cpu: this.legacyPick(), cpuSet: null, cpuMode: "manual" as const };
    const a = allocate(await this.topology(), policy, this.assignments());
    return {
      cpu: a.cpus[0]!,
      cpuSet: formatCpuList(a.cpus),
      cpuMode: policy.mode === "manual" && req.cpuMode !== "auto" ? ("manual" as const) : ("auto" as const),
    };
  }

  /**
   * The one way CPUs are changed, from CPU Management, its overview and a server's Settings tab. A running
   * server keeps its current CPUs until it's restarted; nothing is restarted here.
   */
  async assign(serverId: number, raw: unknown, actorId: number): Promise<{ row: ServerCpuRow; warnings: string[] }> {
    const input = AssignSchema.parse(raw);
    const s = this.d.servers.require(serverId);
    let cpus: number[];
    let warnings: string[] = [];
    if (input.mode === "manual") {
      if (!input.cpus) throw badRequest("Pick the CPUs for this server.");
      cpus = await this.validList(input.cpus);
    } else {
      const a = allocate(await this.topology(), this.policy(), this.assignments(serverId));
      cpus = a.cpus;
      warnings = a.warnings;
    }
    const before = s.cpuSet ?? String(s.cpu);
    s.cpu = cpus[0]!;
    s.cpuSet = formatCpuList(cpus);
    s.cpuMode = input.mode;
    this.d.servers.saveRecord(s);
    this.d.audit.record(actorId, "server.cpu", serverId, { from: before, to: s.cpuSet, mode: input.mode });
    const row = (await this.rows()).find((r) => r.id === serverId)!;
    const conflicts = row.conflicts;
    if (conflicts.length && !this.policy().allowSharing) {
      warnings.push(
        `Shares ${conflicts.map((c) => `${c.kind === "same-cpu" ? "CPU" : "a core (CPU"} ${c.cpus}${c.kind === "same-core" ? ")" : ""} with ${c.name}`).join(", ")}.`,
      );
    }
    return { row, warnings };
  }

  /** Called before every start (a beforeStart hook). */
  async noteStart(s: ServerRecord): Promise<void> {
    this.startedWith.set(s.id, tryParseCpuList(await this.launch(s)) ?? this.configured(s));
  }

  /** CPUs to start on: the configured ones that exist here. If none do (CPUs gone after a VM change), all of them. */
  async launch(s: ServerRecord): Promise<string> {
    const t = await this.topology().catch(() => null);
    const want = this.configured(s);
    if (!t) return formatCpuList(want);
    const have = new Set(t.cpus.map((c) => c.id));
    const ok = want.filter((c) => have.has(c));
    return formatCpuList(ok.length ? ok : [...have]);
  }

  // ------------------------------------------------------------- what's running where

  /** The CPUs the running CS2 process may use, from /proc. Read-only; null when it can't be told. */
  private async actualAffinity(pid: number | null): Promise<number[] | null> {
    if (!pid) return null;
    const status = await this.sys.read(`proc/${pid}/status`);
    return tryParseCpuList(/^Cpus_allowed_list:\s*(.+)$/m.exec(status ?? "")?.[1] ?? null);
  }

  async rows(): Promise<ServerCpuRow[]> {
    const t = await this.topology();
    const have = new Set(t.cpus.map((c) => c.id));
    const all = this.assignments();
    return Promise.all(
      this.d.servers.listRecords().map(async (s) => {
        const configured = this.configured(s);
        const launch = tryParseCpuList(await this.launch(s)) ?? configured;
        const st = await this.d.host.serviceStatus(s.slug).catch(() => ({ state: "unknown" as const, pid: null, since: null }));
        const running = st.state === "active" || st.state === "activating";
        const actual = running ? await this.actualAffinity(st.pid) : null;
        // What it was started with: known if this panel started it, else assume what it runs on now.
        const baseline = this.startedWith.get(s.id) ?? actual;
        const verify: ServerCpuRow["verify"] = !running ? "stopped" : actual === null ? "unknown" : sameCpus(actual, baseline!) ? "match" : "mismatch";
        return {
          id: s.id,
          name: s.name,
          state: st.state,
          mode: s.cpuMode,
          configured,
          configuredText: formatCpuList(configured),
          launch,
          actual,
          actualText: actual ? formatCpuList(actual) : null,
          verify,
          // Changed since it started: applied on the next restart.
          pendingRestart: running && baseline !== null && !sameCpus(baseline, launch),
          missing: configured.filter((c) => !have.has(c)),
          conflicts: conflictsOf(t, { serverId: s.id, name: s.name, cpus: configured }, all),
        };
      }),
    );
  }

  /** Everything the CPU Management page shows. */
  async overview(refresh = false) {
    const t = await this.topology(refresh);
    const policy = this.policy();
    const rows = await this.rows();
    const usage = await this.usageSnapshot();
    const blocks = buildBlocks(t, policy, rows, usage);
    return {
      topology: {
        model: t.model,
        kind: t.kind,
        virtualization: t.virtualization,
        smt: t.smt,
        hybrid: t.hybrid,
        online: formatCpuList(t.online),
        allowed: formatCpuList(t.allowed),
        restricted: t.restricted,
        packages: t.packages,
        nodes: t.nodes,
        llcGroups: t.llcGroups,
        cpus: t.cpus,
        notes: t.notes,
      },
      policy: { ...policy, reserved: formatCpuList(policy.reserved) },
      summary: summarize(t, policy, blocks, rows),
      groups: groupBlocks(t, blocks),
      servers: rows,
      usageAvailable: usage !== null,
    };
  }

  private primed = false;

  /** Two /proc/stat snapshots; only the very first call waits a moment for the second (not every call when /proc/stat can't be read). */
  private async usageSnapshot() {
    let u = await this.sampler.sample();
    if (!u && !this.primed) {
      this.primed = true;
      await new Promise((r) => setTimeout(r, 300));
      u = await this.sampler.sample();
    }
    return u;
  }

  /** Just the numbers, for refreshing the page every few seconds. */
  async usage(): Promise<{ available: boolean; cpus: Record<number, number | null>; blocks: Record<string, number | null> }> {
    const t = await this.topology();
    const u = await this.usageSnapshot();
    const cpus: Record<number, number | null> = {};
    const blocks: Record<string, number | null> = {};
    for (const c of t.cpus) cpus[c.id] = u ? groupPercent(u.prev, u.now, [c.id]) : null;
    const units = t.kind === "logical" ? t.cpus.map((c) => ({ key: `cpu${c.id}`, cpus: [c.id] })) : t.cores;
    for (const b of units) blocks[b.key] = u ? groupPercent(u.prev, u.now, b.cpus) : null;
    return { available: u !== null, cpus, blocks };
  }
}
