// Typed client for the panel's API.

export type Role = "owner" | "admin" | "moderator";
export type Permission =
  | "view"
  | "players.moderate"
  | "rcon"
  | "server.control"
  | "config.edit"
  | "plugins.manage"
  | "plugins.upload"
  | "game.update"
  | "server.manage"
  | "preset.manage"
  | "server.delete"
  | "server.rawargs"
  | "users.manage"
  | "gameadmins.manage";

import { formatDate, formatDateTime, type Prefs } from "./format";

export interface User {
  id: number;
  steamId: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  prefs: Prefs;
}

export interface Me {
  user: User;
  permissions: Permission[];
  dev: boolean;
  version: string;
}

export type ServiceState = "active" | "activating" | "deactivating" | "inactive" | "failed" | "unknown";

export interface Server {
  id: number;
  slug: string;
  name: string;
  presetId: number | null;
  presetName: string | null;
  port: number;
  cpu: number;
  map: string;
  gameType: number;
  gameMode: number;
  maxPlayers: number;
  password: string;
  gsltSet: boolean;
  gsltHint: string | null;
  extraArgs: string;
  autostart: boolean;
  createdAt: string;
  status: { state: ServiceState; since: string | null; pid: number | null };
  live: { name: string; map: string; players: number; maxPlayers: number; bots: number; version: string } | null;
  /** Running servers: whether the game answers yet (players can join only when it does). */
  answering: "yes" | "starting" | "no" | null;
}

export interface Preset {
  id: number;
  key: string;
  name: string;
  description: string;
  builtin: boolean;
  gameType: number;
  gameMode: number;
  defaultMap: string;
  maxPlayers: number;
  /** Relative to cfg/ → content. */
  configFiles: Record<string, string>;
  /** cfg files run on every map start. */
  execConfigs: string[];
}

export type PresetInput = Omit<Preset, "id" | "key" | "builtin">;

export interface HostInfo {
  cpuCount: number;
  suggestedCpu: number;
  usedPorts: { serverId: number; name: string; port: number }[];
  cs2: { installed: boolean; patchVersion: string | null; buildId: string | null };
  busy: string | null;
  update: { available: boolean; latestBuild: string | null; policy: UpdatePolicy; deadline: string | null };
}

export interface ConfigFileInfo {
  path: string;
  source: "stock" | "modified" | "custom";
  size: number;
  readOnly: boolean;
}

export interface Revision {
  id: number;
  createdAt: string;
  authorName: string | null;
  comment: string;
  deleted: boolean;
  sha256: string | null;
}

export interface ConfigFile {
  path: string;
  content: string;
  source: "stock" | "modified" | "custom";
  readOnly: boolean;
  revisions: Revision[];
}

export interface PluginStatus {
  id: string;
  name: string;
  description: string;
  homepage: string | null;
  requires: string[];
  custom: boolean;
  installed: { version: string; installedAt: string; installedBy: string | null } | null;
  dependents: string[];
  previousVersion: string | null;
  latest: string | null;
  latestError: string | null;
  library: boolean;
  databaseBenefit: string | null;
}

export interface CatalogPlugin {
  id: string;
  name: string;
  description: string;
  requires: string[];
  library: boolean;
}

export interface PluginHealth {
  reachable: boolean;
  error: string | null;
  metamodLoaded: boolean;
  cssharpLoaded: boolean;
  metamodOutput: string;
  cssharpOutput: string;
}

export interface OnlinePlayer {
  userId: number;
  name: string;
  time: string | null;
  ping: number;
  loss: number;
  state: string;
  address: string | null;
  bot: boolean;
  steamId: string | null;
}

export interface ModerationInfo {
  provider: string | null;
  shared: boolean;
  canAct: boolean;
  flagPresets: { label: string; flags: string }[];
  mapMenu: boolean;
  error: string | null;
}

export interface MapMenu {
  maps: string[];
  workshop: { name: string; id: string }[];
}

