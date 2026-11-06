import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";
import { hasMetamodPath, parseSteamInf, patchGameinfo } from "../game/gameinfo.js";

/** Paths, relative to an instance's upper dir, that may legitimately live there. */
export const UPPER_ALLOWLIST = ["game/csgo/cfg/", "game/csgo/addons/", "game/csgo/logs/", "game/csgo/gameinfo.gi"];

export const GENERATED_CFG = "cs2panel_generated.cfg";
const GAMEINFO_REL = "game/csgo/gameinfo.gi";

export interface LaunchSettings {
  port: number;
  cpu: number;
  map: string;
  gameType: number;
  gameMode: number;
  maxPlayers: number;
  gsltToken: string | null;
  extraArgs: string;
}

export interface GeneratedCfgSettings {
  hostname: string;
  password: string | null;
  rconPassword: string;
}

/**
 * Filesystem layout for servers.
 *
 * OverlayFS rule: while a server's overlay is mounted, its upper dir must not
 * be changed directly. New and changed files are written through merged/
 * (`liveDir`); anything that deletes or replaces a file the base also has
 * (gameinfo.gi, reverting a stock config, removing plugins) happens only
 * while the overlay is unmounted (`assertUnmounted`).
 */
export class InstanceFiles {
  constructor(
    readonly cs2Root: string,
    readonly envDir: string,
    readonly isMounted: (slug: string) => Promise<boolean> = async () => false,
  ) {}

  get baseDir(): string {
    return path.join(this.cs2Root, "base");
  }
  instanceDir(slug: string): string {
    return path.join(this.cs2Root, "instances", slug);
  }
  upperDir(slug: string): string {
    return path.join(this.instanceDir(slug), "upper");
  }
  mergedDir(slug: string): string {
    return path.join(this.instanceDir(slug), "merged");
  }
  /** Where to write new or changed files right now: merged/ if mounted, else upper/. */
  async liveDir(slug: string): Promise<string> {
    return (await this.isMounted(slug)) ? this.mergedDir(slug) : this.upperDir(slug);
  }
  async assertUnmounted(slug: string): Promise<void> {
    if (await this.isMounted(slug)) throw new Error(`internal: ${slug}'s overlay must be unmounted for this change`);
  }
  cfgDir(slug: string): string {
    return path.join(this.upperDir(slug), "game", "csgo", "cfg");
  }
  envFile(slug: string): string {
    return path.join(this.envDir, `${slug}.env`);
  }

  async baseInstalled(): Promise<boolean> {
    return exists(path.join(this.baseDir, "game", "csgo", "steam.inf"));
  }

  async baseVersion(): Promise<{ patchVersion: string | null; buildId: string | null }> {
    try {
      const inf = parseSteamInf(await fs.readFile(path.join(this.baseDir, "game", "csgo", "steam.inf"), "utf8"));
      return { patchVersion: inf.PatchVersion ?? null, buildId: inf.ServerVersion ?? inf.ClientVersion ?? null };
    } catch {
      return { patchVersion: null, buildId: null };
    }
  }

  /** Creates upper/work/merged dirs. Fails if the instance dir already exists. */
  async createDirs(slug: string): Promise<void> {
    const dir = this.instanceDir(slug);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.mkdir(dir, { mode: 0o2775 }); // throws EEXIST, which is what we want
    for (const sub of ["upper", "work", "merged"]) await fs.mkdir(path.join(dir, sub), { mode: 0o2775 });
    await fs.mkdir(this.cfgDir(slug), { recursive: true, mode: 0o2775 });
  }

  /** Removes an instance that was never mounted (used to roll back a failed create). */
  async removeUnmounted(slug: string): Promise<void> {
    await fs.rm(this.instanceDir(slug), { recursive: true, force: true });
    await fs.rm(this.envFile(slug), { force: true });
  }

