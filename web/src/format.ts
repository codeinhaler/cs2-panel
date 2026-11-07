// Date and time formatting that follows the signed-in user's preferences.

export interface Prefs {
  timeFormat: "24h" | "12h";
  dateFormat: "dmy" | "ymd" | "mdy";
}

export const DEFAULT_PREFS: Prefs = { timeFormat: "24h", dateFormat: "dmy" };

let prefs: Prefs = DEFAULT_PREFS;

/** Called by the app shell whenever the user's preferences load or change. */
export function setFormatPrefs(p: Prefs | undefined): void {
  prefs = { ...DEFAULT_PREFS, ...p };
}

/** The signed-in user's formatting preferences. */
export function currentPrefs(): Prefs {
  return prefs;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatDate(d: Date, p: Prefs = prefs): string {
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  if (p.dateFormat === "ymd") return `${year}-${month}-${day}`;
  if (p.dateFormat === "mdy") return `${month}/${day}/${year}`;
  return `${day}-${month}-${year}`;
}

export function formatTime(d: Date, p: Prefs = prefs, seconds = false): string {
  const s = seconds ? `:${pad(d.getSeconds())}` : "";
  if (p.timeFormat === "24h") return `${pad(d.getHours())}:${pad(d.getMinutes())}${s}`;
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad(d.getMinutes())}${s} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

export function formatDateTime(d: Date, p: Prefs = prefs, seconds = false): string {
  return `${formatDate(d, p)} ${formatTime(d, p, seconds)}`;
}

/**
 * Rewrites the ISO timestamp journald puts at the start of each log line
 * ("2026-11-05T22:20:18+01:00 taskset[4793]: ...") into the user's format.
 */
export function formatLogLine(line: string, p: Prefs = prefs): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z))\s+(?:[\w.@-]+\[\d+\]:\s?)?/.exec(line);
  if (!m) return line;
  const d = new Date(m[1]!);
  if (Number.isNaN(d.getTime())) return line;
  return `${formatDateTime(d, p, true)}  ${line.slice(m[0].length)}`;
}
