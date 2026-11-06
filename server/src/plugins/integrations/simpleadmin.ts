import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { consoleArg } from "../../players/status.js";
import type { ModerationAdmin, ModerationBan, ModerationIntegration, ModerationStore } from "../moderation.js";

/**
 * CS2-SimpleAdmin: bans and admins live in its database (sa_bans, sa_admins,
 * sa_admins_flags), either a per-server SQLite file or MySQL. Changes go
 * through its console commands so its in-game effects (kicking a banned
 * player, reloading admins) happen as usual.
 */

const PLUGIN_DIR = "addons/counterstrikesharp/plugins/CS2-SimpleAdmin";
const CONFIG = "addons/counterstrikesharp/configs/plugins/CS2-SimpleAdmin/CS2-SimpleAdmin.json";

type Row = Record<string, unknown>;
type Query = (sql: string, params?: (string | number)[]) => Promise<Row[]>;

/** SimpleAdmin writes times as UTC (SQLite) or in its Timezone setting, default UTC (MySQL). */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const s = String(value).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ""}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function banStatus(row: Row, now: number): ModerationBan["status"] {
  const status = String(row.status ?? "ACTIVE").toUpperCase();
  if (status === "UNBANNED") return "unbanned";
  if (status === "EXPIRED") return "expired";
  const ends = toIso(row.ends);
  if (Number(row.duration) > 0 && ends && Date.parse(ends) <= now) return "expired";
  return "active";
}

export function makeStore(query: Query, shared: boolean, close: () => Promise<void>, now: () => number = Date.now): ModerationStore {
  return {
    shared,
    async listBans({ includeInactive, limit }) {
      const rows = await query(
        `SELECT id, player_name, player_steamid, reason, admin_name, duration, created, ends, status
         FROM sa_bans ORDER BY id DESC LIMIT ?`,
        [Math.min(Math.max(limit, 1), 1000)],
      );
      const t = now();
      const bans = rows.map(
        (r): ModerationBan => ({
          id: Number(r.id),
          steamId: r.player_steamid ? String(r.player_steamid) : null,
          playerName: r.player_name ? String(r.player_name) : null,
          reason: String(r.reason ?? ""),
          adminName: String(r.admin_name ?? ""),
          duration: Number(r.duration ?? 0),
          createdAt: toIso(r.created) ?? "",
          endsAt: Number(r.duration) > 0 ? toIso(r.ends) : null,
          status: banStatus(r, t),
        }),
      );
      return includeInactive ? bans : bans.filter((b) => b.status === "active");
    },
    async listAdmins() {
      const admins = await query(
        `SELECT a.id, a.player_name, a.player_steamid, a.flags, a.immunity, a.ends, g.name AS group_name
         FROM sa_admins a LEFT JOIN sa_groups g ON g.id = a.group_id ORDER BY a.player_name`,
      );
      const flags = await query(`SELECT admin_id, flag FROM sa_admins_flags`);
      const byAdmin = new Map<number, string[]>();
      for (const f of flags) byAdmin.set(Number(f.admin_id), [...(byAdmin.get(Number(f.admin_id)) ?? []), String(f.flag)]);
      const t = now();
      // An admin can have one row per server; show each SteamID once.
      const seen = new Map<string, ModerationAdmin>();
      for (const a of admins) {
        const endsAt = toIso(a.ends);
        if (endsAt && Date.parse(endsAt) <= t) continue;
        const steamId = String(a.player_steamid);
        const entry = seen.get(steamId) ?? {
          steamId,
          name: String(a.player_name ?? ""),
          flags: [],
          group: a.group_name ? String(a.group_name) : null,
          immunity: Number(a.immunity ?? 0),
          endsAt,
        };
        const own = byAdmin.get(Number(a.id)) ?? (a.flags ? String(a.flags).split(",") : []);
        entry.flags = [...new Set([...entry.flags, ...own.map((f) => f.trim()).filter(Boolean)])];
        seen.set(steamId, entry);
      }
      return [...seen.values()];
    },
    close,
  };
}

async function readConfig(csgoDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(csgoDir, CONFIG), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function openStore(csgoDir: string): Promise<ModerationStore | null> {
  const config = await readConfig(csgoDir);
  const db = (config?.DatabaseConfig ?? {}) as Record<string, unknown>;
  const type = String(db.DatabaseType ?? "SQLite").toLowerCase();

  if (type.includes("mysql")) {
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection({
      host: String(db.DatabaseHost ?? "127.0.0.1"),
      port: Number(db.DatabasePort ?? 3306),
      user: String(db.DatabaseUser ?? ""),
      password: String(db.DatabasePassword ?? ""),
      database: String(db.DatabaseName ?? ""),
      connectTimeout: 5000,
      dateStrings: true,
    });
    return makeStore(
      async (sql, params = []) => (await conn.query(sql, params))[0] as Row[],
      true,
      async () => {
        await conn.end();
      },
    );
  }

  const file = path.join(csgoDir, PLUGIN_DIR, String(db.SqliteFilePath ?? "cs2-simpleadmin.sqlite"));
  try {
    await fs.access(file);
  } catch {
    return null; // plugin hasn't run yet
  }
  const sqlite = new DatabaseSync(file, { readOnly: true });
  return makeStore(
    async (sql, params = []) => sqlite.prepare(sql).all(...params) as Row[],
    false,
    async () => sqlite.close(),
  );
}

/** Parses the console output of `css_players`: • [#2] "Name" (IP Address: "1.2.3.4" SteamID64: "765...") */
export function parsePlayers(output: string): { userId: number; steamId: string }[] {
  const out: { userId: number; steamId: string }[] = [];
  for (const m of output.matchAll(/\[#(\d+)\][^\n]*?SteamID64:\s*"(\d{17})"/g)) out.push({ userId: Number(m[1]), steamId: m[2]! });
  return out;
}

export const simpleAdminModeration: ModerationIntegration = {
  openStore,
  commands: {
    listPlayers: "css_players",
    parsePlayers,
    banOnline: (userId, minutes, reason) => `css_ban #${userId} ${minutes} "${consoleArg(reason)}"`,
    banOffline: (steamId, minutes, reason) => `css_addban ${steamId} ${minutes} "${consoleArg(reason)}"`,
    unban: (steamId, reason) => `css_unban ${steamId} "${consoleArg(reason)}"`,
    addAdmin: (steamId, name, flags, immunity, minutes) =>
      `css_addadmin ${steamId} "${consoleArg(name, 64)}" ${flags} ${immunity} ${minutes}`,
    removeAdmin: (steamId) => `css_deladmin ${steamId}`,
  },
  flagPresets: [
    { label: "Full access (root)", flags: "@css/root" },
    { label: "Moderator: kick, ban, mute, change map", flags: "@css/generic,@css/kick,@css/ban,@css/unban,@css/chat,@css/changemap" },
    { label: "Kick and mute only", flags: "@css/generic,@css/kick,@css/chat" },
  ],
};
