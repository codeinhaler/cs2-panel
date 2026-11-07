/**
 * Looks up Steam Workshop items with Steam's public Web API (no key needed),
 * so the panel can refuse removed or missing maps before a server hangs on them.
 */
const DETAILS_URL = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const COLLECTION_URL = "https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/";
const CS2_APP_ID = 730;
const CACHE_MS = 10 * 60_000;

export type WorkshopStatus =
  /** Public, CS2, available. */
  | "ok"
  /** Steam has no such item. */
  | "missing"
  /** Taken down by Steam (e.g. guideline violations). */
  | "removed"
  /** Exists, but isn't public, so a server can't download it. */
  | "private"
  /** Exists, but belongs to another game. */
  | "wrong-game"
  /** Asked for a collection but it's a single item, or the other way round. */
  | "wrong-kind"
  /** Steam couldn't be asked; nothing known. */
  | "unknown";

export interface WorkshopInfo {
  id: string;
  kind: "map" | "collection";
  status: WorkshopStatus;
  title: string | null;
  sizeBytes: number | null;
  /** Collections: how many items it holds. */
  itemCount: number | null;
  /** Why the status is what it is, ready to show. */
  message: string;
}

interface Details {
  publishedfileid?: string;
  result?: number;
  consumer_app_id?: number;
  creator_app_id?: number;
  title?: string;
  file_size?: number | string;
  visibility?: number;
  banned?: number | boolean;
  ban_reason?: string;
}

export class WorkshopLookup {
  private readonly cache = new Map<string, { at: number; info: WorkshopInfo }>();

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async lookup(id: string, kind: "map" | "collection"): Promise<WorkshopInfo> {
    const key = `${kind}:${id}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.info;
    const info = await this.fetchInfo(id, kind);
    // Don't remember failures to reach Steam; try again next time.
    if (info.status !== "unknown") this.cache.set(key, { at: this.now(), info });
    return info;
  }

  private async post(url: string, body: Record<string, string>): Promise<unknown> {
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Steam answered ${res.status}`);
    return res.json();
  }

  private async fetchInfo(id: string, kind: "map" | "collection"): Promise<WorkshopInfo> {
    const base = { id, kind, title: null, sizeBytes: null, itemCount: null };
    let d: Details | undefined;
    let children: unknown[] | null = null;
    try {
      const details = (await this.post(DETAILS_URL, { itemcount: "1", "publishedfileids[0]": id })) as {
        response?: { publishedfiledetails?: Details[] };
      };
      d = details.response?.publishedfiledetails?.[0];
      if (kind === "collection" || (d && d.result === 1)) {
        const col = (await this.post(COLLECTION_URL, { collectioncount: "1", "publishedfileids[0]": id })) as {
          response?: { collectiondetails?: { result?: number; children?: unknown[] }[] };
        };
        const c = col.response?.collectiondetails?.[0];
        children = c?.result === 1 && Array.isArray(c.children) ? c.children : null;
      }
    } catch (e) {
      return { ...base, status: "unknown", message: `Couldn't ask Steam about this Workshop item (${(e as Error).message}).` };
    }
    if (!d || typeof d.result !== "number") return { ...base, status: "unknown", message: "Steam gave an answer the panel didn't understand." };

    const title = typeof d.title === "string" && d.title ? d.title : null;
    const size = Number(d.file_size);
    const info = { ...base, title, sizeBytes: Number.isFinite(size) && size > 0 ? size : null, itemCount: children ? children.length : null };
    const name = title ? `"${title}"` : `Workshop item ${id}`;

    if (d.result !== 1) return { ...info, status: "missing", message: `Steam has no Workshop item ${id}. It may have been deleted, or the ID is wrong.` };
    if (d.banned === true || d.banned === 1) {
      return { ...info, status: "removed", message: `${name} has been removed from the Steam Workshop${d.ban_reason ? ` (${d.ban_reason})` : ""}, so servers can't download it.` };
    }
    if (d.consumer_app_id !== undefined && d.consumer_app_id !== CS2_APP_ID) {
      return { ...info, status: "wrong-game", message: `${name} isn't a Counter-Strike 2 Workshop item.` };
    }
    if (d.visibility !== undefined && d.visibility !== 0) {
      return { ...info, status: "private", message: `${name} isn't public on the Workshop, so servers can't download it.` };
    }
    if (kind === "collection" && !children) return { ...info, status: "wrong-kind", message: `${name} is a single item, not a collection. Pick "Workshop map" instead.` };
    if (kind === "map" && children) return { ...info, status: "wrong-kind", message: `${name} is a collection. Pick "Workshop collection" instead.` };
    if (kind === "collection" && children!.length === 0) return { ...info, status: "wrong-kind", message: `${name} is an empty collection.` };
    return { ...info, status: "ok", message: name };
  }
}

/** Statuses that mean a server would hang or fail on this item. */
export function workshopBlocks(status: WorkshopStatus): boolean {
  return status !== "ok" && status !== "unknown";
}
