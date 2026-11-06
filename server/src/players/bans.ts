import { promises as fs } from "node:fs";
import path from "node:path";
import type { AuditLog } from "../audit.js";
import type { Db } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import type { Host } from "../host/host.js";
import type { RconExec } from "../game/rcon.js";
import type { PluginService } from "../plugins/service.js";
import { writeAtomic, type InstanceFiles } from "../servers/instance-files.js";
import type { ServerService } from "../servers/service.js";
import type { ServerRecord } from "../servers/store.js";

/** The plugin that enforces these bans on a server. */
export const BRIDGE_ID = "cs2panel-bridge";
/** Where the bridge reads the ban list, relative to game/csgo. */
export const BANS_FILE = "addons/counterstrikesharp/configs/plugins/Cs2PanelBridge/bans.json";

export interface PanelBan {
  id: number;
  steamId: string;
  name: string | null;
  reason: string;
  createdBy: string | null;
  createdAt: string;
  serverName: string | null;
  /** null = permanent */
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  status: "active" | "expired" | "unbanned";
}

interface BanRow {
  id: number;
  steam_id: string;
  name: string | null;
  reason: string;
  created_by_name: string | null;
  created_at: string;
  server_name: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by_name: string | null;
  revoke_reason: string | null;
  active: number;
  expired: number;
}

const STEAMID_RE = /^7656119\d{10}$/;
/** SQLite datetime('now') strings are UTC without a zone. */
const utc = (t: string) => `${t.replace(" ", "T")}Z`;

/**
 * Bans owned by the panel. They apply to every server that runs the bridge
 * plugin: the list is written into each server's files and reloaded over RCON.
 */
export class BanService {
  constructor(
    private readonly db: Db,
    private readonly servers: ServerService,
    private readonly plugins: PluginService,
    private readonly files: InstanceFiles,
    private readonly host: Host,
    private readonly rcon: RconExec,
    private readonly audit: AuditLog,
  ) {}

  list(includeInactive: boolean): PanelBan[] {
    const rows = this.db
      .prepare(
        `SELECT b.*, COALESCE(cu.display_name, cu.steam_id) AS created_by_name, COALESCE(ru.display_name, ru.steam_id) AS revoked_by_name, s.name AS server_name,
                (b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > datetime('now'))) AS active,
                (b.revoked_at IS NULL AND b.expires_at IS NOT NULL AND b.expires_at <= datetime('now')) AS expired
         FROM bans b
         LEFT JOIN users cu ON cu.id = b.created_by
         LEFT JOIN users ru ON ru.id = b.revoked_by
         LEFT JOIN servers s ON s.id = b.server_id
         ${includeInactive ? "" : "WHERE b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > datetime('now'))"}
         ORDER BY b.id DESC LIMIT 1000`,
      )
      .all() as unknown as BanRow[];
    return rows.map((r) => ({
      id: r.id,
      steamId: r.steam_id,
      name: r.name,
      reason: r.reason,
      createdBy: r.created_by_name,
      createdAt: r.created_at,
      serverName: r.server_name,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      revokedBy: r.revoked_by_name,
      revokeReason: r.revoke_reason,
      status: r.active ? "active" : r.expired ? "expired" : "unbanned",
    }));
  }

  activeBan(steamId: string): PanelBan | undefined {
    return this.list(false).find((b) => b.steamId === steamId);
  }

  async ban(input: { steamId: string; name: string | null; minutes: number; reason: string; serverId: number | null }, actorId: number): Promise<PanelBan> {
    if (!STEAMID_RE.test(input.steamId)) throw badRequest("Enter a valid SteamID64.");
    if (!Number.isInteger(input.minutes) || input.minutes < 0 || input.minutes > 60 * 24 * 365 * 10) throw badRequest("Pick a ban length.");
    const reason = input.reason.trim().slice(0, 200);
    if (!reason) throw badRequest("Give a reason; it's shown to the player.");
    if (this.activeBan(input.steamId)) throw badRequest("That player is already banned. Unban them first to change the ban.");
    const r = this.db
      .prepare(
        `INSERT INTO bans (steam_id, name, reason, created_by, server_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ${input.minutes === 0 ? "NULL" : `datetime('now', '+${input.minutes} minutes')`})`,
      )
      .run(input.steamId, input.name, reason, actorId, input.serverId);
    this.audit.record(actorId, "player.ban", input.serverId, { steamId: input.steamId, name: input.name, minutes: input.minutes, reason });
    await this.syncAll();
    return this.list(true).find((b) => b.id === Number(r.lastInsertRowid))!;
  }

