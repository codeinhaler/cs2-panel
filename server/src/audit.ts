import type { Db } from "./db.js";

export interface AuditEntry {
  id: number;
  userId: number | null;
  userName: string | null;
  userSteamId: string | null;
  action: string;
  serverId: number | null;
  serverName: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export class AuditLog {
  constructor(private readonly db: Db) {}

  record(userId: number | null, action: string, serverId: number | null = null, details: Record<string, unknown> = {}): void {
    this.db
      .prepare("INSERT INTO audit_log (user_id, action, server_id, details) VALUES (?, ?, ?, ?)")
      .run(userId, action, serverId, JSON.stringify(details));
  }

  list(opts: { limit?: number; before?: number; serverId?: number } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const where: string[] = [];
    const params: (number | string)[] = [];
    if (opts.before) {
      where.push("a.id < ?");
      params.push(opts.before);
    }
    if (opts.serverId) {
      where.push("a.server_id = ?");
      params.push(opts.serverId);
    }
    const sql = `
      SELECT a.id, a.user_id, u.display_name, u.steam_id, a.action, a.server_id, s.name AS server_name,
             a.details, a.created_at
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN servers s ON s.id = a.server_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY a.id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as unknown as {
      id: number;
      user_id: number | null;
      display_name: string | null;
      steam_id: string | null;
      action: string;
      server_id: number | null;
      server_name: string | null;
      details: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.display_name,
      userSteamId: r.steam_id,
      action: r.action,
      serverId: r.server_id,
      serverName: r.server_name,
      details: JSON.parse(r.details) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }
}
