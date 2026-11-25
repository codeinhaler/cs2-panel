/**
 * In-game admins: people (by SteamID) who may use the CS2 Panel Bridge's `!panel` menu on a server.
 *
 * Each person has a role (a set of permissions) on one server or on every server. The panel writes
 * the list, plus the maps the server can change to, into each bridge server's files and reloads it
 * over RCON; the bridge checks permissions itself. What people do in game is kept by the bridge and
 * picked up by the panel (`cs2panel_actions`), so it shows in Activity.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AuditLog } from "../audit.js";
import type { Db } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import type { RconExec } from "../game/rcon.js";
import type { Host } from "../host/host.js";
import { writeAtomic, type InstanceFiles } from "../servers/instance-files.js";
import type { ServerRecord } from "../servers/store.js";

export const INGAME_PERMS = [
  { id: "map", label: "Change the map", hint: "Pick from the server's maps, built-in and Workshop." },
  { id: "restart", label: "Restart the game", hint: "mp_restartgame: scores back to 0." },
  { id: "kick", label: "Kick players", hint: "Pick a player from the list." },
  { id: "cvar", label: "Change server settings", hint: "!panel cvar <name> <value> in chat." },
  { id: "rcon", label: "Run any console command", hint: "!panel rcon <command> in chat. Full control: only for people you trust completely." },
  {
    id: "interrupt",
    label: "May interrupt running matches",
    hint: "Change the map, restart or kick on a server while a matchmaking match runs there. Without it those are hidden during a match.",
  },
] as const;
export type InGamePerm = (typeof INGAME_PERMS)[number]["id"];
const PERM_IDS: string[] = INGAME_PERMS.map((p) => p.id);

/** Where the bridge reads the list, relative to game/csgo. */
export const ADMINS_FILE = "addons/counterstrikesharp/configs/plugins/Cs2PanelBridge/admins.json";
const STEAMID_RE = /^7656119\d{10}$/;
const ACTIONS_MARKER = "CS2PANEL_ACTIONS ";
/** SQLite datetime('now') strings are UTC without a zone. */
const utc = (t: string) => `${t.replace(" ", "T")}Z`;

export interface InGameRole {
  id: number;
  name: string;
  perms: InGamePerm[];
  /** People who have this role. */
  people: number;
}

export interface InGameAdmin {
  id: number;
  steamId: string;
  name: string;
  roleId: number;
  roleName: string;
  /** null: every server. */
  serverId: number | null;
  serverName: string | null;
  expiresAt: string | null;
  expired: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface MenuMap {
  /** An installed map (de_dust2) … */
  map?: string;
  /** … or a Workshop map's ID. */
  workshop?: string;
  title: string;
}

export interface Deps {
  db: Db;
  servers: () => ServerRecord[];
  hasBridge: (serverId: number) => boolean;
  files: InstanceFiles;
  host: Host;
  rcon: RconExec;
  audit: AuditLog;
  /** Maps in the shared CS2 install. */
  installedMaps: () => Promise<string[]>;
  /** Workshop map IDs a server already uses: its start map, its map cycle, the matchmaking lobbies it serves. */
  serverWorkshop: (s: ServerRecord) => string[];
  /** A Workshop map's title on Steam (null when Steam doesn't know or can't be asked). */
  workshopTitle: (id: string) => Promise<string | null>;
}

/** "de_dust2" → "Dust2", "cs_office" → "Office". */
export function builtInTitle(map: string): string {
  const bare = map.replace(/^(de|cs|ar|dm)_/, "").replace(/_/g, " ");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function cleanPerms(perms: string[]): InGamePerm[] {
  const out = PERM_IDS.filter((p) => perms.includes(p)) as InGamePerm[];
  if (perms.some((p) => !PERM_IDS.includes(p))) throw badRequest("Unknown permission.");
  return out;
}

export class InGameAdmins {
  private timer: NodeJS.Timeout | null = null;
  /** What was last written per server, so unchanged files aren't rewritten (or reloaded) every minute. */
  private written = new Map<number, string>();
  private titles = new Map<string, string>();
  private syncing: Promise<void> | null = null;
  private again: Promise<void> | null = null;

  constructor(private readonly d: Deps) {
    for (const r of d.db.prepare("SELECT workshop_id, title FROM ingame_maps WHERE title IS NOT NULL").all() as { workshop_id: string; title: string }[]) {
      this.titles.set(r.workshop_id, r.title);
    }
  }

  // ------------------------------------------------------------- roles

  roles(): InGameRole[] {
    const rows = this.d.db
      .prepare("SELECT r.id, r.name, r.perms, (SELECT COUNT(*) FROM ingame_admins a WHERE a.role_id = r.id) AS people FROM ingame_roles r ORDER BY r.id")
      .all() as { id: number; name: string; perms: string; people: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name, perms: cleanPerms(JSON.parse(r.perms) as string[]), people: r.people }));
  }