  async writeCfgFiles(slug: string, files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(this.cfgDir(slug), rel);
      if (!target.startsWith(this.cfgDir(slug) + path.sep)) throw new Error(`bad preset path ${rel}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { mode: 0o664 });
    }
  }

  /** Copies another server's cfg and addons into a new server (for Duplicate). */
  async copyFrom(sourceSlug: string, targetSlug: string): Promise<void> {
    for (const rel of ["game/csgo/cfg", "game/csgo/addons"]) {
      const src = path.join(this.upperDir(sourceSlug), rel);
      if (!(await exists(src))) continue;
      await fs.cp(src, path.join(this.upperDir(targetSlug), rel), {
        recursive: true,
        filter: (s) => path.basename(s) !== GENERATED_CFG,
      });
    }
  }

  async writeLaunchEnv(slug: string, s: LaunchSettings): Promise<void> {
    const args = [
      // Without this CS2 may bind RCON (TCP) to the LAN address only, and the
      // panel's connection to 127.0.0.1 is refused.
      "+ip",
      "0.0.0.0",
      "-port",
      String(s.port),
      "-usercon",
      "-maxplayers",
      String(s.maxPlayers),
      "+game_type",
      String(s.gameType),
      "+game_mode",
      String(s.gameMode),
      "+exec",
      GENERATED_CFG,
      ...(s.gsltToken ? ["+sv_setsteamaccount", s.gsltToken] : []),
      "+map",
      s.map,
      ...(s.extraArgs.trim() ? s.extraArgs.trim().split(/\s+/) : []),
    ];
    const content =
      "# Generated by cs2-panel. Do not edit; change settings in the panel instead.\n" +
      `CS2_CPU=${s.cpu}\n` +
      `CS2_ARGS=${args.join(" ")}\n`;
    await fs.mkdir(this.envDir, { recursive: true });
    await writeAtomic(this.envFile(slug), content, 0o640);
  }

  async writeGeneratedCfg(slug: string, s: GeneratedCfgSettings): Promise<void> {
    const q = (v: string) => `"${v.replace(/["\\;\r\n]/g, "")}"`;
    const content =
      "// Generated by cs2-panel on every settings change. Edits here are overwritten.\n" +
      `hostname ${q(s.hostname)}\n` +
      `sv_password ${q(s.password ?? "")}\n` +
      `rcon_password ${q(s.rconPassword)}\n`;
    const dir = path.join(await this.liveDir(slug), "game", "csgo", "cfg");
    await fs.mkdir(dir, { recursive: true, mode: 0o2775 });
    await writeAtomic(path.join(dir, GENERATED_CFG), content, 0o660);
  }

  /**
   * Makes the server's gameinfo.gi current: drops any old copy, and if
   * Metamod is installed for this server, writes a freshly patched copy of
   * the base file. Returns what it did.
   */
  async regenerateGameinfo(slug: string): Promise<"patched" | "base" | "no-base"> {
    await this.assertUnmounted(slug);
    const upperCopy = path.join(this.upperDir(slug), GAMEINFO_REL);
    await fs.rm(upperCopy, { force: true });
    const metamodDir = path.join(this.upperDir(slug), "game", "csgo", "addons", "metamod");
    if (!(await exists(metamodDir))) return "base";
    let base: string;
    try {
      base = await fs.readFile(path.join(this.baseDir, GAMEINFO_REL), "utf8");
    } catch {
      return "no-base";
    }
    const patched = patchGameinfo(base);
    if (!hasMetamodPath(patched)) throw new Error("patching gameinfo.gi failed");
    await fs.mkdir(path.dirname(upperCopy), { recursive: true });
    await writeAtomic(upperCopy, patched, 0o664);
    return "patched";
  }

  /**
   * Removes config files from the server's own layer that are identical to the
   * stock file, so they don't hide future CS2 updates. Needs the overlay unmounted.
   */
  async dedupeStockConfigs(slug: string): Promise<string[]> {
    await this.assertUnmounted(slug);
    const removed: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(path.join(this.upperDir(slug), rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          await walk(childRel);
        } else if (e.isFile()) {
          const base = path.join(this.baseDir, childRel);
          try {
            const [a, b] = await Promise.all([fs.readFile(path.join(this.upperDir(slug), childRel)), fs.readFile(base)]);
            if (a.equals(b)) {
              await fs.rm(path.join(this.upperDir(slug), childRel));
              removed.push(childRel);
            }
          } catch {
            /* no stock file: keep it */
          }
        }
      }
    };
    await walk("game/csgo/cfg");
    return removed;
  }

  /**
   * Lists files in the server's upper dir that are outside the allowlist and
   * shadow a file in the base install. Those would hide future CS2 updates.
   */
  async hygieneScan(slug: string): Promise<string[]> {
    const upper = this.upperDir(slug);
    const problems: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(path.join(upper, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (isAllowedUpperPath(childRel)) continue;
        if (e.isDirectory()) {
          await walk(childRel);
        } else if (e.isCharacterDevice()) {
          // OverlayFS whiteout: something deleted a base file for this server.
          problems.push(`${childRel} (hides a deleted base file)`);
        } else if (await exists(path.join(this.baseDir, childRel))) {
          problems.push(childRel);
        }
      }
    };
    await walk("");
    return problems;
  }
}

export function isAllowedUpperPath(rel: string): boolean {
  return UPPER_ALLOWLIST.some((a) => (a.endsWith("/") ? (rel + "/").startsWith(a) : rel === a));
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsc.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeAtomic(file: string, content: string, mode: number): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, { mode });
  await fs.rename(tmp, file);
}
