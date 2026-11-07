import path from "node:path";
import type { AuditLog } from "../audit.js";
import type { Db } from "../db.js";
import { badRequest } from "../errors.js";
import type { Host } from "../host/host.js";
import type { RconExec } from "../game/rcon.js";
import { catalogEntry } from "../plugins/catalog.js";
import type { ModerationAdmin, ModerationBan, ModerationIntegration } from "../plugins/moderation.js";
import type { PluginService } from "../plugins/service.js";
import type { InstanceFiles } from "../servers/instance-files.js";
import type { ServerService } from "../servers/service.js";
import type { ServerRecord } from "../servers/store.js";
import { BRIDGE_ID, parseBridgePlayers } from "./bans.js";
import { consoleArg, parseStatus, type StatusPlayer } from "./status.js";

export interface OnlinePlayer extends StatusPlayer {
  steamId: string | null;
}

export interface LiveView {
  running: boolean;
  players: OnlinePlayer[];
  error: string | null;
}

export interface RecentPlayer {
  name: string;
  steamId: string | null;
  serverId: number;
  serverName: string | null;
  lastSeenAt: string;
  online: boolean;
}

export interface ModerationInfo {
  /** Name of the plugin that provides bans/admins on this server, or null. */
  provider: string | null;
  shared: boolean;
  /** Whether commands can be sent right now (server running). */
  canAct: boolean;
  flagPresets: { label: string; flags: string }[];
  /** Whether the plugin has an in-game change-map menu whose maps the panel can edit. */
  mapMenu: boolean;
  error: string | null;
}