  private role(id: number): InGameRole {
    const r = this.roles().find((x) => x.id === id);
    if (!r) throw notFound("That role doesn't exist.");
    return r;
  }

  saveRole(id: number | null, name: string, perms: string[], actorId: number): InGameRole {
    const clean = name.trim();
    if (!clean || clean.length > 40) throw badRequest("Give the role a name (at most 40 characters).");
    const list = cleanPerms(perms);
    if (!list.length) throw badRequest("Tick at least one thing the role may do.");
    const clash = this.roles().find((r) => r.name.toLowerCase() === clean.toLowerCase() && r.id !== id);
    if (clash) throw badRequest(`There's already a role called ${clash.name}.`);
    let roleId: number;
    if (id === null) {
      roleId = Number(this.d.db.prepare("INSERT INTO ingame_roles (name, perms) VALUES (?, ?)").run(clean, JSON.stringify(list)).lastInsertRowid);
    } else {
      this.role(id);
      this.d.db.prepare("UPDATE ingame_roles SET name = ?, perms = ? WHERE id = ?").run(clean, JSON.stringify(list), id);
      roleId = id;
    }
    this.d.audit.record(actorId, id === null ? "ingame.role.add" : "ingame.role.edit", null, { role: clean, perms: list });
    this.changed();
    return this.role(roleId);
  }

  deleteRole(id: number, actorId: number): void {
    const r = this.role(id);
    if (r.people) throw badRequest(`${r.name} is given to ${r.people === 1 ? "1 person" : `${r.people} people`}. Give them another role first.`);
    this.d.db.prepare("DELETE FROM ingame_roles WHERE id = ?").run(id);
    this.d.audit.record(actorId, "ingame.role.delete", null, { role: r.name });
  }

  // ------------------------------------------------------------- people

