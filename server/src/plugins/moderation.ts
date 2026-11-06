/**
 * What a moderation plugin (bans, in-game admins) offers the panel. A catalog
 * entry sets `moderation` to one of these; the panel never names the plugin.
 */

export interface ModerationBan {
  id: number;
  steamId: string | null;
  playerName: string | null;
  reason: string;
  adminName: string;
  /** Minutes; 0 = permanent. */
  duration: number;
  createdAt: string;
  endsAt: string | null;
  status: "active" | "expired" | "unbanned";
}

export interface ModerationAdmin {
  steamId: string;
  name: string;
  flags: string[];
  group: string | null;
  immunity: number;
  endsAt: string | null;
}

/** Read access to the plugin's data. */
export interface ModerationStore {
  /** Whether this data is shared by every server (e.g. one MySQL database). */
  shared: boolean;
  listBans(opts: { includeInactive: boolean; limit: number }): Promise<ModerationBan[]>;
  listAdmins(): Promise<ModerationAdmin[]>;
  close(): Promise<void>;
}

/** Console commands the plugin understands. Arguments are already validated and quoted-safe. */
export interface ModerationCommands {
  /** Lists online players with SteamIDs. */
  listPlayers: string;
  parsePlayers(output: string): { userId: number; steamId: string }[];
  banOnline(userId: number, minutes: number, reason: string): string;
  banOffline(steamId: string, minutes: number, reason: string): string;
  unban(steamId: string, reason: string): string;
  addAdmin(steamId: string, name: string, flags: string, immunity: number, minutes: number): string;
  removeAdmin(steamId: string): string;
}

/** Where the plugin keeps the maps its in-game change-map menu offers. */
export interface MapMenuConfig {
  /** JSON config file, relative to game/csgo. The plugin writes it on its first start. */
  file: string;
  /** Key holding a list of map names. */
  mapsKey: string;
  /** Key holding an object of workshop map name → workshop ID. */
  workshopKey: string;
}

export interface ModerationIntegration {
  /** The maps in the plugin's own change-map menu, if it has one. */
  mapMenu?: MapMenuConfig;
  /** Opens the plugin's data for a server. csgoDir is that server's game/csgo as it currently looks. */
  openStore(csgoDir: string): Promise<ModerationStore | null>;
  commands: ModerationCommands;
  /** Flag presets offered when adding an in-game admin. */
  flagPresets: { label: string; flags: string }[];
}
