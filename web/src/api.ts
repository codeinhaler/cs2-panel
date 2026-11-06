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
  | "users.manage";

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
}

export interface HostInfo {
  cpuCount: number;
  suggestedCpu: number;
  usedPorts: { serverId: number; name: string; port: number }[];
  cs2: { installed: boolean; patchVersion: string | null; buildId: string | null };
  busy: string | null;
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

export interface GameState {
  cs2: { installed: boolean; patchVersion: string | null; buildId: string | null };
  job: { state: "idle" | "running" | "succeeded" | "failed"; startedAt: string | null; finishedAt: string | null };
  lines: string[];
  next: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
  presets: () => request<{ presets: Preset[] }>("GET", "/api/presets"),
  checkPort: (port: number, serverId?: number) =>
    request<{ problem: string | null }>("GET", `/api/ports/check?${q({ port, serverId })}`),

  servers: () => request<{ servers: Server[] }>("GET", "/api/servers"),
  server: (id: number) => request<{ server: Server }>("GET", `/api/servers/${id}`),
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

  game: (since = 0) => request<GameState>("GET", `/api/game?${q({ since })}`),
  startUpdate: (validate: boolean, warnSeconds: number) => request<{ ok: true }>("POST", "/api/game/update", { validate, warnSeconds }),
};

export const GAME_MODE_NAMES: Record<string, string> = {
  "0/0": "Casual",
  "0/1": "Competitive",
  "0/2": "Wingman",
  "1/0": "Arms Race",
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
