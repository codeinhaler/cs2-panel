/**
 * Premier ratings from Leetify's public API.
 *
 * Leetify's developer guidelines ask apps not to store their data and not to
 * show numbers different from what the API returns. So nothing from here goes
 * into the database: ratings are asked for when needed and only kept in memory
 * for a few minutes, so the lobby page (which refreshes every couple of
 * seconds) doesn't ask Leetify about the same player again and again.
 */

const BASE_URL = "https://api-public.cs-prod.leetify.com";
const CACHE_MS = 5 * 60 * 1000;
/** A lookup that failed (Leetify down, rate limit) is retried sooner. */
const ERROR_CACHE_MS = 60 * 1000;

export interface LeetifyResult {
  /** Premier (CS Rating), or null when Leetify doesn't know one. */
  premier: number | null;
  /** Why there's no rating, for the lobby page. */
  note: string | null;
}

type FetchFn = typeof fetch;

export class LeetifyClient {
  private cache = new Map<string, { at: number; ttl: number; result: LeetifyResult }>();
  private inflight = new Map<string, Promise<LeetifyResult>>();

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly apiKey: () => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cached result, without asking Leetify. */
  peek(steamId: string): LeetifyResult | null {
    const hit = this.cache.get(steamId);
    return hit && this.now() - hit.at < hit.ttl ? hit.result : null;
  }

  async premier(steamId: string): Promise<LeetifyResult> {
    const hit = this.peek(steamId);
    if (hit) return hit;
    const running = this.inflight.get(steamId);
    if (running) return running;
    const p = this.lookup(steamId).finally(() => this.inflight.delete(steamId));
    this.inflight.set(steamId, p);
    return p;
  }

  /** Forgets everything, e.g. when the API key changes. */
  clear(): void {
    this.cache.clear();
  }

  private async lookup(steamId: string): Promise<LeetifyResult> {
    let result: LeetifyResult;
    let ttl = CACHE_MS;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      const key = this.apiKey();
      if (key) headers["_leetify_key"] = key;
      const res = await this.fetchFn(`${BASE_URL}/v3/profile?steam64_id=${encodeURIComponent(steamId)}`, {
        headers,
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 404) {
        result = { premier: null, note: "Not on Leetify" };
      } else if (res.status === 401) {
        result = { premier: null, note: "Leetify API key was refused" };
        ttl = ERROR_CACHE_MS;
      } else if (res.status === 429) {
        result = { premier: null, note: "Leetify is busy, try again in a minute" };
        ttl = ERROR_CACHE_MS;
      } else if (!res.ok) {
        result = { premier: null, note: `Leetify answered ${res.status}` };
        ttl = ERROR_CACHE_MS;
      } else {
        result = parseProfile(await res.json());
      }
    } catch {
      result = { premier: null, note: "Leetify didn't answer" };
      ttl = ERROR_CACHE_MS;
    }
    this.cache.set(steamId, { at: this.now(), ttl, result });
    return result;
  }
}

export function parseProfile(body: unknown): LeetifyResult {
  const ranks = (body as { ranks?: { premier?: unknown } } | null)?.ranks;
  const premier = ranks?.premier;
  if (typeof premier === "number" && Number.isFinite(premier) && premier > 0) return { premier: Math.round(premier), note: null };
  const privacy = (body as { privacy_mode?: unknown } | null)?.privacy_mode;
  if (typeof privacy === "string" && privacy !== "public") return { premier: null, note: "Leetify profile is private" };
  return { premier: null, note: "No Premier rating on Leetify" };
}

/** Link back to the player's Leetify profile ("View on Leetify"), as Leetify's guidelines ask. */
export const leetifyProfileUrl = (steamId: string) => `https://leetify.com/app/profile/${steamId}`;
