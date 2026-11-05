import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { sha256 } from "../crypto.js";
import { badRequest, notFound } from "../errors.js";
import { GENERATED_CFG, InstanceFiles, exists, writeAtomic } from "./instance-files.js";

/** Editable areas, relative to game/csgo. */
export const EDITABLE_ROOTS = ["cfg/", "addons/counterstrikesharp/configs/"];
const EDITABLE_EXTENSIONS = new Set([".cfg", ".txt", ".json", ".toml", ".ini", ".vdf", ".yml", ".yaml"]);
export const MAX_CONFIG_BYTES = 512 * 1024;

export type ConfigSource = "stock" | "modified" | "custom";

export interface ConfigFileInfo {
  path: string;
  source: ConfigSource;
  size: number;
  readOnly: boolean;
}

export interface RevisionInfo {
  id: number;
  createdAt: string;
  authorName: string | null;
  comment: string;
  deleted: boolean;
  sha256: string | null;
}

/** Validates a config path (relative to game/csgo) and returns it normalised. */
export function normalizeConfigPath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 200) throw badRequest("Invalid file path.");
  if (input.includes("\0") || input.includes("\\")) throw badRequest("Invalid file path.");
  const p = path.posix.normalize(input.trim());
  if (p.startsWith("/") || p.startsWith("..") || p.split("/").includes("..")) throw badRequest("Invalid file path.");
  if (!EDITABLE_ROOTS.some((r) => p.startsWith(r)) || EDITABLE_ROOTS.includes(p + "/")) {
    throw badRequest("Only files under cfg/ and addons/counterstrikesharp/configs/ can be edited.");
  }
  if (!EDITABLE_EXTENSIONS.has(path.posix.extname(p).toLowerCase())) {
    throw badRequest(`Allowed file types: ${[...EDITABLE_EXTENSIONS].join(", ")}`);
  }
  if (!/^[A-Za-z0-9_\-./ ]+$/.test(p)) throw badRequest("File names can only contain letters, numbers, spaces and _ - .");
  return p;
}

interface Server {
  id: number;
  slug: string;
}

export class ConfigService {
  constructor(
    private readonly db: Db,
    private readonly files: InstanceFiles,
  ) {}

  private csgoUpper(slug: string): string {
    return path.join(this.files.upperDir(slug), "game", "csgo");
  }
  /** game/csgo as the running server sees it: through merged/ when mounted. */
  private async csgoLive(slug: string): Promise<string> {
    return path.join(await this.files.liveDir(slug), "game", "csgo");
  }
  private csgoBase(): string {
    return path.join(this.files.baseDir, "game", "csgo");
  }

