// Client for the matchmaking site's API (the public site, not the panel).

export type RatingSource = "admin" | "leetify" | "self" | "none" | "bot";
export type Mode = "competitive" | "wingman" | "duel";

export interface Rating {
  value: number | null;
  source: RatingSource;
  note: string | null;
  pending?: boolean;
}

export interface Member {
  steamId: string;
  name: string;
  avatarUrl: string | null;
  rating: Rating;
  effective: number;
}

export interface LobbyPlayer {
  steamId: string;
  name: string;
  avatarUrl: string | null;
  rating: Rating;
  leetifyUrl: string;
  status: "ready" | "away" | "in-match";
  sitOuts: number;
  mode: Mode;
}

export interface Teams {
  teamA: Member[];
  teamB: Member[];
  sumA: number;
  sumB: number;
  avgA: number;
  avgB: number;
  gap: number;
}

export interface Draft extends Teams {
  id: number;
  mode: Mode;
  option: number;
  options: number;
}

export type TeamKey = "a" | "b";
export type Side = "ct" | "t";

export interface Match extends Teams {
  id: number;
  mode: Mode;
  modeLabel: string;
  phase: "veto" | "side" | "starting" | "live" | "over" | "cancelled" | "abandoned";
  captainA: string;
  captainB: string;
  pool: string[];
  bans: { map: string; by: TeamKey; auto: boolean }[];
  remaining: string[];
  turn: TeamKey | null;
  deadline: number | null;
  map: string | null;
  sideA: Side | null;
  sidePicker: TeamKey | null;
  serverName: string | null;
  status: string;
  error: string | null;
  connected: number;
  expected: number;
  warmup: boolean;
  score: { a: number; b: number } | null;
  createdAt: number;
  endedAt: number | null;
  joinInfo: { address: string; password: string; steamUrl: string; console: string } | null;
  lateJoins: { open: boolean; votes: { a: boolean; b: boolean } };
  bots: { team: TeamKey; on: boolean; votes: { a: boolean; b: boolean } } | null;
  discord: { channel: string; invite: string | null } | null;
  canJoin: { team: TeamKey | null; reason: string | null } | null;
}

export interface State {
  title: string;
  enabled: boolean;
  me: {
    steamId: string;
    name: string;
    avatarUrl: string | null;
    rating: Rating;
    selfRating: number | null;
    inLobby: boolean;
    mode: Mode | null;
    ready: boolean;
    leetifyUrl: string;
  } | null;
  lobbies: { mode: Mode; label: string; teamSize: number; maps: string[]; players: number; ready: number; freeServers: number; matchServers: number }[];
  lobby: LobbyPlayer[];
  drafts: Draft[];
  matches: Match[];
  look: { icon: string | null; banner: string | null };
  mapNames: Record<string, string>;
  casual: {
    name: string;
    servers: {
      id: number;
      name: string;
      map: string | null;
      players: number;
      maxPlayers: number;
      online: boolean;
      joinInfo: { address: string; password: string; steamUrl: string; console: string };
      /** Its voice channel: its own, or the casual servers' shared one. */
      discord?: { channel: string; invite: string | null } | null;
    }[];
    discord: { channel: string; invite: string | null } | null;
  };
  freeServers: number;
  serverStates: { name: string; state: string; label: string }[];
  matchServers: number;
  now: number;
}

/** In development the page is served by Vite, which forwards /mm-api to the public site's port. */
export const API = import.meta.env.DEV ? "/mm-api" : "/api";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface DiscordMe {
  /** The site can link Discord accounts (the organiser set it up). */
  available: boolean;
  /** The bot moves players (otherwise linking only shows your name). */
  botOn: boolean;
  linked: { username: string } | null;
  autoMove: boolean;
  autoReturn: boolean;
}

export const play = {
  discord: () => request<DiscordMe>("GET", "/discord"),
  discordPrefs: (p: { autoMove: boolean; autoReturn: boolean }) => request<DiscordMe>("PUT", "/discord/prefs", p),
  discordUnlink: () => request<{ ok: true }>("POST", "/discord/unlink", {}),
  state: () => request<State>("GET", "/state"),
  logout: () => request<{ ok: true }>("POST", "/auth/logout", {}),
  join: (mode: Mode) => request<{ ok: true }>("POST", "/lobby/join", { mode }),
  leave: () => request<{ ok: true }>("POST", "/lobby/leave", {}),
  ready: (ready: boolean) => request<{ ok: true }>("POST", "/lobby/ready", { ready }),
  setRating: (rating: number | null) => request<{ ok: true }>("PUT", "/me/rating", { rating }),
  makeTeams: () => request<{ ok: true }>("POST", "/teams", {}),
  reshuffle: (id: number) => request<{ ok: true }>("POST", `/teams/${id}/reshuffle`, {}),
  cancelTeams: (id: number) => request<{ ok: true }>("POST", `/teams/${id}/cancel`, {}),
  startTeams: (id: number) => request<{ matchId: number }>("POST", `/teams/${id}/start`, {}),
  ban: (id: number, map: string) => request<{ ok: true }>("POST", `/matches/${id}/ban`, { map }),
  side: (id: number, side: Side) => request<{ ok: true }>("POST", `/matches/${id}/side`, { side }),
  joinMatch: (id: number) => request<{ team: TeamKey }>("POST", `/matches/${id}/join`, {}),
  bot: (id: number, allow: boolean) => request<{ ok: true }>("POST", `/matches/${id}/bot`, { allow }),
  lateJoins: (id: number, allow: boolean) => request<{ ok: true }>("POST", `/matches/${id}/late-joins`, { allow }),
  startNow: (id: number) => request<{ ok: true }>("POST", `/matches/${id}/start-now`, {}),
  cancelMatch: (id: number) => request<{ ok: true }>("POST", `/matches/${id}/cancel`, {}),
};

/** de_mirage → Mirage; a Workshop ID → Workshop 123. */
let workshopNames: Record<string, string> = {};
/** Steam's names for Workshop maps, from the latest state. */
export function setMapNames(names: Record<string, string>): void {
  workshopNames = names ?? {};
}

export function mapName(map: string): string {
  if (workshopNames[map]) return workshopNames[map];
  if (/^\d+$/.test(map) || /^workshop[:/]/i.test(map)) return `Workshop ${map.replace(/\D/g, "")}`;
  const bare = map.replace(/^(de|cs|ar)_/, "").replace(/_/g, " ");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

export const formatRating = (v: number | null) => (v === null ? "—" : v.toLocaleString("en"));

export const BOT_ID = "BOT";
/** "Up to 5v5", "2v2", or nothing for 1v1 (its name says it already). */
export const teamsLabel = (teamSize: number) => (teamSize === 1 ? "" : teamSize > 2 ? `up to ${teamSize}v${teamSize}` : `${teamSize}v${teamSize}`);
