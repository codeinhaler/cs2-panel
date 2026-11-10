import type { HumanCounter } from "../automation/humans.js";
import type { ServerRecord } from "../servers/store.js";
import { BRIDGE_ID } from "../players/bans.js";
import type { PluginService } from "./service.js";

/**
 * Keeps the CS2 Panel Bridge on every server at the version in this panel release. The bridge and the
 * panel are built together (the panel relies on what the bridge reports), so after a panel update each
 * server gets the new bridge — but only when nobody is on it and it isn't busy with a match, because
 * installing a plugin restarts a running server. Other plugins are never updated automatically.
 */
export class BridgeAutoUpdate {
  private lastCheck = -Infinity;

  constructor(
    private readonly plugins: PluginService,
    private readonly listServers: () => ServerRecord[],
    private readonly humans: HumanCounter,
    /** True while matchmaking uses the server (a match, or its cleanup afterwards). */
    private readonly inUse: (serverId: number) => boolean,
    private readonly everyMs = 5 * 60_000,
  ) {}

  async tick(now = new Date()): Promise<void> {
    if (now.getTime() - this.lastCheck < this.everyMs) return;
    this.lastCheck = now.getTime();
    const latest = await this.plugins.latestVersion(BRIDGE_ID);
    if (!latest) return;
    for (const s of this.listServers()) {
      const current = this.plugins.installedVersion(s.id, BRIDGE_ID);
      if (!current || current === latest) continue;
      if (this.inUse(s.id) || this.plugins.isBusy(s.id)) continue;
      // 0 also when the server is stopped; null (couldn't tell) waits for the next check.
      if ((await this.humans(s.id)) !== 0) continue;
      try {
        await this.plugins.install(s.id, BRIDGE_ID, undefined, null);
      } catch (e) {
        console.warn(`bridge auto-update: ${s.name} failed: ${(e as Error).message}`);
      }
    }
  }
}
