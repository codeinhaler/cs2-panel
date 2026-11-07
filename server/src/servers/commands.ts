import { z } from "zod";
import type { Permission } from "../auth/permissions.js";
import { parseMapSpec } from "./map-spec.js";

/**
 * Everyday server commands as buttons. Each action builds a fixed RCON command
 * from validated input, so nothing typed in a field can add commands of its own.
 */
export const CommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("changemap"), map: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal("restart-game") }),
  z.object({ action: z.literal("warmup-start") }),
  z.object({ action: z.literal("warmup-end") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("unpause") }),
  z.object({ action: z.literal("swap-teams") }),
  z.object({ action: z.literal("scramble-teams") }),
  z.object({ action: z.literal("bot-add"), team: z.enum(["t", "ct", "any"]) }),
  z.object({ action: z.literal("bot-kick") }),
  z.object({ action: z.literal("bot-quota"), count: z.number().int().min(0).max(64) }),
  z.object({ action: z.literal("say"), text: z.string().max(200) }),
]);
export type Command = z.infer<typeof CommandSchema>;

/** Who may send what: chat messages are moderation, everything else is server control. */
export function commandPermission(c: Command): Permission {
  return c.action === "say" ? "players.moderate" : "server.control";
}

export class CommandError extends Error {}

/** The RCON command line for an action. */
export function rconFor(c: Command): string {
  switch (c.action) {
    case "changemap": {
      const spec = parseMapSpec(c.map);
      if (!spec) throw new CommandError("Enter a map name like de_dust2, or a Workshop map or collection ID.");
      if (spec.kind === "stock") return `changelevel ${spec.map}`;
      if (spec.kind === "workshop") return `host_workshop_map ${spec.id}`;
      return `host_workshop_collection ${spec.id}`;
    }
    case "restart-game":
      return "mp_restartgame 1";
    case "warmup-start":
      return "mp_warmup_start";
    case "warmup-end":
      return "mp_warmup_end";
    case "pause":
      return "mp_pause_match";
    case "unpause":
      return "mp_unpause_match";
    case "swap-teams":
      return "mp_swapteams";
    case "scramble-teams":
      return "mp_scrambleteams";
    case "bot-add":
      return c.team === "t" ? "bot_add_t" : c.team === "ct" ? "bot_add_ct" : "bot_add";
    case "bot-kick":
      return "bot_kick";
    case "bot-quota":
      return `bot_quota ${c.count}`;
    case "say": {
      // Quotes, semicolons and line breaks would let a message run other commands.
      const text = c.text.replace(/[";\r\n\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
      if (!text) throw new CommandError("Write a message first.");
      return `say ${text}`;
    }
  }
}

/**
 * RCON line that switches a running server's game mode. CS2 only picks up new
 * game_type/game_mode values on a full map load: `map`, not `changelevel` (which
 * keeps the current mode).
 */
export function gameModeLine(gameType: number, gameMode: number, map: string): string {
  const spec = parseMapSpec(map);
  if (!spec) throw new CommandError("Enter a map name like de_dust2, or a Workshop map or collection ID.");
  const load =
    spec.kind === "stock" ? `map ${spec.map}` : spec.kind === "workshop" ? `host_workshop_map ${spec.id}` : `host_workshop_collection ${spec.id}`;
  return `game_type ${gameType}; game_mode ${gameMode}; ${load}`;
}
