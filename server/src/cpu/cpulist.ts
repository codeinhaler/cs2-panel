// CPU lists as Linux writes them ("0-3,8,10-11"): parsing, normalising and formatting.

/** The most logical CPUs the panel handles (Linux allows more, but no CS2 box has them). */
export const MAX_CPU_ID = 1023;

/**
 * Parses a CPU list like "2", "2,14", "2-4" or "2-4,14-16" into sorted, unique CPU IDs.
 * Throws a readable error on anything else, so nothing unvalidated reaches an env file or taskset.
 */
export function parseCpuList(text: string): number[] {
  const t = String(text).trim();
  if (!t) throw new Error("Pick at least one CPU.");
  if (!/^[\d,\s-]+$/.test(t)) throw new Error(`"${t}" isn't a CPU list. Use numbers, ranges and commas, like 2,14 or 2-4.`);
  const out = new Set<number>();
  for (const part of t.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(p);
    if (!m) throw new Error(`"${p}" isn't a CPU or a range like 2-4.`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b < a) throw new Error(`The range ${p} goes backwards.`);
    if (b > MAX_CPU_ID) throw new Error(`CPU ${b} is out of range.`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  if (out.size === 0) throw new Error("Pick at least one CPU.");
  return [...out].sort((x, y) => x - y);
}

/** Like parseCpuList, but returns null instead of throwing (for reading /sys and /proc). */
export function tryParseCpuList(text: string | null | undefined): number[] | null {
  if (text === null || text === undefined) return null;
  try {
    return parseCpuList(text);
  } catch {
    return null;
  }
}

/** Formats CPU IDs the way Linux does: ranges for runs of 3 or more ("0-3,8,10,11"). */
export function formatCpuList(cpus: Iterable<number>): string {
  const ids = [...new Set(cpus)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < ids.length;) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${ids[i]}-${ids[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(ids[k]));
    i = j + 1;
  }
  return parts.join(",");
}

/** Normalises a CPU list ("4, 2-3" → "2-4"). Throws like parseCpuList. */
export const normalizeCpuList = (text: string): string => formatCpuList(parseCpuList(text));

export const sameCpus = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