  async unban(id: number, reason: string, actorId: number): Promise<void> {
    const ban = this.list(true).find((b) => b.id === id);
    if (!ban) throw notFound("Ban not found.");
    if (ban.status !== "active") throw badRequest("That ban isn't active anymore.");
    this.db
      .prepare("UPDATE bans SET revoked_at = datetime('now'), revoked_by = ?, revoke_reason = ? WHERE id = ?")
      .run(actorId, reason.trim().slice(0, 200) || null, id);
    this.audit.record(actorId, "player.unban", null, { steamId: ban.steamId, name: ban.name, reason: reason.trim() });
    await this.syncAll();
  }

  /** The file the bridge reads: active bans only, times in ISO UTC. */
  fileContent(): string {
    const bans = this.list(false).map((b) => ({ steamId: b.steamId, reason: b.reason, expiresAt: b.expiresAt ? utc(b.expiresAt) : null }));
    return JSON.stringify({ version: 1, bans }, null, 2) + "\n";
  }

  hasBridge(serverId: number): boolean {
    return this.plugins.installedIds(serverId).includes(BRIDGE_ID);
  }

  /** Which servers enforce panel bans (they run the bridge) and which don't. */
  coverage(): { enforced: { id: number; name: string }[]; missing: { id: number; name: string }[] } {
    const enforced: { id: number; name: string }[] = [];
    const missing: { id: number; name: string }[] = [];
    for (const s of this.servers.listRecords()) (this.hasBridge(s.id) ? enforced : missing).push({ id: s.id, name: s.name });
    return { enforced, missing };
  }

  /** Writes the ban list into a server's files. Works mounted (through merged/) or not. */
  async writeFor(s: ServerRecord): Promise<void> {
    if (!this.hasBridge(s.id)) return;
    const file = path.join(await this.files.liveDir(s.slug), "game", "csgo", BANS_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o2775 });
    await writeAtomic(file, this.fileContent(), 0o664);
  }

  /** Pushes the current list to every server with the bridge; running ones reload (and kick banned players) at once. */
  async syncAll(): Promise<{ reloaded: string[]; failed: string[] }> {
    const reloaded: string[] = [];
    const failed: string[] = [];
    for (const s of this.servers.listRecords()) {
      if (!this.hasBridge(s.id)) continue;
      try {
        await this.writeFor(s);
        if ((await this.host.serviceStatus(s.slug)).state === "active") {
          await this.rcon({ port: s.port, password: s.rconPassword, timeoutMs: 4000 }, "cs2panel_reload");
          reloaded.push(s.name);
        }
      } catch {
        // The file is written; the server picks it up on its next start.
        failed.push(s.name);
      }
    }
    return { reloaded, failed };
  }
}

const PLAYERS_MARKER = "CS2PANEL_PLAYERS ";

/** Parses the bridge's `cs2panel_players` reply into userId → SteamID64. */
export function parseBridgePlayers(output: string): Map<number, string> {
  const ids = new Map<number, string>();
  const line = output.split(/\r?\n/).find((l) => l.includes(PLAYERS_MARKER));
  if (!line) throw new Error("The bridge didn't answer.");
  const list = JSON.parse(line.slice(line.indexOf(PLAYERS_MARKER) + PLAYERS_MARKER.length)) as unknown;
  if (!Array.isArray(list)) throw new Error("Unexpected reply from the bridge.");
  for (const p of list as { userId?: unknown; steamId?: unknown }[]) {
    if (typeof p.userId === "number" && typeof p.steamId === "string" && STEAMID_RE.test(p.steamId)) ids.set(p.userId, p.steamId);
  }
  return ids;
}
