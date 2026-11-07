/** A player with the rating used to balance teams. */
export interface Rated {
  steamId: string;
  rating: number;
}

export interface Split {
  /** Indexes into the players array. */
  a: number[];
  b: number[];
  sumA: number;
  sumB: number;
  /** Absolute difference of the team totals. */
  gap: number;
}

/**
 * Every way to split an even number of players into two equal teams, most even
 * first. With 10 players that's 126 splits, so trying them all is instant.
 *
 * Ties on the total are broken by how close the two best players are, so two
 * splits with the same totals prefer the one that doesn't stack both stars on
 * one side.
 */
export function rankSplits(players: Rated[]): Split[] {
  const n = players.length;
  if (n < 2 || n % 2 !== 0) throw new Error("Teams need an even number of players.");
  if (n > 10) throw new Error("At most 10 players fit in a match.");
  const half = n / 2;
  const ratings = players.map((p) => p.rating);
  const splits: (Split & { tie: number })[] = [];

  // Player 0 is always on team A; otherwise every split would appear twice, mirrored.
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === half) {
      const inA = new Set(chosen);
      const a = chosen.slice();
      const b = ratings.map((_, i) => i).filter((i) => !inA.has(i));
      const sumA = a.reduce((s, i) => s + ratings[i]!, 0);
      const sumB = b.reduce((s, i) => s + ratings[i]!, 0);
      const maxA = Math.max(...a.map((i) => ratings[i]!));
      const maxB = Math.max(...b.map((i) => ratings[i]!));
      splits.push({ a, b, sumA, sumB, gap: Math.abs(sumA - sumB), tie: Math.abs(maxA - maxB) });
      return;
    }
    for (let i = start; i < n; i++) {
      chosen.push(i);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(1, [0]);

  splits.sort((x, y) => x.gap - y.gap || x.tie - y.tie);
  return splits.map(({ tie: _tie, ...s }) => s);
}

/**
 * Who plays when more people are ready than fit: whoever sat out most often
 * goes first, then whoever has waited longest. With allowOdd, an odd number of
 * players is kept (a bot fills the gap); otherwise the last one sits out.
 */
export function choosePlayers<T extends { sitOuts: number; readySince: number }>(ready: T[], max = 10, allowOdd = false): T[] {
  const sorted = ready.slice().sort((x, y) => y.sitOuts - x.sitOuts || x.readySince - y.readySince);
  const take = Math.min(max, sorted.length);
  const count = allowOdd ? take : take - (take % 2);
  return sorted.slice(0, count);
}