export interface Ban {
  id: number;
  steamId: string | null;
  playerName: string | null;
  reason: string;
  adminName: string;
  duration: number;
  createdAt: string;
  endsAt: string | null;
  status: "active" | "expired" | "unbanned";
}

/** A ban the panel owns; it applies on every server running the bridge. */
export interface PanelBan {
  id: number;
  steamId: string;
  name: string | null;
  reason: string;
  createdBy: string | null;
  createdAt: string;
  serverName: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  status: "active" | "expired" | "unbanned";
}

export interface BanCoverage {
  enforced: { id: number; name: string }[];
  missing: { id: number; name: string }[];
}

export interface WorkshopInfo {
  id: string;
  kind: "map" | "collection";
  status: "ok" | "missing" | "removed" | "private" | "wrong-game" | "wrong-kind" | "unknown";
  title: string | null;
  sizeBytes: number | null;
  itemCount: number | null;
  message: string;
}

export type MetricRange = "1h" | "6h" | "24h" | "7d" | "30d" | "90d";

export interface MetricPoint {
  t: number;
  cpu: number | null;
  cpuMax: number | null;
  mem: number | null;
  memTotal: number | null;
  players: number | null;
  bots: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  netRx: number | null;
  netTx: number | null;
}

export interface MetricSeries {
  from: number;
  to: number;
  bucketMs: number;
  points: MetricPoint[];
}

export interface PanelAlert {
  id: number;
  kind: string;
  serverId: number | null;
  serverName: string | null;
  message: string;
  startedAt: string;
  resolvedAt: string | null;
}

export interface MonitorOverview {
  latest: Record<string, MetricPoint>;
  alerts: PanelAlert[];
  cpuCount: number;
  servers: { id: number; name: string; cpu: number }[];
}

export interface BackupInfo {
  id: string;
  kind: "server" | "panel";
  file: string;
  serverId: number | null;
  serverName: string | null;
  sizeBytes: number;
  createdAt: string;
  createdBy: string | null;
  trigger: "manual" | "nightly" | "before-restore";
}

export interface BackupSettings {
  enabled: boolean;
  time: string;
  keep: number;
}

export interface SharedConfig {
  hostnamePrefix: string;
  tags: string;
  cvars: string;
  excluded: number[];
}

export type EventGroup = "problems" | "updates" | "restarts" | "moderation" | "servers";

export interface DiscordSettings {
  webhookSet: boolean;
  webhookHint: string | null;
  events: Record<EventGroup, boolean>;
}

export interface PluginPage {
  pluginId: string;
  label: string;
  kind: "moderation";
}

export interface ServerDetail {
  server: Server;
  pluginPages: PluginPage[];
  bridge: boolean;
  execConfigs: string[];
  /** The GSLT itself; only sent to roles that may change it. */
  gslt?: string;
}

export interface GameAdmin {
  steamId: string;
  name: string;
  flags: string[];
  group: string | null;
  immunity: number;
  endsAt: string | null;
}

export interface RecentPlayer {
  name: string;
  steamId: string | null;
  serverId: number;
  serverName: string | null;
  lastSeenAt: string;
  online: boolean;
}

