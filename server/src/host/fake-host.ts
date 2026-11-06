import { mkdirSync, writeFileSync, existsSync, rmSync, renameSync, symlinkSync, lstatSync } from "node:fs";
import path from "node:path";
import type { Cs2ctlVerb, Host, LogStream, ServiceStatus } from "./host.js";

/**
 * Simulated host for development and tests. Keeps service state in memory,
 * and "installs" a tiny fake CS2 base so the update flow can run end to end.
 */
export class FakeHost implements Host {
  readonly running = new Set<string>();
  readonly enabled = new Set<string>();
  readonly mounted = new Set<string>();
  readonly calls: string[] = [];
  readonly busyPorts = new Set<number>();
  private readonly listeners = new Map<string, Set<(line: string) => void>>();
  private since = new Map<string, string>();

  constructor(
    private readonly cs2Root: string,
    private readonly envDir: string,
  ) {}

  async cs2ctl(verb: Cs2ctlVerb, slug: string): Promise<string> {
    this.calls.push(`${verb} ${slug}`);
    switch (verb) {
      case "start":
      case "restart":
        this.mount(slug);
        this.running.add(slug);
        this.since.set(slug, new Date().toISOString());
        this.emit(slug, `${verb === "start" ? "Starting" : "Restarting"} CS2 server ${slug} (simulated)`);
        break;
      case "stop":
      case "kill":
        this.running.delete(slug);
        this.emit(slug, `Stopped CS2 server ${slug} (simulated)`);
        break;
      case "mount":
        this.mount(slug);
        break;
      case "umount":
        this.running.delete(slug);
        this.unmount(slug);
        break;
      case "enable":
        this.enabled.add(slug);
        break;
      case "disable":
        this.enabled.delete(slug);
        break;
      case "archive": {
        // Same effect as the real cs2ctl: keep upper/ in backups, remove the rest.
        this.running.delete(slug);
        this.unmount(slug);
        this.enabled.delete(slug);
        const inst = path.join(this.cs2Root, "instances", slug);
        const deleted = path.join(this.cs2Root, "backups", "deleted");
        mkdirSync(deleted, { recursive: true });
        if (existsSync(path.join(inst, "upper"))) renameSync(path.join(inst, "upper"), path.join(deleted, `${slug}-${Date.now()}`));
        rmSync(inst, { recursive: true, force: true });
        rmSync(path.join(this.envDir, `${slug}.env`), { force: true });
        return `archived ${slug}`;
      }
    }
    return "";
  }

  /** What Steam reports as the newest public build (tests change it to simulate a CS2 update). */
  latestBuildId = "20001234";
  steamCheckError: string | null = null;

  async steamAppInfo(): Promise<string> {
    this.calls.push("steam-check");
    if (this.steamCheckError) throw new Error(this.steamCheckError);
    return fakeAppInfo(this.latestBuildId);
  }

  async steamUpdate(_validate: boolean, onLine: (line: string) => void): Promise<void> {
    this.calls.push("steam-update");
    if (this.mounted.size > 0) throw new Error("refusing to update while server overlays are mounted");
    const lines = [
      "Redirecting stderr to '/home/cs2/Steam/logs/stderr.txt'",
      "Logging in user 'anonymous' to Steam Public...OK",
      " Update state (0x61) downloading, progress: 42.00 (simulated)",
      " Update state (0x61) downloading, progress: 100.00 (simulated)",
      "Success! App '730' fully installed.",
    ];
    for (const l of lines) {
      onLine(l);
      await new Promise((r) => setTimeout(r, 50));
    }
    installFakeBase(this.cs2Root, this.latestBuildId);
  }

  async isMounted(slug: string): Promise<boolean> {
    return this.mounted.has(slug);
  }

