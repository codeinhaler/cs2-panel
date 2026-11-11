// The model behind the CPU Management page: blocks per core (or vCPU), their status, groups and a summary.
// Computed here so the page only draws it, and so it can be tested without a browser.
import { allocationUnits, type CpuPolicy } from "./allocate.js";
import { groupPercent, type CpuTimes } from "./usage.js";
import type { CpuTopology } from "./topology.js";

export interface ServerCpuRow {
  id: number;
  name: string;
  state: string;
  mode: "auto" | "manual";
  /** What the server is set to (its CPU list). */
  configured: number[];
  configuredText: string;
  /** What it will actually start on: the configured CPUs that exist here. */
  launch: number[];
  /** What the running CS2 process is allowed to use, read from /proc. Null when stopped or unreadable. */
  actual: number[] | null;
  actualText: string | null;
  /** match / mismatch, unknown (running but couldn't read), stopped. */
  verify: "match" | "mismatch" | "unknown" | "stopped";
  /** Saved while running, not applied yet: shown as "Restart required". */
  pendingRestart: boolean;
  /** Configured CPUs this machine doesn't have (after a reboot or VM change). */
  missing: number[];
  conflicts: { serverId: number; name: string; kind: "same-cpu" | "same-core"; cpus: string }[];
}

export type BlockFlag = "free" | "assigned" | "shared" | "conflict" | "reserved" | "pending" | "mismatch";

export interface CpuBlock {
  key: string;
  label: string;
  cpus: number[];
  type: "performance" | "efficiency" | null;
  package: number | null;
  node: number | null;
  llc: string | null;
  servers: { id: number; name: string; cpus: number[] }[];
  reservedCpus: number[];
  flags: BlockFlag[];
  /** The one status to colour the block by, most important first. */
  status: BlockFlag;
  usage: number | null;
  cpuUsage: Record<number, number | null>;
}

export interface CpuGroup {
  key: string;
  label: string;
  blocks: CpuBlock[];
}

export interface CpuSummary {
  /** "cores" when cores are known (physical or the VM's own layout), else "cpus". */
  unit: "cores" | "cpus";
  cores: number | null;
  logical: number;
  assigned: number;
  reserved: number;
  free: number;
  conflicts: number;
  mismatches: number;
  pending: number;
  missing: number;
}

const ORDER: BlockFlag[] = ["mismatch", "conflict", "pending", "shared", "assigned", "reserved", "free"];

export function buildBlocks(
  t: CpuTopology,
  policy: CpuPolicy,
  rows: ServerCpuRow[],
  usage: { prev: Map<number, CpuTimes>; now: Map<number, CpuTimes> } | null,
): CpuBlock[] {
  const units = allocationUnits(t, true);
  const reserved = new Set(policy.reserved);
  return units.map((u) => {
    const servers = rows
      .filter((r) => r.configured.some((c) => u.cpus.includes(c)))
      .map((r) => ({ id: r.id, name: r.name, cpus: r.configured.filter((c) => u.cpus.includes(c)) }));
    const reservedCpus = u.cpus.filter((c) => reserved.has(c));
    const flags: BlockFlag[] = [];
    if (servers.length === 0) flags.push(reservedCpus.length ? "reserved" : "free");
    else {
      flags.push("assigned");
      if (servers.length > 1) flags.push(policy.allowSharing ? "shared" : "conflict");
      if (reservedCpus.length) flags.push("reserved");
    }
    const touching = rows.filter((r) => servers.some((s) => s.id === r.id));
    if (touching.some((r) => r.pendingRestart)) flags.push("pending");
    if (touching.some((r) => r.verify === "mismatch")) flags.push("mismatch");
    const cpuUsage: Record<number, number | null> = {};
    for (const c of u.cpus) cpuUsage[c] = usage ? groupPercent(usage.prev, usage.now, [c]) : null;
    return {
      key: u.key,
      label: u.label,
      cpus: u.cpus,
      type: u.type,
      package: u.package,
      node: u.node,
      llc: u.llc,
      servers,
      reservedCpus,
      flags,
      status: ORDER.find((f) => flags.includes(f)) ?? "free",
      usage: usage ? groupPercent(usage.prev, usage.now, u.cpus) : null,
      cpuUsage,
    };
  });
}

/** Groups blocks by what matters most on this machine: P/E cores, sockets, NUMA nodes or cache groups. One group otherwise. */
export function groupBlocks(t: CpuTopology, blocks: CpuBlock[]): CpuGroup[] {
  const by = (keyOf: (b: CpuBlock) => string, labelOf: (b: CpuBlock) => string): CpuGroup[] => {
    const groups = new Map<string, CpuGroup>();
    for (const b of blocks) {
      const k = keyOf(b);
      if (!groups.has(k)) groups.set(k, { key: k, label: labelOf(b), blocks: [] });
      groups.get(k)!.blocks.push(b);
    }
    return [...groups.values()];
  };
  if (t.kind !== "logical") {
    if (t.hybrid)
      return by(
        (b) => b.type ?? "other",
        (b) => (b.type === "performance" ? "Performance cores (P)" : b.type === "efficiency" ? "Efficiency cores (E)" : "Other cores"),
      );
    const virtual = t.kind === "guest" ? "Virtual socket" : "Socket";
    if (t.packages > 1)
      return by(
        (b) => `p${b.package ?? 0}`,
        (b) => `${virtual} ${b.package ?? 0}`,
      );
    if (t.nodes > 1)
      return by(
        (b) => `n${b.node ?? 0}`,
        (b) => `NUMA node ${b.node ?? 0}`,
      );
    if (t.llcGroups > 1)
      return by(
        (b) => b.llc ?? "",
        (b) => `Shared cache (CPUs ${b.llc ?? "?"})`,
      );
  }
  return [
    {
      key: "all",
      label: t.kind === "logical" ? (t.virtualization.detected ? "Virtual CPUs" : "CPUs") : t.kind === "guest" ? "Virtual cores" : "Cores",
      blocks,
    },
  ];
}

/** Sharing that's allowed isn't counted as a conflict. */
export function summarize(t: CpuTopology, policy: CpuPolicy, blocks: CpuBlock[], rows: ServerCpuRow[]): CpuSummary {
  const unit = t.kind === "logical" ? "cpus" : "cores";
  const conflictPairs = new Set<string>();
  for (const r of rows) for (const c of r.conflicts) conflictPairs.add([r.id, c.serverId].sort((a, b) => a - b).join("-"));
  return {
    unit,
    cores: unit === "cores" ? t.cores.length : null,
    logical: t.cpus.length,
    assigned: blocks.filter((b) => b.servers.length > 0).length,
    reserved: blocks.filter((b) => b.servers.length === 0 && b.reservedCpus.length > 0).length,
    free: blocks.filter((b) => b.status === "free").length,
    conflicts: policy.allowSharing ? 0 : conflictPairs.size,
    mismatches: rows.filter((r) => r.verify === "mismatch").length,
    pending: rows.filter((r) => r.pendingRestart).length,
    missing: rows.filter((r) => r.missing.length > 0).length,
  };
}
