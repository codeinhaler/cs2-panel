// Discord's REST API, the official one (https://discord.com/developers/docs). Moving members, reading voice
// states and managing channels need no Gateway connection, so the panel talks to Discord with plain fetch.

export const DISCORD_API = "https://discord.com/api/v10";

/** Guild permission bits the bot uses (https://discord.com/developers/docs/topics/permissions). */
export const PERM = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  VIEW_CHANNEL: 1n << 10n,
  CONNECT: 1n << 20n,
  MOVE_MEMBERS: 1n << 24n,
} as const;

/** What the invite asks for: no Administrator. Manage Channels only matters for temporary channels. */
export const BOT_PERMISSIONS = PERM.VIEW_CHANNEL | PERM.CONNECT | PERM.MOVE_MEMBERS | PERM.MANAGE_CHANNELS;

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

export interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  parent_id?: string | null;
  guild_id?: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface VoiceState {
  channel_id: string | null;
  user_id: string;
}

const UA = "DiscordBot (https://github.com/codeinhaler/cs2-panel, 1)";

/**
 * One request at a time, in order, waiting out rate limits: Discord's 429 replies (retry_after) and an
 * exhausted bucket (X-RateLimit-Remaining: 0). Plenty for a few matches at once.
 */
export class DiscordRest {
  private chain: Promise<unknown> = Promise.resolve();
  private pauseUntil = 0;

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly token: () => string | null,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  request<T>(method: string, path: string, body?: unknown, reason?: string): Promise<T> {
    const run = () => this.send<T>(method, path, body, reason);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async send<T>(method: string, path: string, body: unknown, reason?: string): Promise<T> {
    const token = this.token();
    if (!token) throw new DiscordError(0, null, "The bot token isn't set.");
    for (let attempt = 0; ; attempt++) {
      const wait = this.pauseUntil - this.now();
      if (wait > 0) await this.sleep(wait);
      const res = await this.fetchFn(DISCORD_API + path, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          "User-Agent": UA,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(reason ? { "X-Audit-Log-Reason": encodeURIComponent(reason) } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        const after = Number(res.headers.get("x-ratelimit-reset-after") ?? "0");
        if (after > 0) this.pauseUntil = this.now() + after * 1000;
      }
      if (res.status === 429 && attempt < 4) {
        const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await this.sleep(Math.min(Math.max((j.retry_after ?? 1) * 1000, 100), 30_000));
        continue;
      }
      if (res.status === 204) return null as T;
      const json = (await res.json().catch(() => null)) as (T & { code?: number; message?: string }) | null;
      if (!res.ok) throw new DiscordError(res.status, json?.code ?? null, json?.message ?? `Discord answered ${res.status}`);
      return json as T;
    }
  }

  me = () => this.request<DiscordUser>("GET", "/users/@me");
  guild = (g: string) => this.request<{ id: string; name: string; owner_id: string }>("GET", `/guilds/${g}`);
  roles = (g: string) => this.request<{ id: string; permissions: string }[]>("GET", `/guilds/${g}/roles`);
  member = (g: string, u: string) => this.request<{ roles: string[]; user?: DiscordUser }>("GET", `/guilds/${g}/members/${u}`);
  channels = (g: string) => this.request<DiscordChannel[]>("GET", `/guilds/${g}/channels`);

  /** Where a member is in voice, or null when they're not connected (Discord: Unknown Voice State). */
  async voiceState(g: string, u: string): Promise<VoiceState | null> {
    try {
      return await this.request<VoiceState>("GET", `/guilds/${g}/voice-states/${u}`);
    } catch (e) {
      if (e instanceof DiscordError && (e.status === 404 || e.code === 10065)) return null;
      throw e;
    }
  }

  createVoice = (g: string, body: { name: string; parent_id?: string; permission_overwrites?: unknown[] }, reason: string) =>
    this.request<DiscordChannel>("POST", `/guilds/${g}/channels`, { type: 2, ...body }, reason);
  move = (g: string, u: string, channelId: string, reason: string) =>
    this.request<unknown>("PATCH", `/guilds/${g}/members/${u}`, { channel_id: channelId }, reason);

  /** Lets one member see and join a private channel (e.g. a late joiner). */
  allowMember = (channelId: string, userId: string, reason: string) =>
    this.request<unknown>(
      "PUT",
      `/channels/${channelId}/permissions/${userId}`,
      { type: 1, allow: (PERM.VIEW_CHANNEL | PERM.CONNECT).toString(), deny: "0" },
      reason,
    );

  /** Deletes a channel; one that's already gone counts as deleted. */
  async deleteChannel(id: string, reason: string): Promise<void> {
    try {
      await this.request<unknown>("DELETE", `/channels/${id}`, undefined, reason);
    } catch (e) {
      if (e instanceof DiscordError && (e.status === 404 || e.code === 10003)) return;
      throw e;
    }
  }
}

/** The bot's guild-wide permissions: @everyone plus its roles; Administrator means everything. */
export function memberPermissions(guildId: string, roles: { id: string; permissions: string }[], memberRoles: string[]): bigint {
  let p = 0n;
  for (const r of roles) if (r.id === guildId || memberRoles.includes(r.id)) p |= BigInt(r.permissions);
  return p & PERM.ADMINISTRATOR ? ~0n : p;
}

/** When a snowflake ID was made (ms since 1970). */
export const snowflakeTime = (id: string) => Number((BigInt(id) >> 22n) + 1420070400000n);

/** A channel link (https://discord.com/channels/guild/channel) or a bare ID → the IDs. */
export function parseChannelRef(v: string): { guild: string | null; channel: string } | null {
  const t = v.trim();
  const link = /^https:\/\/(?:(?:ptb|canary)\.)?discord\.com\/channels\/(\d+)\/(\d+)\/?$/.exec(t);
  if (link) return { guild: link[1]!, channel: link[2]! };
  if (/^\d{15,22}$/.test(t)) return { guild: null, channel: t };
  return null;
}

// ------------------------------------------------------------- OAuth2 (players linking their account)

/** The authorize URL: only the identify scope, and a state tied to the player's session. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: "identify", state, prompt: "consent" });
  return `https://discord.com/oauth2/authorize?${q}`;
}

/** Trades the code for an access token, reads who it belongs to, and drops the token. */
export async function verifiedUser(
  fetchFn: typeof fetch,
  o: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<DiscordUser> {
  const tokenRes = await fetchFn(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: o.code,
      redirect_uri: o.redirectUri,
      client_id: o.clientId,
      client_secret: o.clientSecret,
    }),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!tokenRes.ok || !tok.access_token) throw new Error(`Discord didn't accept the sign-in (${tok.error_description ?? tokenRes.status}).`);
  const meRes = await fetchFn(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": UA } });
  const me = (await meRes.json().catch(() => null)) as DiscordUser | null;
  if (!meRes.ok || !me?.id) throw new Error("Couldn't read your Discord account.");
  return { id: me.id, username: me.username, global_name: me.global_name ?? null };
}