export interface AuditEntry {
  id: number;
  userId: number | null;
  userName: string | null;
  userSteamId: string | null;
  action: string;
  serverId: number | null;
  serverName: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export type UpdatePolicy = "off" | "notify" | "when-empty" | "now";

export interface UpdateSettings {
  policy: UpdatePolicy;
  checkMinutes: number;
  maxWaitMinutes: number;
  warnSeconds: number;
}

export interface AutoUpdateStatus {
  settings: UpdateSettings;
  installedBuild: string | null;
  latestBuild: string | null;
  latestUpdatedAt: string | null;
  checkedAt: string | null;
  error: string | null;
  pendingSince: string | null;
  updateAvailable: boolean;
  checking: boolean;
  deadline: string | null;
}

export interface GameState {
  cs2: { installed: boolean; patchVersion: string | null; buildId: string | null };
  job: { state: "idle" | "running" | "succeeded" | "failed"; startedAt: string | null; finishedAt: string | null; trigger: string | null };
  lines: string[];
  next: number;
  auto: AutoUpdateStatus;
}

export interface RestartSchedule {
  restartAt: string | null;
  ifPlayers: "wait" | "restart";
  maxWaitMinutes: number;
}

export interface ScheduleView {
  schedule: RestartSchedule;
  nextAt: string | null;
  waitingSince: string | null;
  deadline: string | null;
  timezone: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------- matchmaking

export interface MatchmakingSettings {
  enabled: boolean;
  port: number;
  title: string;
  serverIds: number[];
  maps: string[];
  gameAddress: string;
  vetoSeconds: number;
}

export interface MmRating {
  value: number | null;
  source: "admin" | "leetify" | "self" | "none";
  note: string | null;
  pending?: boolean;
}

export interface MmMember {
  steamId: string;
  name: string;
  avatarUrl: string | null;
  rating: MmRating;
}

export interface MmMatch {
  id: number;
  phase: "veto" | "side" | "starting" | "live" | "over" | "cancelled" | "abandoned";
  teamA: MmMember[];
  teamB: MmMember[];
  map: string | null;
  serverName: string | null;
  status: string;
  connected: number;
  expected: number;
  score: { a: number; b: number } | null;
}

export interface MatchmakingInfo {
  settings: MatchmakingSettings;
  leetifyKeyHint: string | null;
  site: { listening: boolean; port: number | null; error: string | null };
  servers: { id: number; name: string; port: number; inPool: boolean; hasBridge: boolean }[];
  maps: string[];
  state: {
    lobby: (MmMember & { status: "ready" | "away" | "in-match"; leetifyUrl: string })[];
    draft: { id: number; teamA: MmMember[]; teamB: MmMember[] } | null;
    matches: MmMatch[];
    freeServers: number;
  };
  history: {
    id: number;
    serverId: number | null;
    map: string | null;
    teamA: { steamId: string; name: string }[];
    teamB: { steamId: string; name: string }[];
    scoreA: number | null;
    scoreB: number | null;
    status: string;
    note: string | null;
    createdAt: string;
    endedAt: string | null;
  }[];
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/me")) window.location.assign("/login");
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

const q = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString();

export const api = {
  me: () => request<Me>("GET", "/api/me"),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
  savePrefs: (prefs: Prefs) => request<{ prefs: Prefs }>("PUT", "/api/me/prefs", prefs),

  users: () => request<{ users: User[] }>("GET", "/api/users"),
  addUser: (steam: string, role: "admin" | "moderator") => request<{ user: User }>("POST", "/api/users", { steam, role }),
  updateUser: (id: number, changes: { role?: "admin" | "moderator"; disabled?: boolean }) =>
    request<{ user: User }>("PATCH", `/api/users/${id}`, changes),
  removeUser: (id: number) => request<{ ok: true }>("DELETE", `/api/users/${id}`),

  audit: (params: { before?: number; serverId?: number; limit?: number } = {}) =>
    request<{ entries: AuditEntry[] }>("GET", `/api/audit?${q(params)}`),

  host: () => request<HostInfo>("GET", "/api/host"),
  gameMode: (id: number) =>
    request<{
      saved: { presetId: number | null; presetName: string | null; gameType: number; gameMode: number; map: string };
      live: { presetName: string; map: string } | null;
    }>("GET", `/api/servers/${id}/gamemode`),
  switchGameMode: (id: number, body: { presetId: number; map?: string; keep: boolean; applyConfigs: boolean }) =>
    request<{ output: string; maxPlayersNote: string | null }>("POST", `/api/servers/${id}/gamemode`, body),
  command: (id: number, body: { action: string; [k: string]: unknown }) => request<{ output: string }>("POST", `/api/servers/${id}/commands`, body),
  workshop: (id: string, kind: "map" | "collection") => request<WorkshopInfo>("GET", `/api/workshop/${id}?kind=${kind}`),
  shared: () => request<{ shared: SharedConfig; preview: { id: number; name: string; hostname: string; uses: boolean }[] }>("GET", "/api/shared"),
  saveShared: (c: SharedConfig) => request<{ shared: SharedConfig; liveOn: string[] }>("PUT", "/api/shared", c),
  matchmaking: () => request<MatchmakingInfo>("GET", "/api/matchmaking"),
  saveMatchmaking: (settings: MatchmakingSettings, leetifyKey?: string | null) =>
    request<{ settings: MatchmakingSettings; site: MatchmakingInfo["site"]; leetifyKeyHint: string | null }>("PUT", "/api/matchmaking", {
      settings,
      ...(leetifyKey !== undefined ? { leetifyKey } : {}),
    }),
  mmSetRating: (steamId: string, rating: number | null) => request<{ ok: true }>("PUT", `/api/matchmaking/players/${steamId}/rating`, { rating }),
  mmRemove: (steamId: string) => request<{ ok: true }>("POST", `/api/matchmaking/players/${steamId}/remove`, {}),
  mmCancel: (id: number) => request<{ ok: true }>("POST", `/api/matchmaking/matches/${id}/cancel`, {}),
  backups: () => request<{ backups: BackupInfo[]; settings: BackupSettings; totalBytes: number }>("GET", "/api/backups"),
  backupServer: (id: number) => request<{ backup: BackupInfo }>("POST", `/api/servers/${id}/backups`, {}),
  backupPanel: () => request<{ backup: BackupInfo }>("POST", "/api/backups/panel", {}),
  deleteBackup: (id: string) => request<{ ok: true }>("DELETE", `/api/backups?id=${encodeURIComponent(id)}`),
  restoreBackup: (id: string) => request<{ safetyBackup: string; restarted: boolean }>("POST", "/api/backups/restore", { id }),
  saveBackupSettings: (s: BackupSettings) => request<{ settings: BackupSettings }>("PUT", "/api/backups/settings", s),
  backupDownloadUrl: (id: string) => `/api/backups/download?id=${encodeURIComponent(id)}`,
  notifications: () => request<{ discord: DiscordSettings; groups: Record<EventGroup, string> }>("GET", "/api/notifications"),
  saveNotifications: (body: { webhook?: string; events: Partial<Record<EventGroup, boolean>> }) => request<{ discord: DiscordSettings }>("PUT", "/api/notifications", body),
  testNotification: () => request<{ ok: true }>("POST", "/api/notifications/test", {}),
  monitor: () => request<MonitorOverview>("GET", "/api/monitor"),
  metrics: (scope: "machine" | number, range: MetricRange) => request<MetricSeries>("GET", `/api/metrics?scope=${scope}&range=${range}`),
  alerts: (all = false) => request<{ alerts: PanelAlert[] }>("GET", `/api/alerts${all ? "?all=1" : ""}`),
  installedMaps: () => request<{ maps: string[] }>("GET", "/api/maps"),
  presets: () => request<{ presets: Preset[] }>("GET", "/api/presets"),
  createPreset: (p: PresetInput) => request<{ preset: Preset }>("POST", "/api/presets", p),
  updatePreset: (id: number, p: PresetInput) => request<{ preset: Preset }>("PUT", `/api/presets/${id}`, p),
  deletePreset: (id: number) => request<{ serversUsing: number }>("DELETE", `/api/presets/${id}`),
  saveAsPreset: (serverId: number, name: string, description: string) => request<{ preset: Preset }>("POST", `/api/servers/${serverId}/save-preset`, { name, description }),
  setExecConfigs: (serverId: number, configs: string[]) => request<{ execConfigs: string[] }>("PUT", `/api/servers/${serverId}/exec-configs`, { configs }),
  checkPort: (port: number, serverId?: number) =>
    request<{ problem: string | null }>("GET", `/api/ports/check?${q({ port, serverId })}`),

  servers: () => request<{ servers: Server[] }>("GET", "/api/servers"),
  server: (id: number) => request<ServerDetail>("GET", `/api/servers/${id}`),
  createServer: (input: Record<string, unknown>) => request<{ server: Server }>("POST", "/api/servers", input),
  updateServer: (id: number, input: Record<string, unknown>) =>
    request<{ server: Server; restartRequired: boolean }>("PATCH", `/api/servers/${id}`, input),
  duplicateServer: (id: number, input: Record<string, unknown>) =>
    request<{ server: Server }>("POST", `/api/servers/${id}/duplicate`, input),
  deleteServer: (id: number, confirm: string) => request<{ ok: true }>("DELETE", `/api/servers/${id}`, { confirm }),
  control: (id: number, action: "start" | "stop" | "restart" | "kill") => request<{ server: Server }>("POST", `/api/servers/${id}/${action}`, {}),
  rcon: (id: number, command: string) => request<{ output: string }>("POST", `/api/servers/${id}/rcon`, { command }),

  configs: (id: number) => request<{ files: ConfigFileInfo[] }>("GET", `/api/servers/${id}/configs`),
  config: (id: number, path: string) => request<ConfigFile>("GET", `/api/servers/${id}/configs/file?${q({ path })}`),
  saveConfig: (id: number, body: { path: string; content: string; comment?: string; apply: "save" | "exec" | "restart" }) =>
    request<{ changed: boolean; applied: string; file: ConfigFile }>("PUT", `/api/servers/${id}/configs/file`, body),
  revertConfig: (id: number, path: string) =>
    request<{ result: "stock" | "deleted" }>("DELETE", `/api/servers/${id}/configs/file?${q({ path })}`),
  revision: (id: number, revId: number) =>
    request<{ path: string; content: string | null }>("GET", `/api/servers/${id}/configs/revisions/${revId}`),
  rollback: (id: number, revisionId: number) =>
    request<{ path: string; file: ConfigFile | null }>("POST", `/api/servers/${id}/configs/rollback`, { revisionId }),

  plugins: (id: number, refresh = false) =>
    request<{ plugins: PluginStatus[]; databaseConfigured: boolean; warnings: string[] }>("GET", `/api/servers/${id}/plugins${refresh ? "?refresh=true" : ""}`),
  catalog: () => request<{ plugins: CatalogPlugin[] }>("GET", "/api/plugins/catalog"),
  pluginVersions: (pluginId: string) =>
    request<{ versions: { version: string; publishedAt: string | null; prerelease: boolean }[] }>("GET", `/api/plugins/${encodeURIComponent(pluginId)}/versions`),
  installPlugin: (id: number, pluginId: string, version?: string) =>
    request<{ installed: { id: string; version: string }[]; restarted: boolean }>(
      "POST",
      `/api/servers/${id}/plugins/${encodeURIComponent(pluginId)}/install`,
      version ? { version } : {},
    ),
  rollbackPlugin: (id: number, pluginId: string) =>
    request<{ version: string; restarted: boolean }>("POST", `/api/servers/${id}/plugins/${encodeURIComponent(pluginId)}/rollback`, {}),
  removePlugin: (id: number, pluginId: string) =>
    request<{ restarted: boolean }>("DELETE", `/api/servers/${id}/plugins/${encodeURIComponent(pluginId)}`),
  uploadPlugin: async (id: number, file: File) => {
    const res = await fetch(`/api/servers/${id}/plugins/upload?${q({ name: file.name })}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
      credentials: "same-origin",
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; name?: string; restarted?: boolean };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status}).`);
    return data as { name: string; restarted: boolean };
  },
  pluginHealth: (id: number) => request<PluginHealth>("GET", `/api/servers/${id}/plugins/health`),

  players: (id: number) => request<{ running: boolean; players: OnlinePlayer[]; error: string | null }>("GET", `/api/servers/${id}/players`),
  kick: (id: number, userId: number, reason: string) => request<{ ok: true }>("POST", `/api/servers/${id}/players/${userId}/kick`, { reason }),
  recentPlayers: (serverId?: number) => request<{ players: RecentPlayer[] }>("GET", `/api/players/recent?${q({ serverId })}`),
  panelBans: (all: boolean) => request<{ bans: PanelBan[] }>("GET", `/api/bans${all ? "?all=1" : ""}`),
  banCoverage: () => request<BanCoverage>("GET", "/api/bans/coverage"),
  panelBan: (body: { serverId?: number; userId?: number; steam?: string; name?: string; minutes: number; reason: string }) =>
    request<{ ban: PanelBan; coverage: BanCoverage }>("POST", "/api/bans", body),
  panelUnban: (banId: number, reason = "") => request<{ ok: true }>("POST", `/api/bans/${banId}/unban`, { reason }),

  // A moderation plugin's own bans and admins (CS2-SimpleAdmin), shown on its tab.
  moderation: (id: number) => request<ModerationInfo>("GET", `/api/servers/${id}/moderation`),
  bans: (id: number, all: boolean) => request<{ bans: Ban[] }>("GET", `/api/servers/${id}/moderation/bans${all ? "?all=true" : ""}`),
  ban: (id: number, body: { userId?: number; steam?: string; minutes: number; reason: string }) =>
    request<{ ok: true }>("POST", `/api/servers/${id}/moderation/bans`, body),
  unban: (id: number, steamId: string, reason = "") => request<{ ok: true }>("POST", `/api/servers/${id}/moderation/bans/unban`, { steamId, reason }),
  mapMenu: (id: number) => request<{ menu: (MapMenu & { file: string }) | null; installed: string[] }>("GET", `/api/servers/${id}/moderation/maps`),
  saveMapMenu: (id: number, menu: MapMenu) => request<{ changed: boolean; menu: MapMenu }>("PUT", `/api/servers/${id}/moderation/maps`, menu),
  gameAdmins: (id: number) => request<{ admins: GameAdmin[] }>("GET", `/api/servers/${id}/moderation/admins`),
  addGameAdmin: (id: number, body: { steam: string; name: string; flags: string; immunity: number; minutes: number }) =>
    request<{ ok: true }>("POST", `/api/servers/${id}/moderation/admins`, body),
  removeGameAdmin: (id: number, steamId: string) => request<{ ok: true }>("DELETE", `/api/servers/${id}/moderation/admins/${steamId}`),

  game: (since = 0) => request<GameState>("GET", `/api/game?${q({ since })}`),
  startUpdate: (validate: boolean, warnSeconds: number) => request<{ ok: true }>("POST", "/api/game/update", { validate, warnSeconds }),
  saveAutoUpdate: (settings: UpdateSettings) => request<{ auto: AutoUpdateStatus }>("PUT", "/api/game/auto", settings),
  checkForUpdate: () => request<{ auto: AutoUpdateStatus }>("POST", "/api/game/check", {}),
  schedule: (id: number) => request<ScheduleView>("GET", `/api/servers/${id}/schedule`),
  saveSchedule: (id: number, schedule: RestartSchedule) => request<ScheduleView>("PUT", `/api/servers/${id}/schedule`, schedule),
};

export const GAME_MODE_NAMES: Record<string, string> = {
  "0/0": "Casual",
  "0/1": "Competitive",
  "0/2": "Wingman",
  "1/0": "Arms Race",
  "1/1": "Demolition",
  "1/2": "Deathmatch",
};

export function modeName(s: { gameType: number; gameMode: number; presetName?: string | null }): string {
  return s.presetName ?? GAME_MODE_NAMES[`${s.gameType}/${s.gameMode}`] ?? `Type ${s.gameType} / mode ${s.gameMode}`;
}

/** SQLite timestamps are UTC without a zone marker. */
export function parseTime(t: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z");
}

export function timeAgo(t: string | null): string {
  if (!t) return "never";
  const s = Math.round((Date.now() - parseTime(t).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return formatDate(parseTime(t));
}

export function uptime(since: string | null): string {
  if (!since) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  if (s < 60) return "under a minute";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** Full date and time in the user's format, for tooltips and logs. */
export function fullTime(t: string | null): string {
  return t ? formatDateTime(parseTime(t)) : "";
}
