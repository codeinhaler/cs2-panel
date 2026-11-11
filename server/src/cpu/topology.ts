// What CPUs this machine has, read from Linux (/sys, /proc). Never throws: when the details can't be
// read, it falls back to plain logical CPUs, so a missing file never stops a server from starting.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatCpuList, tryParseCpuList } from "./cpulist.js";

export type CoreType = "performance" | "efficiency";

/**
 * physical: bare metal, the cores are real.
 * guest:    a virtual machine that shows its own cores or SMT threads. That's the VM's made-up layout,
 *           not the host's, so it's labelled as virtual.
 * logical:  only plain CPUs are known (a VM without topology, or details that couldn't be read).
 */
export type TopologyKind = "physical" | "guest" | "logical";

export interface LogicalCpu {
  id: number;
  /** Key of the core (or vCPU block) this CPU belongs to. */
  core: string;
  package: number | null;
  /** CPUs on the same core (SMT/Hyper-Threading), including this one. */
  siblings: number[];
  /** CPUs sharing this CPU's last-level cache, as a CPU list (e.g. one AMD CCD). */
  llc: string | null;
  node: number | null;
  type: CoreType | null;
}

export interface CoreInfo {
  key: string;
  /** "Core 3", "Virtual core 3", "vCPU 4" or "CPU 4". */
  label: string;
  cpus: number[];
  package: number | null;
  node: number | null;
  llc: string | null;
  type: CoreType | null;
}

export interface CpuTopology {
  model: string | null;
  kind: TopologyKind;
  virtualization: { detected: boolean; vendor: string | null };
  /** At least one core has more than one thread. */
  smt: boolean;
  /** P- and E-cores were reliably told apart (only on bare metal). */
  hybrid: boolean;
  /** The CPUs servers can use: online and allowed for the panel. */
  cpus: LogicalCpu[];
  cores: CoreInfo[];
  online: number[];
  /** The CPUs the panel itself may run on (its affinity, e.g. limited by a container or cgroup). */
  allowed: number[];
  restricted: boolean;
  packages: number;
  nodes: number;
  llcGroups: number;
  notes: string[];
}

/** Reads files under a root folder; tests point it at a fake /sys and /proc. */
export interface SysReader {
  read(rel: string): Promise<string | null>;
  list(rel: string): Promise<string[]>;
}

export function sysReader(root = "/"): SysReader {
  return {
    read: async (rel) => {
      try {
        return (await fs.readFile(path.join(root, rel), "utf8")).trim();
      } catch {
        return null;
      }
    },
    list: async (rel) => {
      try {
        return await fs.readdir(path.join(root, rel));
      } catch {
        return [];
      }
    },
  };
}

const VM_VENDORS: [RegExp, string][] = [
  [/vmware/i, "VMware"],
  [/qemu|kvm|red hat|bochs|proxmox/i, "KVM/QEMU"],
  [/microsoft/i, "Hyper-V"],
  [/xen/i, "Xen"],
  [/amazon|ec2/i, "Amazon EC2"],
  [/google/i, "Google Cloud"],
  [/virtualbox|innotek/i, "VirtualBox"],
  [/digitalocean/i, "DigitalOcean"],
  [/hetzner/i, "Hetzner Cloud"],
  [/parallels/i, "Parallels"],
];

async function detectVirtualization(r: SysReader, cpuinfo: string): Promise<{ detected: boolean; vendor: string | null }> {
  const flagged = /^flags\s*:.*\bhypervisor\b/m.test(cpuinfo);
  const dmi = [await r.read("sys/class/dmi/id/sys_vendor"), await r.read("sys/class/dmi/id/product_name"), await r.read("sys/class/dmi/id/board_vendor")]
    .filter(Boolean)
    .join(" ");
  const match = VM_VENDORS.find(([re]) => re.test(dmi));
  // Microsoft also makes real hardware (Surface); only count it with the hypervisor flag or "Virtual Machine".
  const vendor = match && (match[1] !== "Hyper-V" || flagged || /virtual machine/i.test(dmi)) ? match[1] : null;
  return { detected: flagged || vendor !== null, vendor };
}

const num = (v: string | null): number | null => {
  if (v === null || !/^-?\d+$/.test(v)) return null;
  const n = Number(v);
  return n < 0 ? null : n;
};

/** Plain logical CPUs, used when nothing better can be read. */
function logicalOnly(ids: number[], allowed: number[], virt: CpuTopology["virtualization"], model: string | null, notes: string[]): CpuTopology {
  const prefix = virt.detected ? "vCPU" : "CPU";
  const cpus = ids.map<LogicalCpu>((id) => ({ id, core: `cpu${id}`, package: null, siblings: [id], llc: null, node: null, type: null }));
  return {
    model,
    kind: "logical",
    virtualization: virt,
    smt: false,
    hybrid: false,
    cpus,
    cores: cpus.map((c) => ({ key: c.core, label: `${prefix} ${c.id}`, cpus: [c.id], package: null, node: null, llc: null, type: null })),
    online: ids,
    allowed,
    restricted: allowed.length > 0 && formatCpuList(allowed) !== formatCpuList(ids),
    packages: 1,
    nodes: 1,
    llcGroups: 1,
    notes,
  };
}