  /** Refuses paths that pass through a symlink, so edits can't escape the server's directory. */
  private async assertNoSymlinks(root: string, rel: string): Promise<void> {
    let cur = root;
    for (const part of rel.split("/")) {
      cur = path.join(cur, part);
      try {
        if ((await fs.lstat(cur)).isSymbolicLink()) throw badRequest("Symbolic links can't be edited.");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
    }
  }

  async list(server: Server): Promise<ConfigFileInfo[]> {
    const found = new Map<string, ConfigFileInfo>();
    const walk = async (root: string, rel: string, fromUpper: boolean) => {
      let entries;
      try {
        entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = `${rel}${e.name}`;
        if (e.isDirectory()) {
          await walk(root, `${childRel}/`, fromUpper);
        } else if (e.isFile() && EDITABLE_EXTENSIONS.has(path.posix.extname(e.name).toLowerCase())) {
          const size = (await fs.stat(path.join(root, childRel))).size;
          const prev = found.get(childRel);
          let source: ConfigSource = fromUpper ? (prev ? "modified" : "custom") : "stock";
          // A copy identical to stock (e.g. reverted while running) still counts as stock.
          if (source === "modified" && (await sameContent(path.join(root, childRel), path.join(this.csgoBase(), childRel)))) source = "stock";
          found.set(childRel, { path: childRel, source, size, readOnly: childRel === `cfg/${GENERATED_CFG}` });
        }
      }
    };
    for (const r of EDITABLE_ROOTS) await walk(this.csgoBase(), r, false);
    for (const r of EDITABLE_ROOTS) await walk(this.csgoUpper(server.slug), r, true);
    return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Current content: the server's own copy if it has one, otherwise the stock file. */
  async readCurrent(server: Server, relPath: string): Promise<{ content: string; source: ConfigSource } | null> {
    const p = normalizeConfigPath(relPath);
    await this.assertNoSymlinks(this.csgoUpper(server.slug), p);
    const upper = path.join(this.csgoUpper(server.slug), p);
    const base = path.join(this.csgoBase(), p);
    if (await exists(upper)) {
      const content = await fs.readFile(upper, "utf8");
      if (!(await exists(base))) return { content, source: "custom" };
      return { content, source: content === (await fs.readFile(base, "utf8")) ? "stock" : "modified" };
    }
    if (await exists(base)) return { content: await fs.readFile(base, "utf8"), source: "stock" };
    return null;
  }

  async read(server: Server, relPath: string) {
    const p = normalizeConfigPath(relPath);
    const current = await this.readCurrent(server, p);
    if (!current) throw notFound("That file doesn't exist.");
    return {
      path: p,
      content: current.content,
      source: current.source,
      readOnly: p === `cfg/${GENERATED_CFG}`,
      revisions: this.revisions(server.id, p),
    };
  }

  revisions(serverId: number, p: string): RevisionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.created_at, u.display_name, u.steam_id, r.comment, r.content IS NULL AS deleted, r.sha256
         FROM config_revisions r JOIN config_files f ON f.id = r.config_file_id
         LEFT JOIN users u ON u.id = r.author_id
         WHERE f.server_id = ? AND f.path = ? ORDER BY r.id DESC LIMIT 200`,
      )
      .all(serverId, p) as unknown as {
      id: number;
      created_at: string;
      display_name: string | null;
      steam_id: string | null;
      comment: string;
      deleted: number;
      sha256: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      authorName: r.display_name ?? r.steam_id,
      comment: r.comment,
      deleted: r.deleted === 1,
      sha256: r.sha256,
    }));
  }

  revisionContent(serverId: number, revisionId: number): { path: string; content: string | null } {
    const row = this.db
      .prepare(
        `SELECT f.path, r.content FROM config_revisions r JOIN config_files f ON f.id = r.config_file_id
         WHERE r.id = ? AND f.server_id = ?`,
      )
      .get(revisionId, serverId) as { path: string; content: string | null } | undefined;
    if (!row) throw notFound("Revision not found.");
    return row;
  }

  private fileId(serverId: number, p: string): number {
    this.db.prepare("INSERT INTO config_files (server_id, path) VALUES (?, ?) ON CONFLICT DO NOTHING").run(serverId, p);
    return (this.db.prepare("SELECT id FROM config_files WHERE server_id = ? AND path = ?").get(serverId, p) as { id: number }).id;
  }

  private addRevision(fileId: number, content: string | null, authorId: number | null, comment: string): void {
    this.db
      .prepare("INSERT INTO config_revisions (config_file_id, content, sha256, author_id, comment) VALUES (?, ?, ?, ?, ?)")
      .run(fileId, content, content === null ? null : sha256(content), authorId, comment);
  }

  /** Snapshot the file as it was before the panel first touched it, so it can be restored. */
  private async ensureBaseline(server: Server, p: string, fileId: number): Promise<void> {
    const has = this.db.prepare("SELECT 1 FROM config_revisions WHERE config_file_id = ? LIMIT 1").get(fileId);
    if (has) return;
    const current = await this.readCurrent(server, p);
    this.addRevision(fileId, current?.content ?? null, null, current ? `Original (${current.source})` : "Did not exist");
  }

  async save(server: Server, relPath: string, content: string, authorId: number | null, comment = ""): Promise<{ changed: boolean }> {
    const p = normalizeConfigPath(relPath);
    if (p === `cfg/${GENERATED_CFG}`) throw badRequest("This file is managed by the panel. Change the server's settings instead.");
    if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) throw badRequest("File is too large (max 512 KB).");
    await this.assertNoSymlinks(this.csgoUpper(server.slug), p);
    const current = await this.readCurrent(server, p);
    if (current && current.content === content) return { changed: false };

    const fileId = this.fileId(server.id, p);
    await this.ensureBaseline(server, p, fileId);
    const live = await this.csgoLive(server.slug);
    await this.assertNoSymlinks(live, p);
    const target = path.join(live, p);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o2775 });
    await writeAtomic(target, content, 0o664);
    this.addRevision(fileId, content, authorId, comment.slice(0, 200));
    return { changed: true };
  }

  /** Removes the server's own copy: a modified stock file goes back to stock, a custom file is deleted. */
  async revert(server: Server, relPath: string, authorId: number | null, comment = ""): Promise<{ result: "stock" | "deleted" }> {
    const p = normalizeConfigPath(relPath);
    if (p === `cfg/${GENERATED_CFG}`) throw badRequest("This file is managed by the panel.");
    await this.assertNoSymlinks(this.csgoUpper(server.slug), p);
    const target = path.join(this.csgoUpper(server.slug), p);
    if (!(await exists(target))) throw notFound("This server has no copy of that file.");
    const fileId = this.fileId(server.id, p);
    await this.ensureBaseline(server, p, fileId);
    const basePath = path.join(this.csgoBase(), p);
    const stock = await exists(basePath);
    if (stock && (await this.files.isMounted(server.slug))) {
      // Deleting through a mounted overlay would hide the stock file too, so write
      // the stock content instead. The identical copy is cleaned up on the next start.
      const live = await this.csgoLive(server.slug);
      await writeAtomic(path.join(live, p), await fs.readFile(basePath, "utf8"), 0o664);
    } else {
      // A custom file can be deleted through merged/; a stock copy only while unmounted.
      await fs.rm(path.join(await this.csgoLive(server.slug), p));
    }
    this.addRevision(fileId, null, authorId, comment || (stock ? "Reverted to stock" : "Deleted"));
    return { result: stock ? "stock" : "deleted" };
  }

  async rollback(server: Server, revisionId: number, authorId: number | null) {
    const rev = this.revisionContent(server.id, revisionId);
    const comment = `Rolled back to revision #${revisionId}`;
    if (rev.content === null) {
      const upper = path.join(this.csgoUpper(server.slug), rev.path);
      if (await exists(upper)) await this.revert(server, rev.path, authorId, comment);
      return { path: rev.path };
    }
    // Restoring content identical to the stock file means "back to stock", so
    // the server doesn't keep a copy that would hide future CS2 updates.
    const basePath = path.join(this.csgoBase(), rev.path);
    const upper = path.join(this.csgoUpper(server.slug), rev.path);
    if ((await exists(basePath)) && (await fs.readFile(basePath, "utf8")) === rev.content) {
      if (await exists(upper)) await this.revert(server, rev.path, authorId, comment);
      return { path: rev.path };
    }
    await this.save(server, rev.path, rev.content, authorId, comment);
    return { path: rev.path };
  }
}

async function sameContent(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return x.equals(y);
  } catch {
    return false;
  }
}
