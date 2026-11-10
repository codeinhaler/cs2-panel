import { describe, expect, it } from "vitest";
import { BridgeAutoUpdate } from "../src/plugins/bridge-autoupdate.js";
import type { PluginService } from "../src/plugins/service.js";
import type { ServerRecord } from "../src/servers/store.js";

/** Three servers on an old bridge; which ones get the new one depends on who's on them. */
function setup(opts: { humans?: Record<number, number | null>; inUse?: number[]; busy?: number[]; installed?: Record<number, string | null> } = {}) {
  const installs: number[] = [];
  const installed: Record<number, string | null> = { 1: "v0.9.18", 2: "v0.9.18", 3: "v0.9.18", ...opts.installed };
  const plugins = {
    latestVersion: async () => "v0.9.19",
    installedVersion: (id: number) => installed[id] ?? null,
    isBusy: (id: number) => (opts.busy ?? []).includes(id),
    install: async (id: number, pluginId: string, version: string | undefined, actorId: number | null) => {
      expect(pluginId).toBe("cs2panel-bridge");
      expect(actorId).toBeNull();
      installs.push(id);
      installed[id] = "v0.9.19";
      return { installed: [], restarted: false };
    },
  } as unknown as PluginService;
  const servers = [1, 2, 3].map((id) => ({ id, name: `Server ${id}` }) as ServerRecord);
  const humans = opts.humans ?? {}; // Kept by reference, so a test can change who's on a server.
  const updater = new BridgeAutoUpdate(
    plugins,
    () => servers,
    async (id) => (id in humans ? humans[id]! : 0),
    (id) => (opts.inUse ?? []).includes(id),
  );
  return { updater, installs };
}

describe("bridge auto-update", () => {
  it("updates the bridge on empty servers only", async () => {
    const { updater, installs } = setup({ humans: { 2: 3, 3: null } });
    await updater.tick(new Date(0));
    // Server 2 has people on it, and server 3 couldn't be asked: both wait.
    expect(installs).toEqual([1]);
  });

  it("leaves servers in a match, its cleanup, or another plugin change alone", async () => {
    const { updater, installs } = setup({ inUse: [1], busy: [2] });
    await updater.tick(new Date(0));
    expect(installs).toEqual([3]);
  });

  it("skips servers without the bridge or already up to date, and checks every 5 minutes", async () => {
    const { updater, installs } = setup({ installed: { 1: null, 2: "v0.9.19" }, humans: { 3: 1 } });
    await updater.tick(new Date(0));
    expect(installs).toEqual([]);
    // Not checked again before 5 minutes are up.
    await updater.tick(new Date(60_000));
    expect(installs).toEqual([]);
  });

  it("catches up once the people have left", async () => {
    const humans: Record<number, number> = { 1: 2, 2: 0, 3: 0 };
    const { updater, installs } = setup({ humans });
    await updater.tick(new Date(0));
    expect(installs).toEqual([2, 3]);
    humans[1] = 0;
    await updater.tick(new Date(5 * 60_000));
    expect(installs).toEqual([2, 3, 1]);
  });
});
