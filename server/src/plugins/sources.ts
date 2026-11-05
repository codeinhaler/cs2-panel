import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pickAsset, type CatalogEntry } from "./catalog.js";

type FetchFn = typeof fetch;

export interface PluginRelease {
  version: string;
  publishedAt: string | null;
  prerelease: boolean;
  /** The archive the panel would install for this release, if any fits. */
  asset: { name: string; url: string; size: number | null } | null;
}

const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
const CACHE_MS = 10 * 60 * 1000;
const METAMOD_DROP = "https://mms.alliedmods.net/mmsdrop/2.0/";

/**
 * Looks up releases (GitHub, Metamod's build drop) and downloads archives
 * into a local cache, so reinstalling or rolling back doesn't download again.
 */
export class PluginSources {
  private cache = new Map<string, { at: number; releases: PluginRelease[] }>();

  constructor(
    private readonly cacheDir: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Newest first. Cached for a few minutes to stay well inside GitHub's anonymous rate limit. */
  async releases(entry: CatalogEntry, force = false): Promise<PluginRelease[]> {
    const hit = this.cache.get(entry.id);
    if (hit && !force && this.now() - hit.at < CACHE_MS) return hit.releases;
    const releases = entry.source.type === "metamod" ? await this.metamodReleases(entry) : await this.githubReleases(entry);
    this.cache.set(entry.id, { at: this.now(), releases });
    return releases;
  }

  private async githubReleases(entry: CatalogEntry): Promise<PluginRelease[]> {
    if (entry.source.type !== "github") return [];
    const res = await this.fetchFn(`https://api.github.com/repos/${entry.source.repo}/releases?per_page=20`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "cs2-panel" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 403 || res.status === 429) throw new Error("GitHub's rate limit was reached. Try again in a few minutes.");
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${entry.source.repo}.`);
    const data = (await res.json()) as {
      tag_name: string;
      draft: boolean;
      prerelease: boolean;
      published_at: string | null;
      assets: { name: string; browser_download_url: string; size: number }[];
    }[];
    const source = entry.source;
    return data
      .filter((r) => !r.draft)
      .map((r) => {
        const a = pickAsset(r.assets, source);
        return {
          version: r.tag_name,
          publishedAt: r.published_at,
          prerelease: r.prerelease,
          asset: a ? { name: a.name, url: a.browser_download_url, size: a.size } : null,
        };
      });
  }

  /** Metamod publishes only "latest" plus the files it names; older builds come from our cache. */
  private async metamodReleases(entry: CatalogEntry): Promise<PluginRelease[]> {
    const res = await this.fetchFn(`${METAMOD_DROP}mmsource-latest-linux`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`metamodsource.net answered ${res.status}.`);
    const file = (await res.text()).trim();
    if (!/^mmsource-[\w.+-]+-linux\.tar\.gz$/.test(file)) throw new Error("Unexpected answer from Metamod's download server.");
    const latest: PluginRelease = {
      version: file.replace(/^mmsource-/, "").replace(/-linux\.tar\.gz$/, ""),
      publishedAt: null,
      prerelease: false,
      asset: { name: file, url: METAMOD_DROP + file, size: null },
    };
    const cached = (await this.cachedVersions(entry.id)).filter((v) => v.version !== latest.version);
    return [latest, ...cached];
  }

  private async cachedVersions(pluginId: string): Promise<PluginRelease[]> {
    const dir = path.join(this.cacheDir, pluginId);
    let versions: string[] = [];
    try {
      versions = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: PluginRelease[] = [];
    for (const v of versions.sort().reverse()) {
      const files = await fs.readdir(path.join(dir, v)).catch(() => [] as string[]);
      const f = files.find((x) => !x.includes(".part"));
      if (f) out.push({ version: v, publishedAt: null, prerelease: false, asset: { name: f, url: "", size: null } });
    }
    return out;
  }

  /** Returns the local path of a release's archive, downloading it if needed. */
  async download(pluginId: string, release: PluginRelease): Promise<string> {
    if (!release.asset) throw new Error(`Release ${release.version} has no Linux download.`);
    const safeVersion = release.version.replace(/[^\w.+-]/g, "_");
    const dir = path.join(this.cacheDir, pluginId, safeVersion);
    const file = path.join(dir, path.basename(release.asset.name));
    try {
      await fs.access(file);
      return file;
    } catch {
      /* not cached yet */
    }
    if (!release.asset.url) throw new Error(`Version ${release.version} is no longer available to download.`);
    await fs.mkdir(dir, { recursive: true });
    const res = await this.fetchFn(release.asset.url, {
      headers: { "User-Agent": "cs2-panel", Accept: "application/octet-stream" },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok || !res.body) throw new Error(`Download of ${release.asset.name} failed (${res.status}).`);
    const length = Number(res.headers.get("content-length"));
    if (length > MAX_DOWNLOAD_BYTES) throw new Error(`${release.asset.name} is too large.`);
    const part = `${file}.part`;
    let seen = 0;
    const counted = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    counted.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > MAX_DOWNLOAD_BYTES) counted.destroy(new Error(`${release.asset!.name} is too large.`));
    });
    try {
      await pipeline(counted, createWriteStream(part));
    } catch (e) {
      await fs.rm(part, { force: true });
      throw e;
    }
    await fs.rename(part, file);
    return file;
  }

  /** Stores an uploaded archive in the cache and returns its path. */
  async storeUpload(pluginId: string, version: string, fileName: string, data: Buffer): Promise<string> {
    const dir = path.join(this.cacheDir, pluginId, version);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, path.basename(fileName));
    await fs.writeFile(file, data);
    return file;
  }
}