const STEAMID_RE = /^7656119\d{10}$/;
const FLAGS_RE = /^[@#\w/.,-]{1,200}$/;
const HISTORY_DAYS = 90;

export class PlayerService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly servers: ServerService,
    private readonly plugins: PluginService,
    private readonly files: InstanceFiles,
    private readonly host: Host,
    private readonly rcon: RconExec,
    private readonly audit: AuditLog,
  ) {}

  // ------------------------------------------------------------- live players

  private moderationFor(serverId: number): { name: string; integration: ModerationIntegration } | null {
    for (const id of this.plugins.installedIds(serverId)) {
      const e = catalogEntry(id);
      if (e?.moderation) return { name: e.name, integration: e.moderation };
    }
    return null;
  }

  private async isRunning(s: ServerRecord): Promise<boolean> {
    return (await this.host.serviceStatus(s.slug)).state === "active";
  }

  private exec(s: ServerRecord, command: string): Promise<string> {
    return this.rcon({ port: s.port, password: s.rconPassword, timeoutMs: 4000 }, command);
  }

  /** The last exact head count per server, from RCON status (Steam's query miscounts bots in CS2). */
  private counts = new Map<number, { humans: number; bots: number; at: number }>();

  /** People and bots on a server from the last status check, if it's recent. */
  recentCounts(serverId: number, maxAgeMs = 75_000): { humans: number; bots: number } | null {
    const c = this.counts.get(serverId);
    return c && Date.now() - c.at <= maxAgeMs ? { humans: c.humans, bots: c.bots } : null;
  }

  async live(serverId: number): Promise<LiveView> {
    const s = this.servers.require(serverId);
    if (!(await this.isRunning(s))) {
      this.counts.delete(serverId);
      return { running: false, players: [], error: null };
    }
    let players: OnlinePlayer[];
    try {
      players = parseStatus(await this.exec(s, "status")).map((p) => ({ ...p, steamId: null }));
    } catch (e) {
      return { running: true, players: [], error: (e as Error).message };
    }
    // CS2's own status has no SteamIDs. Our bridge plugin provides them; failing that, a moderation plugin may.
    if (players.some((p) => !p.bot)) {
      const ids = await this.steamIds(s).catch(() => null);
      if (ids) for (const p of players) p.steamId = ids.get(p.userId) ?? null;
    }
    this.recordSessions(serverId, players);
    const bots = players.filter((p) => p.bot).length;
    this.counts.set(serverId, { humans: players.length - bots, bots, at: Date.now() });
    return { running: true, players, error: null };
  }

  private async steamIds(s: ServerRecord): Promise<Map<number, string> | null> {
    if (this.plugins.installedIds(s.id).includes(BRIDGE_ID)) {
      try {
        return parseBridgePlayers(await this.exec(s, "cs2panel_players"));
      } catch {
        /* try the moderation plugin */
      }
    }
    const mod = this.moderationFor(s.id);
    if (!mod) return null;
    return new Map(mod.integration.commands.parsePlayers(await this.exec(s, mod.integration.commands.listPlayers)).map((x) => [x.userId, x.steamId]));
  }

  async kick(serverId: number, userId: number, reason: string, actorId: number): Promise<void> {
    const s = this.servers.require(serverId);
    if (!(await this.isRunning(s))) throw badRequest("The server isn't running.");
    const player = (await this.live(serverId)).players.find((p) => p.userId === userId);
    if (!player) throw badRequest("That player isn't on the server anymore.");
    const msg = consoleArg(reason);
    await this.exec(s, msg ? `kickid ${userId} "${msg}"` : `kickid ${userId}`);
    this.audit.record(actorId, "player.kick", serverId, { name: player.name, steamId: player.steamId, reason: msg });
  }

  // ------------------------------------------------------------- history

  /** Opens sessions for players who appeared and closes those who left. */
  recordSessions(serverId: number, players: OnlinePlayer[]): void {
    const humans = players.filter((p) => !p.bot);
    const open = this.db
      .prepare("SELECT id, user_id, name, steam_id FROM player_sessions WHERE server_id = ? AND disconnected_at IS NULL")
      .all(serverId) as { id: number; user_id: number; name: string; steam_id: string | null }[];
    const key = (userId: number, name: string) => `${userId}\u0000${name}`;
    const openByKey = new Map(open.map((o) => [key(o.user_id, o.name), o]));
    const seen = new Set<string>();
    for (const p of humans) {
      const k = key(p.userId, p.name);
      seen.add(k);
      const existing = openByKey.get(k);
      if (existing) {
        this.db
          .prepare("UPDATE player_sessions SET last_seen_at = datetime('now'), steam_id = COALESCE(?, steam_id) WHERE id = ?")
          .run(p.steamId, existing.id);
      } else {
        this.db.prepare("INSERT INTO player_sessions (server_id, user_id, name, steam_id) VALUES (?, ?, ?, ?)").run(serverId, p.userId, p.name, p.steamId);
      }
    }
    for (const o of open) {
      if (!seen.has(key(o.user_id, o.name))) {
        this.db.prepare("UPDATE player_sessions SET disconnected_at = last_seen_at WHERE id = ?").run(o.id);
      }
    }
  }

  /** Closes open sessions of a server that stopped. */
  private closeSessions(serverId: number): void {
    this.db.prepare("UPDATE player_sessions SET disconnected_at = last_seen_at WHERE server_id = ? AND disconnected_at IS NULL").run(serverId);
  }

  recent(serverId?: number, limit = 100): RecentPlayer[] {
    const rows = this.db
      .prepare(
        `SELECT p.name, p.steam_id, p.server_id, s.name AS server_name, MAX(p.last_seen_at) AS last_seen,
                MAX(p.disconnected_at IS NULL) AS online
         FROM player_sessions p LEFT JOIN servers s ON s.id = p.server_id
         ${serverId ? "WHERE p.server_id = ?" : ""}
         GROUP BY COALESCE(p.steam_id, p.name), p.server_id
         ORDER BY last_seen DESC LIMIT ?`,
      )
      .all(...(serverId ? [serverId, limit] : [limit])) as {
      name: string;
      steam_id: string | null;
      server_id: number;
      server_name: string | null;
      last_seen: string;
      online: number;
    }[];
    return rows.map((r) => ({
      name: r.name,
      steamId: r.steam_id,
      serverId: r.server_id,
      serverName: r.server_name,
      lastSeenAt: r.last_seen,
      online: r.online === 1,
    }));
  }

  /** Polls running servers so history is kept even when nobody has the panel open. */
  startPolling(intervalMs = 30_000): void {
    if (this.timer) return;
    const tick = async () => {
      this.db.prepare(`DELETE FROM player_sessions WHERE last_seen_at < datetime('now', '-${HISTORY_DAYS} days')`).run();
      for (const s of this.servers.listRecords()) {
        try {
          if (await this.isRunning(s)) await this.live(s.id);
          else this.closeSessions(s.id);
        } catch {
          /* try again next round */
        }
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------- moderation (bans, admins)

  async moderationInfo(serverId: number): Promise<ModerationInfo> {
    const s = this.servers.require(serverId);
    const mod = this.moderationFor(serverId);
    if (!mod) return { provider: null, shared: false, canAct: false, flagPresets: [], mapMenu: false, error: null };
    let shared = false;
    let error: string | null = null;
    try {
      const store = await this.openStore(s, mod.integration);
      if (store) {
        shared = store.shared;
        await store.close();
      }
    } catch (e) {
      error = (e as Error).message;
    }
    return { provider: mod.name, shared, canAct: await this.isRunning(s), flagPresets: mod.integration.flagPresets, mapMenu: !!mod.integration.mapMenu, error };
  }

  private async openStore(s: ServerRecord, integration: ModerationIntegration) {
    return integration.openStore(path.join(await this.files.liveDir(s.slug), "game", "csgo"));
  }

  private requireModeration(serverId: number) {
    const mod = this.moderationFor(serverId);
    if (!mod) throw badRequest("Bans and in-game admins need a plugin that provides them, such as CS2-SimpleAdmin, on this server.");
    return mod;
  }

  async bans(serverId: number, includeInactive: boolean): Promise<ModerationBan[]> {
    const s = this.servers.require(serverId);
    const mod = this.requireModeration(serverId);
    let store;
    try {
      store = await this.openStore(s, mod.integration);
    } catch (e) {
      throw badRequest(`Couldn't read ${mod.name}'s data: ${(e as Error).message}`);
    }
    if (!store) return [];
    try {
      return await store.listBans({ includeInactive, limit: 500 });
    } finally {
      await store.close();
    }
  }

  async admins(serverId: number): Promise<ModerationAdmin[]> {
    const s = this.servers.require(serverId);
    const mod = this.requireModeration(serverId);
    let store;
    try {
      store = await this.openStore(s, mod.integration);
    } catch (e) {
      throw badRequest(`Couldn't read ${mod.name}'s data: ${(e as Error).message}`);
    }
    if (!store) return [];
    try {
      return await store.listAdmins();
    } finally {
      await store.close();
    }
  }

  /** Sends a moderation command to the running server and checks the plugin knew it. */
  private async command(serverId: number, build: (i: ModerationIntegration) => string): Promise<{ server: ServerRecord; output: string }> {
    const s = this.servers.require(serverId);
    const mod = this.requireModeration(serverId);
    if (!(await this.isRunning(s))) throw badRequest(`Start the server first: ${mod.name} handles this while the server runs.`);
    const output = await this.exec(s, build(mod.integration)).catch((e: Error) => {
      throw badRequest(e.message);
    });
    if (/unknown command/i.test(output)) {
      throw badRequest(`${mod.name} didn't respond to the command. Check that it's loaded (Plugins tab → Check now), and that the server isn't hibernating.`);
    }
    return { server: s, output };
  }

  async ban(serverId: number, target: { userId?: number; steamId?: string }, minutes: number, reason: string, actorId: number) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60 * 24 * 365 * 10) throw badRequest("Pick a ban length.");
    if (!reason.trim()) throw badRequest("Give a reason; it's shown to the player.");
    let name: string | null = null;
    let steamId = target.steamId ?? null;
    if (target.userId !== undefined) {
      const p = (await this.live(serverId)).players.find((x) => x.userId === target.userId);
      if (!p) throw badRequest("That player isn't on the server anymore. Ban them by SteamID instead.");
      name = p.name;
      steamId = p.steamId;
      await this.command(serverId, (i) => i.commands.banOnline(target.userId!, minutes, reason));
    } else {
      if (!steamId || !STEAMID_RE.test(steamId)) throw badRequest("Enter a valid SteamID64.");
      await this.command(serverId, (i) => i.commands.banOffline(steamId!, minutes, reason));
    }
    this.audit.record(actorId, "player.ban", serverId, { name, steamId, minutes, reason: reason.trim() });
  }

  async unban(serverId: number, steamId: string, reason: string, actorId: number) {
    if (!STEAMID_RE.test(steamId)) throw badRequest("Enter a valid SteamID64.");
    await this.command(serverId, (i) => i.commands.unban(steamId, reason || "Unbanned from the panel"));
    this.audit.record(actorId, "player.unban", serverId, { steamId, reason });
  }

  async addAdmin(serverId: number, input: { steamId: string; name: string; flags: string; immunity: number; minutes: number }, actorId: number) {
    if (!STEAMID_RE.test(input.steamId)) throw badRequest("Enter a valid SteamID64.");
    if (!input.name.trim()) throw badRequest("Give the admin a name.");
    const flags = input.flags.replace(/\s+/g, "");
    if (!FLAGS_RE.test(flags)) throw badRequest("Flags look like @css/root or @css/kick,@css/ban (no spaces).");
    if (!Number.isInteger(input.immunity) || input.immunity < 0 || input.immunity > 100) throw badRequest("Immunity is a number from 0 to 100.");
    await this.command(serverId, (i) => i.commands.addAdmin(input.steamId, input.name, flags, input.immunity, input.minutes));
    this.audit.record(actorId, "gameadmin.add", serverId, { steamId: input.steamId, name: input.name.trim(), flags, immunity: input.immunity, minutes: input.minutes });
  }

  async removeAdmin(serverId: number, steamId: string, actorId: number) {
    if (!STEAMID_RE.test(steamId)) throw badRequest("Enter a valid SteamID64.");
    await this.command(serverId, (i) => i.commands.removeAdmin(steamId));
    this.audit.record(actorId, "gameadmin.remove", serverId, { steamId });
  }
}
