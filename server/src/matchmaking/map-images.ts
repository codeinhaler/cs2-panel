/**
 * Map thumbnails (and T/CT icons) for the matchmaking site.
 *
 * Three sources, the first that has an image wins:
 *   1. custom/  an image the organiser uploaded for that map (or side);
 *   2. auto/    taken from the game: built-in maps' preview images out of CS2's own files (re-read after
 *               every CS2 update), and Workshop maps' preview image from Steam;
 *   3. none     the site shows a placeholder with the map's name.
 *
 * Keys: a map name ("de_dust2"), "workshop-<id>" for a Workshop map, "side-t" / "side-ct".
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { badRequest } from "../errors.js";
import { imageType } from "./look.js";

const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
type Ext = keyof typeof TYPES;
const MAX_UPLOAD = 2 * 1024 * 1024;

export type ImageSource = "custom" | "auto";

/** "de_dust2" → "de_dust2", "workshop:123" → "workshop-123", sides as they are; anything else null. */
export function imageKey(mapOrKey: string): string | null {
  if (mapOrKey === "side-t" || mapOrKey === "side-ct") return mapOrKey;
  const ws = /^workshop[:-](\d{3,20})$/.exec(mapOrKey);
  if (ws) return `workshop-${ws[1]}`;
  return /^[a-z0-9_]{2,64}$/.test(mapOrKey) ? mapOrKey : null;
}

export class MapImages {
  /** What's there, by key: where it comes from and a version (its change time) for cache-busting. */
  private index = new Map<string, { source: ImageSource; v: number }>();

  constructor(
    private readonly dir: string,
    /** The shared CS2 install (holds game/csgo/pak01_dir.vpk). */
    private readonly baseDir: string,
  ) {}

  async load(): Promise<void> {
    const next = new Map<string, { source: ImageSource; v: number }>();
    for (const source of ["auto", "custom"] as const) {
      let files: string[] = [];
      try {
        files = await fs.readdir(path.join(this.dir, source));
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^(.+)\.(png|jpg|webp)$/.exec(f);
        if (!m || !imageKey(m[1]!)) continue;
        const st = await fs.stat(path.join(this.dir, source, f)).catch(() => null);
        if (st) next.set(m[1]!, { source, v: Math.floor(st.mtimeMs) });
      }
    }
    this.index = next;
  }

  /** Every image there is: key → source and version. */
  list(): Record<string, { source: ImageSource; v: number }> {
    return Object.fromEntries(this.index);
  }

  has(key: string): boolean {
    return this.index.has(key);
  }

  hasAuto(key: string): Promise<boolean> {
    return this.find("auto", key).then((f) => f !== null);
  }

  private async find(source: ImageSource, key: string): Promise<{ file: string; ext: Ext } | null> {
    for (const ext of Object.keys(TYPES) as Ext[]) {
      const file = path.join(this.dir, source, `${key}.${ext}`);
      try {
        await fs.access(file);
        return { file, ext };
      } catch {
        /* next */
      }
    }
    return null;
  }

  async read(key: string): Promise<{ data: Buffer; type: string } | null> {
    if (!imageKey(key)) return null;
    const found = (await this.find("custom", key)) ?? (await this.find("auto", key));
    if (!found) return null;
    return { data: await fs.readFile(found.file), type: TYPES[found.ext] };
  }

  private async write(source: ImageSource, key: string, buf: Buffer): Promise<void> {
    const ext = imageType(buf);
    if (!ext) throw badRequest("Upload a PNG, JPG or WebP image.");
    const dir = path.join(this.dir, source);
    await fs.mkdir(dir, { recursive: true });
    for (const e of Object.keys(TYPES)) await fs.rm(path.join(dir, `${key}.${e}`), { force: true });
    const file = path.join(dir, `${key}.${ext}`);
    await fs.writeFile(`${file}.tmp`, buf, { mode: 0o644 });
    await fs.rename(`${file}.tmp`, file);
  }

  async saveCustom(mapOrKey: string, buf: Buffer): Promise<void> {
    const key = imageKey(mapOrKey);
    if (!key) throw badRequest("Unknown map.");
    if (buf.length > MAX_UPLOAD) throw badRequest("A map image can be at most 2 MB.");
    await this.write("custom", key, buf);
    await this.load();
  }

  async removeCustom(mapOrKey: string): Promise<void> {
    const key = imageKey(mapOrKey);
    if (!key) throw badRequest("Unknown map.");
    for (const e of Object.keys(TYPES)) await fs.rm(path.join(this.dir, "custom", `${key}.${e}`), { force: true });
    await this.load();
  }

