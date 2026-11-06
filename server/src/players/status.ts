/** One row from CS2's `status` players section. */
export interface StatusPlayer {
  userId: number;
  name: string;
  /** "mm:ss" or "h:mm:ss" connected time; null for bots. */
  time: string | null;
  ping: number;
  loss: number;
  state: string;
  address: string | null;
  bot: boolean;
}

/**
 * Parses the players section of CS2's `status` output:
 *
 *   ---------players--------
 *     id     time ping loss      state   rate adr name
 *   65535 [NoChan]    0    0 challenging      0unknown ''
 *        1      BOT    0    0     active      0 'Bot Albert'
 *        2    01:08   26    0     active 786432 192.168.1.10:27005 'Sune'
 *   #end
 *
 * Written to tolerate small format differences: the name is the last quoted
 * string on the line, and the address is any ip:port token.
 */
export function parseStatus(output: string): StatusPlayer[] {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((l) => /-{3,}\s*players\s*-{3,}/i.test(l));
  if (start < 0) return [];
  const players: StatusPlayer[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#end/i.test(line)) break;
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*'(.*)'\s*$/.exec(line);
    if (!m) continue;
    const userId = Number(m[1]);
    // 65535 is CS2's placeholder slot ("[NoChan]"), not a player.
    if (userId >= 65535) continue;
    const time = m[2]!;
    const bot = /^bot$/i.test(time);
    const address = /(\d{1,3}(?:\.\d{1,3}){3}:\d+)/.exec(m[6]!)?.[1] ?? null;
    players.push({
      userId,
      name: m[7]!,
      time: bot ? null : time,
      ping: Number(m[3]),
      loss: Number(m[4]),
      state: m[5]!,
      address,
      bot,
    });
  }
  return players;
}

/** Strips characters that would break out of a quoted console argument. */
export function consoleArg(value: string, max = 120): string {
  return value.replace(/["\\;\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
