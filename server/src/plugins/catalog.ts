/**
 * Plugins the panel knows how to install. Versions come from each source at
 * runtime; nothing here pins a version.
 */

export type PluginSource =
  | {
      type: "github";
      repo: string;
      /** Asset names to prefer, in order. Windows builds and debug symbols are always skipped. */
      prefer?: RegExp[];
      /** Only assets matching this are considered at all. */
      only?: RegExp;
    }
  | { type: "metamod" };

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  homepage: string;
  source: PluginSource;
  /** Other catalog ids that must be installed first. */
  requires: string[];
  /**
   * Where files go when an archive has no recognisable addons/ structure,
   * relative to addons/counterstrikesharp/ (e.g. "plugins/X" or "shared/X").
   */
  looseDir?: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "metamod",
    name: "Metamod:Source",
    description: "Plugin loader that everything else runs on.",
    homepage: "https://www.metamodsource.net",
    source: { type: "metamod" },
    requires: [],
  },
  {
    id: "counterstrikesharp",
    name: "CounterStrikeSharp",
    description: "C# plugin framework. Installed with its bundled .NET runtime.",
    homepage: "https://github.com/roflmuffin/CounterStrikeSharp",
    source: { type: "github", repo: "roflmuffin/CounterStrikeSharp", only: /linux/i, prefer: [/with-runtime/i] },
    requires: ["metamod"],
  },
  {
    id: "anybaselib",
    name: "AnyBaseLib",
    description: "Shared database library. Needed by PlayerSettings.",
    homepage: "https://github.com/NickFox007/AnyBaseLibCS2",
    source: { type: "github", repo: "NickFox007/AnyBaseLibCS2", prefer: [/linux/i] },
    requires: ["counterstrikesharp"],
    looseDir: "shared/AnyBaseLib",
  },
  {
    id: "playersettings",
    name: "PlayerSettings",
    description: "Stores per-player settings. Needed by MenuManager.",
    homepage: "https://github.com/NickFox007/PlayerSettingsCS2",
    source: { type: "github", repo: "NickFox007/PlayerSettingsCS2", prefer: [/linux/i] },
    requires: ["anybaselib"],
    looseDir: "plugins/PlayerSettings",
  },
  {
    id: "menumanager",
    name: "MenuManager",
    description: "In-game menus. Needed by CS2-SimpleAdmin.",
    homepage: "https://github.com/NickFox007/MenuManagerCS2",
    source: { type: "github", repo: "NickFox007/MenuManagerCS2", prefer: [/linux/i] },
    requires: ["playersettings"],
    looseDir: "plugins/MenuManagerCore",
  },
  {
    id: "cs2-simpleadmin",
    name: "CS2-SimpleAdmin",
    description: "Admin commands in game: kick, ban, mute, map change. Bans are shared across servers.",
    homepage: "https://github.com/daffyyyy/CS2-SimpleAdmin",
    source: { type: "github", repo: "daffyyyy/CS2-SimpleAdmin", only: /^CS2-SimpleAdmin-.*\.zip$/i },
    requires: ["menumanager", "playersettings", "anybaselib", "counterstrikesharp"],
    looseDir: "plugins/CS2-SimpleAdmin",
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

/** Catalog ids that must be installed before `id`, dependencies first, without `id` itself. */
export function dependencyOrder(id: string, lookup: (id: string) => CatalogEntry | undefined = catalogEntry): string[] {
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (cur: string) => {
    if (order.includes(cur)) return;
    if (visiting.has(cur)) throw new Error(`dependency cycle at ${cur}`);
    visiting.add(cur);
    for (const dep of lookup(cur)?.requires ?? []) visit(dep);
    visiting.delete(cur);
    order.push(cur);
  };
  visit(id);
  return order.slice(0, -1);
}

const SKIP_ASSET = /windows|win64|win32|\.pdb$|symbols|source code/i;
const ARCHIVE = /\.(zip|tar\.gz|tgz)$/i;

/** Picks the release asset to install. Returns undefined if none fits. */
export function pickAsset<T extends { name: string }>(assets: T[], source: Extract<PluginSource, { type: "github" }>): T | undefined {
  const candidates = assets.filter((a) => ARCHIVE.test(a.name) && !SKIP_ASSET.test(a.name) && (!source.only || source.only.test(a.name)));
  for (const p of source.prefer ?? []) {
    const hit = candidates.find((a) => p.test(a.name));
    if (hit) return hit;
  }
  return candidates.find((a) => /linux/i.test(a.name)) ?? candidates[0];
}