  /** A Workshop map's preview image from Steam (kept, so the site never links to Steam). */
  async saveWorkshopPreview(id: string, url: string, fetchFn: typeof fetch): Promise<void> {
    const key = `workshop-${id}`;
    if (!/^https:\/\//.test(url) || (await this.hasAuto(key))) return;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024 || !imageType(buf)) return;
    await this.write("auto", key, buf);
    await this.load();
  }

  /**
   * Built-in maps' preview images (and T/CT icons, when the game has them as pictures) out of CS2's own
   * files. Run after each CS2 update. Returns how many it found.
   */
  async extractFromGame(): Promise<{ maps: number; sides: number }> {
    const dirFile = path.join(this.baseDir, "game", "csgo", "pak01_dir.vpk");
    const vpk = await Vpk.open(dirFile);
    const maps = new Map<string, VpkEntry>();
    const sides = new Map<string, VpkEntry>();
    const rank = (p: string) => (p.includes("360p") ? 0 : p.includes("720p") ? 1 : p.includes("1080p") ? 2 : 3);
    for (const e of vpk.entries) {
      if (!e.path.startsWith("panorama/images")) continue;
      if (!["vtex_c", "png", "jpg"].includes(e.ext)) continue;
      // Map previews: panorama/images/map_icons/screenshots/<size>/de_dust2.vtex_c
      if (e.path.includes("map_icons") && e.path.includes("screenshots") && /^(de|cs|ar|dm|gd|aim|fy|awp|surf)_[a-z0-9_]+$/.test(e.name)) {
        const had = maps.get(e.name);
        if (!had || rank(e.path) < rank(had.path)) maps.set(e.name, e);
      }
      // Team icons, if the game has them as pictures (often they're vector graphics, which we can't use).
      const side = /^(?:icon[-_]?)?(t|ct)(?:[-_](?:logo|icon))?$/.exec(e.name) ?? /^(?:team[-_]|logo[-_])(t|ct)$/.exec(e.name);
      if (side && !sides.has(side[1]!)) sides.set(side[1]!, e);
    }
    let foundMaps = 0;
    let foundSides = 0;
    for (const [name, e] of maps) {
      const img = embeddedImage(await vpk.read(e));
      if (!img) continue;
      await this.write("auto", name, img);
      foundMaps++;
    }
    for (const [side, e] of sides) {
      const img = embeddedImage(await vpk.read(e));
      if (!img) continue;
      await this.write("auto", `side-${side}`, img);
      foundSides++;
    }
    await vpk.close();
    await this.load();
    return { maps: foundMaps, sides: foundSides };
  }
}

/**
 * The picture inside a file: a PNG or JPEG as it is, or one embedded in a compiled Source 2 texture
 * (panorama UI images keep the original PNG/JPEG bytes inside the .vtex_c).
 */
export function embeddedImage(buf: Buffer): Buffer | null {
  if (imageType(buf)) return buf;
  const png = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (png >= 0) {
    const end = buf.indexOf(Buffer.from("IEND"), png);
    if (end > png) return buf.subarray(png, end + 8); // "IEND" + its 4-byte CRC
  }
  const jpg = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (jpg >= 0) {
    const end = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (end > jpg) return buf.subarray(jpg, end + 2);
  }
  return null;
}

// ------------------------------------------------------------- VPK (Valve pak) reader, version 1 and 2

export interface VpkEntry {
  path: string;
  name: string;
  ext: string;
  archive: number;
  offset: number;
  length: number;
  preload: Buffer;
}

export class Vpk {
  private constructor(
    private readonly dirFile: string,
    readonly entries: VpkEntry[],
    /** Where data stored in the _dir file itself starts. */
    private readonly dataStart: number,
  ) {}

  static async open(dirFile: string): Promise<Vpk> {
    const buf = await fs.readFile(dirFile);
    if (buf.length < 12 || buf.readUInt32LE(0) !== 0x55aa1234) throw new Error(`${path.basename(dirFile)} isn't a VPK file.`);
    const version = buf.readUInt32LE(4);
    const treeSize = buf.readUInt32LE(8);
    const headerSize = version === 1 ? 12 : version === 2 ? 28 : -1;
    if (headerSize < 0) throw new Error(`Unknown VPK version ${version}.`);
    const entries: VpkEntry[] = [];
    let pos = headerSize;
    const end = headerSize + treeSize;
    const str = () => {
      const zero = buf.indexOf(0, pos);
      if (zero < 0 || zero >= end) throw new Error("Broken VPK directory.");
      const s = buf.toString("utf8", pos, zero);
      pos = zero + 1;
      return s;
    };
    for (;;) {
      const ext = str();
      if (!ext) break;
      for (;;) {
        const dir = str();
        if (!dir) break;
        for (;;) {
          const name = str();
          if (!name) break;
          // crc u32, preload u16, archive u16, offset u32, length u32, terminator u16
          const preloadBytes = buf.readUInt16LE(pos + 4);
          const archive = buf.readUInt16LE(pos + 6);
          const offset = buf.readUInt32LE(pos + 8);
          const length = buf.readUInt32LE(pos + 12);
          pos += 18;
          const preload = buf.subarray(pos, pos + preloadBytes);
          pos += preloadBytes;
          entries.push({ path: dir === " " ? "" : dir, name, ext, archive, offset, length, preload: Buffer.from(preload) });
        }
      }
    }
    return new Vpk(dirFile, entries, end);
  }

  async read(e: VpkEntry): Promise<Buffer> {
    if (e.length === 0) return e.preload;
    const file = e.archive === 0x7fff ? this.dirFile : this.dirFile.replace(/_dir\.vpk$/, `_${String(e.archive).padStart(3, "0")}.vpk`);
    const start = e.archive === 0x7fff ? this.dataStart + e.offset : e.offset;
    const fh = await fs.open(file, "r");
    try {
      const out = Buffer.alloc(e.length);
      await fh.read(out, 0, e.length, start);
      return Buffer.concat([e.preload, out]);
    } finally {
      await fh.close();
    }
  }

  async close(): Promise<void> {
    /* files are opened per read */
  }
}
