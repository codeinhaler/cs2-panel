import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Unpacks a .zip or .tar.gz into an empty directory, using the system's unzip/tar. */
export async function extractArchive(archive: string, into: string): Promise<void> {
  await fs.mkdir(into, { recursive: true });
  const name = archive.toLowerCase();
  if (name.endsWith(".zip")) {
    // -n: never overwrite; unzip refuses paths that escape the target dir.
    await execFileP("unzip", ["-q", "-n", archive, "-d", into], { maxBuffer: 16 * 1024 * 1024 });
  } else if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    await execFileP("tar", ["-xzf", archive, "-C", into, "--no-same-owner", "--no-same-permissions"]);
  } else {
    throw new Error(`Unsupported archive type: ${path.basename(archive)}`);
  }
}

/** Lists regular files under dir (relative, posix). Symlinks and other oddities are ignored. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  await walk("");
  return out.sort();
}

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/;
const CSSHARP_DIRS = new Set(["plugins", "shared", "configs", "gamedata"]);

/**
 * Maps files in an unpacked plugin archive to where they belong, relative to
 * game/csgo. Handles the layouts plugin authors commonly ship:
 *
 *   addons/...                       → as is
 *   <wrapper>/addons/...             → wrapper dropped
 *   counterstrikesharp/...           → addons/counterstrikesharp/...
 *   plugins/X/..., shared/X/...      → addons/counterstrikesharp/plugins|shared/...
 *   loose files (X.dll, ...)         → addons/counterstrikesharp/<looseDir>/...
 *
 * Files outside a recognised layout (READMEs next to an addons/ folder, etc.)
 * are dropped when the rest of the archive has a layout.
 */
export function mapArchiveFiles(files: string[], looseDir?: string): Map<string, string> {
  const mapped = new Map<string, string>();
  const loose: string[] = [];
  for (const f of files) {
    if (JUNK.test(f)) continue;
    const parts = f.split("/");
    const addons = parts.indexOf("addons");
    const css = parts.indexOf("counterstrikesharp");
    if (addons >= 0 && addons < parts.length - 1) {
      mapped.set(f, parts.slice(addons).join("/"));
    } else if (css >= 0 && css < parts.length - 1) {
      mapped.set(f, ["addons", ...parts.slice(css)].join("/"));
    } else {
      const top = parts.findIndex((p) => CSSHARP_DIRS.has(p));
      if (top >= 0 && top <= 1 && top < parts.length - 1) {
        mapped.set(f, ["addons", "counterstrikesharp", ...parts.slice(top)].join("/"));
      } else {
        loose.push(f);
      }
    }
  }
  if (mapped.size === 0 && loose.length && looseDir) {
    // No structure at all: everything is the plugin's own folder. Drop one wrapper dir if all files share it.
    const first = loose[0]!.split("/")[0]!;
    const wrapped = loose.every((f) => f.includes("/") && f.split("/")[0] === first);
    for (const f of loose) {
      const rel = wrapped ? f.slice(first.length + 1) : f;
      mapped.set(f, `addons/counterstrikesharp/${looseDir}/${rel}`);
    }
  }
  for (const [src, dest] of mapped) {
    const norm = path.posix.normalize(dest);
    if (norm !== dest || !dest.startsWith("addons/") || dest.split("/").includes("..")) mapped.delete(src);
  }
  return mapped;
}

/** Plugin config files are the admin's: an install never overwrites existing ones. */
export function isPreservedConfig(rel: string): boolean {
  return rel.startsWith("addons/counterstrikesharp/configs/");
}
