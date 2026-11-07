import { promises as fs } from "node:fs";

/** Counters for one server's systemd service. CPU is cumulative; the monitor turns it into a rate. */
export interface ServiceStats {
  cpuNs: number | null;
  memBytes: number | null;
  /** How many times systemd has restarted the service after a crash. */
  restarts: number;
}

/** Whole-machine counters. CPU and network are cumulative. */
export interface MachineStats {
  cpuBusy: number;
  cpuTotal: number;
  cpuCount: number;
  memTotal: number;
  memAvailable: number;
  diskTotal: number;
  diskFree: number;
  netRx: number;
  netTx: number;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "" || v === "[not set]" || v === "infinity") return null;
  const n = Number(v);
  // systemd prints 2^64-1 for "unknown".
  return Number.isFinite(n) && n < 1.8e19 ? n : null;
};

/** `systemctl show -p CPUUsageNSec,MemoryCurrent,NRestarts` output. */
export function parseServiceStats(out: string): ServiceStats {
  const kv = Object.fromEntries(out.split("\n").map((l) => l.split("=", 2) as [string, string]));
  return { cpuNs: num(kv.CPUUsageNSec), memBytes: num(kv.MemoryCurrent), restarts: num(kv.NRestarts) ?? 0 };
}

/** First line of /proc/stat: busy and total jiffies across all cores. */
export function parseProcStat(text: string): { busy: number; total: number; cpuCount: number } {
  const lines = text.split("\n");
  const f = (lines[0] ?? "").trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
  const idleAll = idle + iowait;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idleAll, cpuCount: lines.filter((l) => /^cpu\d+\s/.test(l)).length || 1 };
}

/** /proc/meminfo, in bytes. */
export function parseMeminfo(text: string): { total: number; available: number } {
  const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0) * 1024;
  return { total: get("MemTotal"), available: get("MemAvailable") };
}

/** /proc/net/dev: bytes received and sent on all interfaces except loopback. */
export function parseNetDev(text: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of text.split("\n").slice(2)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m || m[1]!.trim() === "lo") continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    rx += f[0] ?? 0;
    tx += f[8] ?? 0;
  }
  return { rx, tx };
}

/** Reads the real machine (Linux). diskPath is where the CS2 files live. */
export async function readMachineStats(diskPath: string): Promise<MachineStats> {
  const [stat, mem, net, disk] = await Promise.all([
    fs.readFile("/proc/stat", "utf8"),
    fs.readFile("/proc/meminfo", "utf8"),
    fs.readFile("/proc/net/dev", "utf8"),
    fs.statfs(diskPath),
  ]);
  const cpu = parseProcStat(stat);
  const m = parseMeminfo(mem);
  const n = parseNetDev(net);
  return {
    cpuBusy: cpu.busy,
    cpuTotal: cpu.total,
    cpuCount: cpu.cpuCount,
    memTotal: m.total,
    memAvailable: m.available,
    diskTotal: disk.blocks * disk.bsize,
    diskFree: disk.bavail * disk.bsize,
    netRx: n.rx,
    netTx: n.tx,
  };
}