export async function readTopology(r: SysReader = sysReader()): Promise<CpuTopology> {
  const cpuinfo = (await r.read("proc/cpuinfo")) ?? "";
  const model = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() ?? null;
  const virt = await detectVirtualization(r, cpuinfo).catch(() => ({ detected: false, vendor: null }));
  const fallbackIds = Array.from({ length: Math.max(1, os.availableParallelism?.() ?? os.cpus().length) }, (_, i) => i);
  const online = tryParseCpuList(await r.read("sys/devices/system/cpu/online")) ?? fallbackIds;
  const status = (await r.read("proc/self/status")) ?? "";
  const allowedRaw = tryParseCpuList(/^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1] ?? null) ?? online;
  const usable = online.filter((c) => allowedRaw.includes(c));
  const ids = usable.length ? usable : online;
  const notes: string[] = [];
  if (virt.detected) {
    notes.push(
      `Running in a ${virt.vendor ?? "virtual"} machine: these are virtual CPUs. The hypervisor decides which physical cores they run on, so they aren't shown as physical cores.`,
    );
  }
  try {
    const cpus: LogicalCpu[] = [];
    let complete = true;
    // NUMA nodes: node*/cpulist.
    const nodeOf = new Map<number, number>();
    for (const n of await r.list("sys/devices/system/node")) {
      const m = /^node(\d+)$/.exec(n);
      if (!m) continue;
      for (const c of tryParseCpuList(await r.read(`sys/devices/system/node/${n}/cpulist`)) ?? []) nodeOf.set(c, Number(m[1]));
    }
    // Intel hybrid: the kernel lists P- and E-cores separately. Only trusted on bare metal.
    const pCores = tryParseCpuList(await r.read("sys/devices/cpu_core/cpus"));
    const eCores = tryParseCpuList(await r.read("sys/devices/cpu_atom/cpus"));
    const hybrid = !virt.detected && !!pCores?.length && !!eCores?.length;
    for (const id of ids) {
      const base = `sys/devices/system/cpu/cpu${id}`;
      const coreId = num(await r.read(`${base}/topology/core_id`));
      const pkg = num(await r.read(`${base}/topology/physical_package_id`));
      const siblings = tryParseCpuList(await r.read(`${base}/topology/thread_siblings_list`)) ??
        tryParseCpuList(await r.read(`${base}/topology/core_cpus_list`)) ?? [id];
      if (coreId === null) complete = false;
      // The last-level cache: the highest cache level this CPU has.
      let llc: string | null = null;
      let best = 0;
      for (const idx of await r.list(`${base}/cache`)) {
        if (!/^index\d+$/.test(idx)) continue;
        const level = num(await r.read(`${base}/cache/${idx}/level`)) ?? 0;
        const shared = tryParseCpuList(await r.read(`${base}/cache/${idx}/shared_cpu_list`));
        if (level > best && shared) {
          best = level;
          llc = formatCpuList(shared.filter((c) => ids.includes(c)));
        }
      }
      const type: CoreType | null = hybrid ? (pCores!.includes(id) ? "performance" : eCores!.includes(id) ? "efficiency" : null) : null;
      cpus.push({
        id,
        core: coreId === null ? `cpu${id}` : `p${pkg ?? 0}c${coreId}`,
        package: pkg,
        siblings: siblings.filter((c) => ids.includes(c)),
        llc,
        node: nodeOf.get(id) ?? null,
        type,
      });
    }
    if (!complete) return logicalOnly(ids, allowedRaw, virt, model, notes);
    const smt = cpus.some((c) => c.siblings.length > 1);
    const packages = new Set(cpus.map((c) => c.package ?? 0)).size;
    // A VM without SMT shows nothing real beyond its vCPUs (ESXi's "5 sockets of 1 core" is just how it's set up).
    if (virt.detected && !smt) return logicalOnly(ids, allowedRaw, virt, model, notes);
    const kind: TopologyKind = virt.detected ? "guest" : "physical";
    const byCore = new Map<string, LogicalCpu[]>();
    for (const c of cpus) byCore.set(c.core, [...(byCore.get(c.core) ?? []), c]);
    const cores = [...byCore.entries()]
      .map(([key, list]) => ({ key, list }))
      .sort((a, b) => a.list[0]!.id - b.list[0]!.id)
      .map(({ key, list }, i) => ({
        key,
        label: `${kind === "guest" ? "Virtual core" : "Core"} ${i}`,
        cpus: list.map((c) => c.id).sort((a, b) => a - b),
        package: list[0]!.package,
        node: list[0]!.node,
        llc: list[0]!.llc,
        type: list[0]!.type,
      }));
    if (kind === "guest") notes.push("The cores and threads below are the VM's own virtual layout, not the host's real cores.");
    if (hybrid) notes.push("Performance (P) and efficiency (E) cores were detected; automatic allocation can prefer P-cores.");
    return {
      model,
      kind,
      virtualization: virt,
      smt,
      hybrid,
      cpus,
      cores,
      online,
      allowed: allowedRaw,
      restricted: formatCpuList(allowedRaw) !== formatCpuList(online),
      packages,
      nodes: Math.max(1, new Set(cpus.map((c) => c.node ?? 0)).size),
      llcGroups: Math.max(1, new Set(cpus.map((c) => c.llc ?? "")).size),
      notes,
    };
  } catch {
    notes.push("The CPU layout couldn't be read; showing plain CPUs.");
    return logicalOnly(ids, allowedRaw, virt, model, notes);
  }
}
