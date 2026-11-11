// Picking CPUs for a server, and spotting servers that share CPUs or cores.
import { formatCpuList } from "./cpulist.js";
import type { CoreInfo, CpuTopology } from "./topology.js";

export interface CpuPolicy {
  /** legacy: one CPU, the least used (how the panel always worked). auto: topology-aware. manual: you pick. */
  mode: "legacy" | "auto" | "manual";
  /** Give a server all threads of its core (e.g. 2 and 14), not just one. */
  includeSmtSiblings: boolean;
  /** Servers may share a core when no free one is left (otherwise it's flagged as a conflict). */
  allowSharing: boolean;
  /** CPUs automatic allocation never hands out (e.g. one for the OS and panel, or an E-core vCPU). */
  reserved: number[];
  /** Prefer P-cores over E-cores, when the machine reliably tells them apart. */
  preferPerformance: boolean;
  /** Use cores and SMT threads when known; off: treat every logical CPU on its own. */
  topologyAware: boolean;
}

export const DEFAULT_POLICY: CpuPolicy = {
  mode: "legacy",
  includeSmtSiblings: true,
  allowSharing: false,
  reserved: [],
  preferPerformance: true,
  topologyAware: true,
};

export interface Assignment {
  serverId: number;
  name: string;
  cpus: number[];
}

export interface Allocation {
  cpus: number[];
  warnings: string[];
}

/** The blocks allocation works with: cores when the layout is known (and wanted), otherwise single CPUs. */
export function allocationUnits(t: CpuTopology, topologyAware: boolean): CoreInfo[] {
  if (topologyAware && t.kind !== "logical") return t.cores;
  const prefix = t.virtualization.detected ? "vCPU" : "CPU";
  return t.cpus.map((c) => ({ key: `cpu${c.id}`, label: `${prefix} ${c.id}`, cpus: [c.id], package: c.package, node: c.node, llc: c.llc, type: c.type }));
}

const typeRank = (t: CoreInfo["type"], preferP: boolean) => (!preferP ? 0 : t === "performance" ? 0 : t === "efficiency" ? 2 : 1);

/**
 * Topology-aware choice for a new server: a core no other server uses (SMT siblings count as the same core),
 * P-cores first, never reserved CPUs. When everything is taken it shares the least-used core and says so;
 * it never fails, so a server can always be created.
 */
export function allocate(t: CpuTopology, policy: CpuPolicy, others: Assignment[]): Allocation {
  const warnings: string[] = [];
  const usable = new Set(t.cpus.map((c) => c.id));
  const reserved = new Set(policy.reserved);
  const units = allocationUnits(t, policy.topologyAware)
    .map((u) => ({ ...u, free: u.cpus.filter((c) => usable.has(c) && !reserved.has(c)) }))
    .filter((u) => u.free.length > 0);
  if (units.length === 0) {
    const all = [...usable].sort((a, b) => a - b);
    warnings.push(`Every CPU is reserved, so the server gets CPU ${all[0] ?? 0}. Free up a CPU under CPU Management.`);
    return { cpus: [all[0] ?? 0], warnings };
  }
  const users = (u: CoreInfo) => others.filter((o) => o.cpus.some((c) => u.cpus.includes(c)));
  const ranked = units
    .map((u, i) => ({ u, i, users: users(u) }))
    .sort(
      (a, b) => a.users.length - b.users.length || typeRank(a.u.type, policy.preferPerformance) - typeRank(b.u.type, policy.preferPerformance) || a.i - b.i,
    );
  const pick = ranked[0]!;
  if (pick.users.length > 0) {
    const names = pick.users.map((o) => o.name).join(", ");
    warnings.push(
      policy.allowSharing
        ? `No free ${t.kind === "logical" ? "CPU" : "core"} left: shares ${pick.u.label} with ${names}.`
        : `No free ${t.kind === "logical" ? "CPU" : "core"} left: ${pick.u.label} is also used by ${names}. Turn on sharing or free one up.`,
    );
  }
  if (t.hybrid && policy.preferPerformance && pick.u.type === "efficiency") warnings.push("No P-core is free, so this server is on an E-core.");
  const cpus = policy.includeSmtSiblings ? pick.u.free : [pick.u.free[0]!];
  return { cpus: [...cpus].sort((a, b) => a - b), warnings };
}

export interface Conflict {
  serverId: number;
  name: string;
  /** same-cpu: the same logical CPU; same-core: another thread of the same core. */
  kind: "same-cpu" | "same-core";
  cpus: string;
}

/** Other servers sharing a CPU, or (when cores are known) a core, with this one. */
export function conflictsOf(t: CpuTopology, mine: Assignment, all: Assignment[]): Conflict[] {
  const coreOf = new Map<number, string>();
  if (t.kind !== "logical") for (const c of t.cpus) coreOf.set(c.id, c.core);
  const out: Conflict[] = [];
  for (const o of all) {
    if (o.serverId === mine.serverId) continue;
    const same = o.cpus.filter((c) => mine.cpus.includes(c));
    if (same.length) {
      out.push({ serverId: o.serverId, name: o.name, kind: "same-cpu", cpus: formatCpuList(same) });
      continue;
    }
    const myCores = new Set(mine.cpus.map((c) => coreOf.get(c)).filter(Boolean));
    const shared = o.cpus.filter((c) => myCores.has(coreOf.get(c)));
    if (shared.length) out.push({ serverId: o.serverId, name: o.name, kind: "same-core", cpus: formatCpuList(shared) });
  }
  return out;
}