  /**
   * Simulated overlay: merged/ becomes a symlink to upper/, so writes through
   * merged/ land in upper/ like they would on a real overlay.
   */
  private mount(slug: string): void {
    if (this.mounted.has(slug)) return;
    const merged = path.join(this.cs2Root, "instances", slug, "merged");
    if (!existsSync(path.join(this.cs2Root, "instances", slug, "upper"))) return;
    rmSync(merged, { recursive: true, force: true });
    symlinkSync("upper", merged);
    this.mounted.add(slug);
  }

  private unmount(slug: string): void {
    if (!this.mounted.has(slug)) return;
    const merged = path.join(this.cs2Root, "instances", slug, "merged");
    try {
      if (lstatSync(merged).isSymbolicLink()) rmSync(merged);
      mkdirSync(merged, { recursive: true });
    } catch {
      /* instance already gone */
    }
    this.mounted.delete(slug);
  }

  async serviceStatus(slug: string): Promise<ServiceStatus> {
    const active = this.running.has(slug);
    return { state: active ? "active" : "inactive", pid: active ? 4242 : null, since: active ? (this.since.get(slug) ?? null) : null };
  }

  async isPortInUse(port: number): Promise<boolean> {
    return this.busyPorts.has(port);
  }

  followLogs(slug: string, _backlog: number, onLine: (line: string) => void): LogStream {
    const set = this.listeners.get(slug) ?? new Set();
    set.add(onLine);
    this.listeners.set(slug, set);
    onLine(`-- simulated journal for cs2@${slug} --`);
    return { stop: () => set.delete(onLine) };
  }

  cpuCount(): number {
    return 4;
  }

  private emit(slug: string, line: string): void {
    for (const l of this.listeners.get(slug) ?? []) l(`${new Date().toISOString()} cs2[4242]: ${line}`);
  }
}

/** Writes the few base files the panel reads: steam.inf and gameinfo.gi. */
export function installFakeBase(cs2Root: string, buildId = "20001234"): void {
  const csgo = path.join(cs2Root, "base", "game", "csgo");
  mkdirSync(path.join(csgo, "cfg"), { recursive: true });
  mkdirSync(path.join(cs2Root, "base", "game", "bin", "linuxsteamrt64"), { recursive: true });
  writeFileSync(path.join(csgo, "steam.inf"), "ClientVersion=2000123\nServerVersion=2000123\nPatchVersion=1.40.9.1\nProductName=cs2\nappID=730\n");
  writeFileSync(path.join(csgo, "gameinfo.gi"), FAKE_GAMEINFO);
  mkdirSync(path.join(cs2Root, "base", "steamapps"), { recursive: true });
  writeFileSync(
    path.join(cs2Root, "base", "steamapps", "appmanifest_730.acf"),
    `"AppState"\n{\n\t"appid"\t\t"730"\n\t"name"\t\t"Counter-Strike 2"\n\t"buildid"\t\t"${buildId}"\n\t"LastUpdated"\t\t"1762400000"\n}\n`,
  );
  if (!existsSync(path.join(csgo, "cfg", "gamemode_competitive.cfg"))) {
    writeFileSync(path.join(csgo, "cfg", "gamemode_competitive.cfg"), "// stock competitive settings (simulated)\nmp_maxrounds 24\n");
  }
}

const FAKE_GAMEINFO = `"GameInfo"
{
	game		"Counter-Strike 2"
	FileSystem
	{
		SearchPaths
		{
			Game_LowViolence	csgo_lv // Perfect World content override
			Game	csgo
			Game	csgo_imported
			Game	csgo_core
			Game	core
			Mod	csgo
			Mod	csgo_imported
			Mod	csgo_core
		}
	}
}
`;

function fakeAppInfo(buildId: string): string {
  return `Connecting anonymously to Steam Public...OK
AppID : 730, change number : 31337/0, last change : Thu Nov  5 18:00:00 2026
"730"
{
	"common"
	{
		"name"		"Counter-Strike 2"
	}
	"depots"
	{
		"branches"
		{
			"public"
			{
				"buildid"		"${buildId}"
				"timeupdated"		"1762450000"
			}
			"beta"
			{
				"buildid"		"99999999"
			}
		}
	}
}
`;
}
