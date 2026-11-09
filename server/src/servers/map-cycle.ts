import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AuditLog } from "../audit.js";
import type { Db } from "../db.js";
import { badRequest } from "../errors.js";
import type { RconExec } from "../game/rcon.js";
import type { Host } from "../host/host.js";
import { writeAtomic, type InstanceFiles } from "./instance-files.js";
import { parseMapSpec } from "./map-spec.js";
import type { ServerRecord } from "./store.js";

/**
 * Map cycle for servers in Casual: a list of installed and Workshop maps the
 * CS2 Panel Bridge moves through at the end of each match (in order or at
 * random). The bridge changes the map itself, so Workshop maps work too and the
 * panel stays in charge; CS2's own end-of-match map change is switched off.
 */
export const MAP_CYCLE_FILE = "addons/counterstrikesharp/configs/plugins/Cs2PanelBridge/mapcycle.json";
const MAX_MAPS = 30;
const MARKER = "CS2PANEL_MAPCYCLE ";

export const MapCycleSchema = z.object({
  maps: z
    .array(z.string().trim().min(1).max(80))
    .max(MAX_MAPS, `Pick at most ${MAX_MAPS} maps.`)
    .refine(
      (maps) => maps.every((m) => ["stock", "workshop"].includes(parseMapSpec(m)?.kind ?? "")),
      "Each map must be a map name like de_dust2 or a Workshop map (workshop:ID). Collections can't go in the cycle.",
    ),
  random: z.boolean(),
});
export type MapCycle = z.infer<typeof MapCycleSchema>;

export const EMPTY_CYCLE: MapCycle = { maps: [], random: false };

/** The cycle runs only in Casual (game_type 0, game_mode 0). */
export const isCasual = (s: { gameType: number; gameMode: number }) => s.gameType === 0 && s.gameMode === 0;

/** What the bridge reads. Workshop maps go as their ID. */
export function cycleFileContent(s: ServerRecord, cycle: MapCycle): string {
  const maps = cycle.maps.map((m) => {
    const spec = parseMapSpec(m)!;
    return spec.kind === "workshop" ? { workshop: spec.id } : { map: m };
  });
  return JSON.stringify({ version: 1, active: isCasual(s) && maps.length >= 2, random: cycle.random, maps }, null, 2) + "\n";
}

export function parseCycleStatus(output: string): { active: boolean; next: string | null } | null {
  const line = output.split(/\r?\n/).find((l) => l.includes(MARKER));
  if (!line) return null;
  try {
    const v = JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length)) as { active?: boolean; next?: string | null };
    return { active: !!v.active, next: typeof v.next === "string" && v.next ? v.next : null };
  } catch {
    return null;
  }
}

export class MapCycleService {
  constructor(
    private readonly db: Db,
    private readonly files: InstanceFiles,
    private readonly host: Host,
    private readonly rcon: RconExec,
    private readonly audit: AuditLog,
    private readonly hasBridge: (serverId: number) => boolean,
    private readonly checkWorkshop: (map: string) => Promise<void>,
  ) {}

  get(serverId: number): MapCycle {
    const row = this.db.prepare("SELECT map_cycle FROM servers WHERE id = ?").get(serverId) as { map_cycle: string | null } | undefined;
    try {
      const parsed = MapCycleSchema.safeParse(JSON.parse(row?.map_cycle ?? "null"));
      return parsed.success ? parsed.data : EMPTY_CYCLE;
    } catch {
      return EMPTY_CYCLE;
    }
  }

  async set(s: ServerRecord, input: unknown, actorId: number): Promise<MapCycle> {
    const parsed = MapCycleSchema.safeParse(input);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Check the map cycle.");
    const maps = [...new Set(parsed.data.maps)];
    for (const m of maps) await this.checkWorkshop(m);
    const cycle = { maps, random: parsed.data.random };
    this.db.prepare("UPDATE servers SET map_cycle = ? WHERE id = ?").run(JSON.stringify(cycle), s.id);
    this.audit.record(actorId, "server.map_cycle", s.id, { maps: maps.length, random: cycle.random });
    await this.apply(s);
    return cycle;
  }

  /** A duplicated server gets the same cycle. */
  copy(fromId: number, toId: number): void {
    this.db.prepare("UPDATE servers SET map_cycle = (SELECT map_cycle FROM servers WHERE id = ?) WHERE id = ?").run(fromId, toId);
  }

  /** Writes the bridge's file (before a start, after a change or a game mode switch) and reloads a running server. */
  async apply(s: ServerRecord): Promise<void> {
    if (!this.hasBridge(s.id)) return;
    const file = path.join(await this.files.liveDir(s.slug), "game", "csgo", MAP_CYCLE_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o2775 });
    await writeAtomic(file, cycleFileContent(s, this.get(s.id)), 0o664);
    if ((await this.host.serviceStatus(s.slug)).state === "active") {
      await this.rcon({ port: s.port, password: s.rconPassword, timeoutMs: 4000 }, "cs2panel_mapcycle_reload").catch(() => undefined);
    }
  }

  /** The map the bridge will load at the end of this match, when the server is running. */
  async next(s: ServerRecord): Promise<string | null> {
    if (!this.hasBridge(s.id) || (await this.host.serviceStatus(s.slug)).state !== "active") return null;
    const out = await this.rcon({ port: s.port, password: s.rconPassword, timeoutMs: 3000 }, "cs2panel_mapcycle_status").catch(() => "");
    const st = parseCycleStatus(out);
    return st?.active ? st.next : null;
  }
}
