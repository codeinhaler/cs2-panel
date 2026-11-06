import type { PlayerService } from "../players/service.js";

/** Human players on a server: 0 when it's stopped, null when we couldn't tell. */
export type HumanCounter = (serverId: number) => Promise<number | null>;

export function humanCounter(players: PlayerService): HumanCounter {
  return async (serverId) => {
    try {
      const live = await players.live(serverId);
      if (!live.running) return 0;
      if (live.error) return null;
      return live.players.filter((p) => !p.bot).length;
    } catch {
      return null;
    }
  };
}
