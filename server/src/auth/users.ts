import type { Db } from "../db.js";
import type { Role } from "./permissions.js";

export interface User {
  id: number;
  steamId: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface UserRow {
  id: number;
  steam_id: string;
  display_name: string | null;
  avatar_url: string | null;
  role: Role;
  disabled: number;
  created_at: string;
  last_login_at: string | null;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  steamId: r.steam_id,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  role: r.role,
  disabled: r.disabled === 1,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
});

export class UserStore {
  constructor(private readonly db: Db) {}

  /** Makes sure the configured owner exists and is the only owner. */
  ensureOwner(steamId: string): void {
    const existing = this.bySteamId(steamId);
    if (existing) {
      this.db.prepare("UPDATE users SET role = 'owner', disabled = 0 WHERE id = ?").run(existing.id);
    } else {
      this.db.prepare("INSERT INTO users (steam_id, role) VALUES (?, 'owner')").run(steamId);
    }
    // If the owner SteamID in the config was changed, the previous owner becomes an admin.
    this.db.prepare("UPDATE users SET role = 'admin' WHERE role = 'owner' AND steam_id <> ?").run(steamId);
  }

  list(): User[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY role = 'owner' DESC, created_at").all() as unknown as UserRow[];
    return rows.map(toUser);
  }

  byId(id: number): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  bySteamId(steamId: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE steam_id = ?").get(steamId) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  create(steamId: string, role: Exclude<Role, "owner">, createdBy: number, profile?: Profile): User {
    const result = this.db
      .prepare("INSERT INTO users (steam_id, role, created_by, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)")
      .run(steamId, role, createdBy, profile?.name ?? null, profile?.avatarUrl ?? null);
    return this.byId(Number(result.lastInsertRowid))!;
  }

  update(id: number, changes: { role?: Exclude<Role, "owner">; disabled?: boolean }): void {
    if (changes.role !== undefined) this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(changes.role, id);
    if (changes.disabled !== undefined)
      this.db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(changes.disabled ? 1 : 0, id);
  }

  updateProfile(id: number, profile: Profile): void {
    this.db
      .prepare("UPDATE users SET display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?")
      .run(profile.name ?? null, profile.avatarUrl ?? null, id);
  }

  touchLogin(id: number): void {
    this.db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    // Keep the row's id valid for audit references by anonymising instead of hard delete
    // when it's referenced; otherwise delete it.
    const referenced =
      (this.db.prepare("SELECT 1 FROM audit_log WHERE user_id = ? LIMIT 1").get(id) ??
        this.db.prepare("SELECT 1 FROM config_revisions WHERE author_id = ? LIMIT 1").get(id) ??
        this.db.prepare("SELECT 1 FROM users WHERE created_by = ? LIMIT 1").get(id)) !== undefined;
    if (referenced) {
      this.db
        .prepare("UPDATE users SET disabled = 1, steam_id = 'removed:' || id || ':' || steam_id WHERE id = ?")
        .run(id);
    } else {
      this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    }
  }
}

export interface Profile {
  name?: string | null;
  avatarUrl?: string | null;
}