  list(): InGameAdmin[] {
    const rows = this.d.db
      .prepare(
        `SELECT a.*, r.name AS role_name, s.name AS server_name, COALESCE(u.display_name, u.steam_id) AS created_by_name,
                (a.expires_at IS NOT NULL AND a.expires_at <= datetime('now')) AS expired
         FROM ingame_admins a
         JOIN ingame_roles r ON r.id = a.role_id
         LEFT JOIN servers s ON s.id = a.server_id
         LEFT JOIN users u ON u.id = a.created_by
         ORDER BY a.name COLLATE NOCASE, a.id`,
      )
      .all() as {
      id: number;
      steam_id: string;
      name: string;
      role_id: number;
      role_name: string;
      server_id: number | null;
      server_name: string | null;
      expires_at: string | null;
      expired: number;
      created_by_name: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      steamId: r.steam_id,
      name: r.name,
      roleId: r.role_id,
      roleName: r.role_name,
      serverId: r.server_id,
      serverName: r.server_name,
      expiresAt: r.expires_at ? utc(r.expires_at) : null,
      expired: r.expired === 1,
      createdBy: r.created_by_name,
      createdAt: utc(r.created_at),
    }));
  }

  save(
    id: number | null,
    input: { steamId: string; name: string; roleId: number; serverId: number | null; expiresAt: string | null },
    actorId: number,
  ): InGameAdmin {
    const steamId = input.steamId.trim();
    if (!STEAMID_RE.test(steamId)) throw badRequest("Enter a SteamID64: the 17-digit number starting with 7656119 (steamid.io shows it).");
    const role = this.role(input.roleId);
    if (input.serverId !== null && !this.d.servers().some((s) => s.id === input.serverId)) throw badRequest("That server doesn't exist.");
    let expires: string | null = null;
    if (input.expiresAt) {
      const t = Date.parse(input.expiresAt);
      if (!Number.isFinite(t)) throw badRequest("That end date isn't valid.");
      expires = new Date(t).toISOString().slice(0, 19).replace("T", " ");
    }
    const name = input.name.trim().slice(0, 64);
    const same = this.list().find((a) => a.steamId === steamId && a.serverId === input.serverId && a.id !== id);
    if (same)
      throw badRequest(
        `${same.name || steamId} already has a role ${input.serverId === null ? "on every server" : `on ${same.serverName}`}. Edit that one instead.`,
      );
    let rowId: number;
    if (id === null) {
      rowId = Number(
        this.d.db
          .prepare("INSERT INTO ingame_admins (steam_id, name, role_id, server_id, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
          .run(steamId, name, role.id, input.serverId, expires, actorId).lastInsertRowid,
      );
    } else {
      if (!this.list().some((a) => a.id === id)) throw notFound("That person isn't on the list.");
      this.d.db
        .prepare("UPDATE ingame_admins SET steam_id = ?, name = ?, role_id = ?, server_id = ?, expires_at = ? WHERE id = ?")
        .run(steamId, name, role.id, input.serverId, expires, id);
      rowId = id;
    }
    const a = this.list().find((x) => x.id === rowId)!;
    this.d.audit.record(actorId, id === null ? "ingame.admin.add" : "ingame.admin.edit", a.serverId, {
      steamId,
      name: a.name,
      role: a.roleName,
      ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
    });
    this.changed();
    return a;
  }

  remove(id: number, actorId: number): void {
    const a = this.list().find((x) => x.id === id);
    if (!a) throw notFound("That person isn't on the list.");
    this.d.db.prepare("DELETE FROM ingame_admins WHERE id = ?").run(id);
    this.d.audit.record(actorId, "ingame.admin.remove", a.serverId, { steamId: a.steamId, name: a.name, role: a.roleName });
    this.changed();
  }

  // ------------------------------------------------------------- extra Workshop maps

  extraMaps(): { id: string; title: string | null }[] {
    return (
      this.d.db.prepare("SELECT workshop_id, title FROM ingame_maps ORDER BY created_at, workshop_id").all() as { workshop_id: string; title: string | null }[]
    ).map((r) => ({ id: r.workshop_id, title: r.title }));
  }

  async addMap(id: string, actorId: number): Promise<void> {
    if (!/^\d{3,20}$/.test(id)) throw badRequest("Enter the Workshop map's ID (the number in its Steam link).");
    const title = await this.d.workshopTitle(id).catch(() => null);
    this.d.db
      .prepare("INSERT INTO ingame_maps (workshop_id, title) VALUES (?, ?) ON CONFLICT(workshop_id) DO UPDATE SET title = COALESCE(excluded.title, title)")
      .run(id, title);
    if (title) this.titles.set(id, title);
    this.d.audit.record(actorId, "ingame.map.add", null, { workshop: id, ...(title ? { title } : {}) });
    this.changed();
  }

  removeMap(id: string, actorId: number): void {
    this.d.db.prepare("DELETE FROM ingame_maps WHERE workshop_id = ?").run(id);
    this.d.audit.record(actorId, "ingame.map.remove", null, { workshop: id });
    this.changed();
  }

  // ------------------------------------------------------------- what the bridge gets

  /** The people who may use the menu on this server, with their permissions (both lists merged for someone on both). */
  adminsFor(serverId: number): { steamId: string; name: string; role: string; perms: InGamePerm[]; expiresAt: string | null }[] {
    const out = new Map<string, { steamId: string; name: string; role: string; perms: InGamePerm[]; expiresAt: string | null }>();
    const roles = new Map(this.roles().map((r) => [r.id, r]));
    for (const a of this.list()) {
      if (a.expired || (a.serverId !== null && a.serverId !== serverId)) continue;
      const perms = roles.get(a.roleId)?.perms ?? [];
      const had = out.get(a.steamId);
      if (!had) {
        out.set(a.steamId, { steamId: a.steamId, name: a.name, role: a.roleName, perms: [...perms], expiresAt: a.expiresAt });
      } else {
        had.perms = PERM_IDS.filter((p) => had.perms.includes(p as InGamePerm) || perms.includes(p as InGamePerm)) as InGamePerm[];
        if (a.serverId !== null) had.role = a.roleName;
        // The later of the two end dates (none = none).
        had.expiresAt = !had.expiresAt || !a.expiresAt ? null : had.expiresAt > a.expiresAt ? had.expiresAt : a.expiresAt;
      }
    }
    return [...out.values()];
  }

  private async title(id: string): Promise<string> {
    const known = this.titles.get(id);
    if (known) return known;
    const t = await this.d.workshopTitle(id).catch(() => null);
    if (t) this.titles.set(id, t);
    return t ?? `Workshop map ${id}`;
  }

  /** The change-map menu: built-in maps, then the Workshop maps this server uses and the extra ones, by name. */
  async mapsFor(s: ServerRecord, installed?: string[]): Promise<MenuMap[]> {
    const builtIn = (installed ?? (await this.d.installedMaps())).map((m) => ({ map: m, title: builtInTitle(m) }));
    const ids = [...new Set([...this.d.serverWorkshop(s), ...this.extraMaps().map((m) => m.id)])];
    const workshop: MenuMap[] = [];
    for (const id of ids) workshop.push({ workshop: id, title: await this.title(id) });
    builtIn.sort((a, b) => a.title.localeCompare(b.title));
    workshop.sort((a, b) => a.title.localeCompare(b.title));
    return [...builtIn, ...workshop];
  }

  async fileContent(s: ServerRecord, installed?: string[]): Promise<string> {
    return JSON.stringify({ version: 1, admins: this.adminsFor(s.id), maps: await this.mapsFor(s, installed) }, null, 2) + "\n";
  }

  /** Writes a server's file (before it starts, and after the bridge is installed). */
  async writeFor(s: ServerRecord): Promise<boolean> {
    if (!this.d.hasBridge(s.id)) return false;
    const content = await this.fileContent(s);
    if (this.written.get(s.id) === content) return false;
    const file = path.join(await this.d.files.liveDir(s.slug), "game", "csgo", ADMINS_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o2775 });
    await writeAtomic(file, content, 0o664);
    this.written.set(s.id, content);
    return true;
  }

  /** Something changed: write the files soon (not inside the request). */
  private changed(): void {
    void this.sync().catch(() => undefined);
  }

  /**
   * Brings every bridge server's file up to date (maps change with the server's settings, people expire)
   * and has running servers reload it; collects what people did in game. Runs every minute.
   */
  sync(): Promise<void> {
    // One at a time; a change made while one runs gets one more run after it (with the change in).
    if (this.syncing) {
      this.again ??= this.syncing.then(() => {
        this.again = null;
        return this.sync();
      });
      return this.again;
    }
    this.syncing = this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const installed = await this.d.installedMaps();
    for (const s of this.d.servers()) {
      if (!this.d.hasBridge(s.id)) continue;
      let fresh = false;
      try {
        const content = await this.fileContent(s, installed);
        fresh = this.written.get(s.id) !== content;
        if (fresh) {
          const file = path.join(await this.d.files.liveDir(s.slug), "game", "csgo", ADMINS_FILE);
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o2775 });
          await writeAtomic(file, content, 0o664);
          this.written.set(s.id, content);
        }
        if ((await this.d.host.serviceStatus(s.slug)).state !== "active") continue;
        const opts = { port: s.port, password: s.rconPassword, timeoutMs: 4000 };
        if (fresh) await this.d.rcon(opts, "cs2panel_admins_reload");
        this.recordActions(s, await this.d.rcon(opts, "cs2panel_actions"));
      } catch {
        // Tried again next minute (a server that's starting doesn't answer RCON yet). A new file that
        // couldn't be written or reloaded is written and reloaded again then.
        if (fresh) this.written.delete(s.id);
      }
    }
  }

  /** Puts what people did with the menu into Activity. */
  recordActions(s: ServerRecord, output: string): void {
    for (const a of parseActions(output)) {
      this.d.audit.record(null, "ingame.action", s.id, {
        steamId: a.steamId,
        name: a.name,
        action: a.action,
        ...(a.detail ? { detail: a.detail } : {}),
        ...(a.match ? { duringMatch: true } : {}),
      });
    }
  }

  start(): void {
    if (this.timer) return;
    void this.sync().catch(() => undefined);
    this.timer = setInterval(() => void this.sync().catch(() => undefined), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The bridge's `cs2panel_actions` reply: what people did since the last ask. */
export function parseActions(output: string): { steamId: string; name: string; action: string; detail: string | null; match: boolean }[] {
  const line = output.split(/\r?\n/).find((l) => l.includes(ACTIONS_MARKER));
  if (!line) return [];
  try {
    const list = JSON.parse(line.slice(line.indexOf(ACTIONS_MARKER) + ACTIONS_MARKER.length)) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        steamId: String(x.steamId ?? ""),
        name: String(x.name ?? "").slice(0, 64),
        action: String(x.action ?? "").slice(0, 32),
        detail: typeof x.detail === "string" && x.detail ? x.detail.slice(0, 200) : null,
        match: x.match === true,
      }))
      .filter((x) => STEAMID_RE.test(x.steamId) && /^[a-z]+$/.test(x.action));
  } catch {
    return [];
  }
}
