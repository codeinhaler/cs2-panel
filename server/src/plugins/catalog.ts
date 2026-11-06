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

import type { ModerationIntegration } from "./moderation.js";
import { simpleAdminModeration } from "./integrations/simpleadmin.js";

/** Connection settings for the panel's shared MariaDB (set up by setup-mariadb.sh). */
export interface DatabaseSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * A plugin that stores data in a database. When the shared database is set up,
 * the panel writes its connection settings into the plugin's config on every
 * install, so all servers share the same data.
 */
export interface DatabaseIntegration {
  /** The plugin's config file, relative to game/csgo. */
  configFile: string;
  /** What sharing gives you, shown next to the plugin. */
  benefit: string;
  /** Returns the config with the database settings filled in. Keep the rest untouched. */
  apply(config: Record<string, unknown>, db: DatabaseSettings): Record<string, unknown>;
}

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
  database?: DatabaseIntegration;
  /** Bans and in-game admins the panel can manage through this plugin. */
  moderation?: ModerationIntegration;
  /** Libraries other plugins need; hidden from "pick plugins" lists. */
  library?: boolean;
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
    description: "Shared database library used by other plugins.",
    homepage: "https://github.com/NickFox007/AnyBaseLibCS2",
    source: { type: "github", repo: "NickFox007/AnyBaseLibCS2", prefer: [/linux/i] },
    requires: ["counterstrikesharp"],
    looseDir: "shared/AnyBaseLib",
    library: true,
  },
  {
    id: "playersettings",
    name: "PlayerSettings",
    description: "Stores per-player settings.",
    homepage: "https://github.com/NickFox007/PlayerSettingsCS2",
    source: { type: "github", repo: "NickFox007/PlayerSettingsCS2", prefer: [/linux/i] },
    requires: ["anybaselib"],
    looseDir: "plugins/PlayerSettings",
    library: true,
  },
  {
    id: "menumanager",
    name: "MenuManager",
    description: "In-game menus for plugins.",
    homepage: "https://github.com/NickFox007/MenuManagerCS2",
    source: { type: "github", repo: "NickFox007/MenuManagerCS2", prefer: [/linux/i] },
    requires: ["playersettings"],
    looseDir: "plugins/MenuManagerCore",
    library: true,
  },
  {
    id: "cs2-simpleadmin",
    name: "CS2-SimpleAdmin",
    description: "Admin commands in game: kick, ban, mute, map change.",
    homepage: "https://github.com/daffyyyy/CS2-SimpleAdmin",
    source: { type: "github", repo: "daffyyyy/CS2-SimpleAdmin", only: /^CS2-SimpleAdmin-.*\.zip$/i },
    requires: ["menumanager", "playersettings", "anybaselib", "counterstrikesharp"],
    looseDir: "plugins/CS2-SimpleAdmin",
    moderation: simpleAdminModeration,
    database: {
      configFile: "addons/counterstrikesharp/configs/plugins/CS2-SimpleAdmin/CS2-SimpleAdmin.json",
      benefit: "bans, mutes and admins apply on every server",
      apply: (config, db) => ({
        ConfigVersion: 25,
        ...config,
        DatabaseConfig: {
          ...((config.DatabaseConfig as Record<string, unknown>) ?? {}),
          DatabaseType: "MySQL",
          DatabaseHost: db.host,
          DatabasePort: db.port,
          DatabaseUser: db.user,
          DatabasePassword: db.password,
          DatabaseName: db.database,
        },
        MultiServerMode: true,
      }),
    },
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
