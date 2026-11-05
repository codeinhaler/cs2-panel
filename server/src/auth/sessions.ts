import type { Db } from "../db.js";
import { randomToken, sha256 } from "../crypto.js";

export const SESSION_COOKIE = "cs2p_session";
/** Sessions end after this long without activity. */
export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Sessions end after this long regardless of activity. */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(userId: number): string {
    const token = randomToken();
    const t = this.now();
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), userId, t, t);
    return token;
  }

  /** Returns the user id for a valid session and refreshes its activity time. */
  resolve(token: string | undefined): number | null {
    if (!token) return null;
    const hash = sha256(token);
    const row = this.db.prepare("SELECT user_id, created_at, last_seen_at FROM sessions WHERE token_hash = ?").get(hash) as
      | { user_id: number; created_at: number; last_seen_at: number }
      | undefined;
    if (!row) return null;
    const t = this.now();
    if (t - row.last_seen_at > IDLE_TIMEOUT_MS || t - row.created_at > MAX_AGE_MS) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
      return null;
    }
    // Avoid a write on every request; a minute of granularity is plenty.
    if (t - row.last_seen_at > 60_000) {
      this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(t, hash);
    }
    return row.user_id;
  }

  destroy(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  destroyAllFor(userId: number): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  purgeExpired(): void {
    const t = this.now();
    this.db
      .prepare("DELETE FROM sessions WHERE last_seen_at < ? OR created_at < ?")
      .run(t - IDLE_TIMEOUT_MS, t - MAX_AGE_MS);
  }
}
