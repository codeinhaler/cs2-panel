import type { Db } from "../db.js";
import { randomToken, sha256 } from "../crypto.js";

/** Cookie for the matchmaking site. Separate from the panel's own session cookie. */
export const MM_SESSION_COOKIE = "cs2mm_session";
const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const MM_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

export interface MmPlayer {
  steamId: string;
  name: string | null;
  avatarUrl: string | null;
  /** Premier rating the player typed in themselves. */
  selfRating: number | null;
  /** Rating set by a panel admin; wins over Leetify and the player's own. */
  overrideRating: number | null;
  createdAt: string;
  lastSeenAt: string | null;
}

interface Row {
  steam_id: string;
  name: string | null;
  avatar_url: string | null;
  self_rating: number | null;
  override_rating: number | null;
  created_at: string;
  last_seen_at: string | null;
}

const toPlayer = (r: Row): MmPlayer => ({
  steamId: r.steam_id,
  name: r.name,
  avatarUrl: r.avatar_url,
  selfRating: r.self_rating,
  overrideRating: r.override_rating,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

/** Players of the matchmaking site (anyone with Steam), and their sign-in sessions. */
export class MmPlayerStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  get(steamId: string): MmPlayer | null {
    const r = this.db.prepare("SELECT * FROM mm_players WHERE steam_id = ?").get(steamId) as Row | undefined;
    return r ? toPlayer(r) : null;
  }

  list(): MmPlayer[] {
    return (this.db.prepare("SELECT * FROM mm_players ORDER BY last_seen_at DESC LIMIT 500").all() as unknown as Row[]).map(toPlayer);
  }

  ensure(steamId: string): MmPlayer {
    this.db
      .prepare("INSERT INTO mm_players (steam_id, last_seen_at) VALUES (?, datetime('now')) ON CONFLICT(steam_id) DO UPDATE SET last_seen_at = datetime('now')")
      .run(steamId);
    return this.get(steamId)!;
  }

  setProfile(steamId: string, profile: { name?: string | null; avatarUrl?: string | null }): void {
    this.db
      .prepare("UPDATE mm_players SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url) WHERE steam_id = ?")
      .run(profile.name ?? null, profile.avatarUrl ?? null, steamId);
  }

  setSelfRating(steamId: string, rating: number | null): void {
    this.db.prepare("UPDATE mm_players SET self_rating = ? WHERE steam_id = ?").run(rating, steamId);
  }

  setOverrideRating(steamId: string, rating: number | null): void {
    this.ensure(steamId);
    this.db.prepare("UPDATE mm_players SET override_rating = ? WHERE steam_id = ?").run(rating, steamId);
  }

  // ------------------------------------------------------------- sessions

  createSession(steamId: string): string {
    const token = randomToken();
    const t = this.now();
    this.db.prepare("INSERT INTO mm_sessions (token_hash, steam_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)").run(sha256(token), steamId, t, t);
    return token;
  }

  resolveSession(token: string | undefined): string | null {
    if (!token) return null;
    const hash = sha256(token);
    const row = this.db.prepare("SELECT steam_id, created_at, last_seen_at FROM mm_sessions WHERE token_hash = ?").get(hash) as
      { steam_id: string; created_at: number; last_seen_at: number } | undefined;
    if (!row) return null;
    const t = this.now();
    if (t - row.last_seen_at > IDLE_TIMEOUT_MS || t - row.created_at > MM_MAX_AGE_MS) {
      this.db.prepare("DELETE FROM mm_sessions WHERE token_hash = ?").run(hash);
      return null;
    }
    if (t - row.last_seen_at > 60_000) this.db.prepare("UPDATE mm_sessions SET last_seen_at = ? WHERE token_hash = ?").run(t, hash);
    return row.steam_id;
  }

  destroySession(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM mm_sessions WHERE token_hash = ?").run(sha256(token));
  }

  destroySessionsFor(steamId: string): void {
    this.db.prepare("DELETE FROM mm_sessions WHERE steam_id = ?").run(steamId);
  }

  purgeExpired(): void {
    const t = this.now();
    this.db.prepare("DELETE FROM mm_sessions WHERE last_seen_at < ? OR created_at < ?").run(t - IDLE_TIMEOUT_MS, t - MM_MAX_AGE_MS);
  }
}
