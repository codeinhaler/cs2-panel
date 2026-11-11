// How busy each CPU is, from Linux's own counters (/proc/stat), not guessed from settings.

export interface CpuTimes {
  busy: number;
  total: number;
}

/** The per-CPU lines of /proc/stat ("cpu3 ..."), as busy and total jiffies. */
export function parsePerCpuStat(text: string): Map<number, CpuTimes> {
  const out = new Map<number, CpuTimes>();
  for (const line of text.split("\n")) {
    const m = /^cpu(\d+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = m[2]!.trim().split(/\s+/).map(Number);
    const busy = user + nice + system + irq + softirq + steal;
    out.set(Number(m[1]), { busy, total: busy + idle + iowait });
  }
  return out;
}

/** Percent busy per CPU between two snapshots. CPUs missing from either are left out. */
export function cpuPercents(prev: Map<number, CpuTimes>, now: Map<number, CpuTimes>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, b] of now) {
    const a = prev.get(id);
    if (!a) continue;
    const dt = b.total - a.total;
    if (dt <= 0) continue;
    out.set(id, Math.max(0, Math.min(100, ((b.busy - a.busy) / dt) * 100)));
  }
  return out;
}

/**
 * One number for a group of CPUs (a core's SMT threads, or a server's CPU set): the share of their combined
 * time that was busy. Each CPU counts once, so two threads of one core aren't added up to 200%.
 */
export function groupPercent(prev: Map<number, CpuTimes>, now: Map<number, CpuTimes>, cpus: readonly number[]): number | null {
  let busy = 0;
  let total = 0;
  for (const id of new Set(cpus)) {
    const a = prev.get(id);
    const b = now.get(id);
    if (!a || !b || b.total <= a.total) continue;
    busy += b.busy - a.busy;
    total += b.total - a.total;
  }
  return total > 0 ? Math.max(0, Math.min(100, (busy / total) * 100)) : null;
}

/**
 * Keeps the last /proc/stat snapshot and hands out percentages since the one before. Reads at most once per
 * `minGapMs`, however many browsers ask, so the page can poll without loading the machine.
 */
export class CpuUsageSampler {
  private prev: { at: number; times: Map<number, CpuTimes> } | null = null;
  private last: { at: number; times: Map<number, CpuTimes> } | null = null;
  private reading: Promise<void> | null = null;

  constructor(
    private readonly readStat: () => Promise<string | null>,
    private readonly now: () => number = Date.now,
    private readonly minGapMs = 2_000,
  ) {}

  /** The latest pair of snapshots, or null while there's only one (the first call) or /proc/stat can't be read. */
  async sample(): Promise<{ prev: Map<number, CpuTimes>; now: Map<number, CpuTimes>; at: number } | null> {
    const t = this.now();
    if (!this.last || t - this.last.at >= this.minGapMs) {
      this.reading ??= (async () => {
        const text = await this.readStat().catch(() => null);
        if (text) {
          this.prev = this.last;
          this.last = { at: this.now(), times: parsePerCpuStat(text) };
        }
      })().finally(() => (this.reading = null));
      await this.reading;
    }
    return this.prev && this.last ? { prev: this.prev.times, now: this.last.times, at: this.last.at } : null;
  }
}
