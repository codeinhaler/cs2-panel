import type { AuditEvent } from "../audit.js";
import type { SecretBox } from "../crypto.js";
import type { Db } from "../db.js";
import { badRequest } from "../errors.js";
import type { Settings } from "../settings.js";

/** Groups of events someone can switch on or off. */
export const EVENT_GROUPS = {
  problems: "Problems: crashes, servers not answering, high CPU or memory, a full disk, failed updates or restarts",
  updates: "CS2 updates: found, started and finished",
  restarts: "Scheduled restarts",
  moderation: "Kicks, bans and unbans",
  servers: "Servers started, stopped or restarted by someone",
} as const;
export type EventGroup = keyof typeof EVENT_GROUPS;

export interface DiscordSettings {
  webhookSet: boolean;
  /** Last characters of the webhook, so you can tell which one it is. */
  webhookHint: string | null;
  events: Record<EventGroup, boolean>;
}

interface Stored {
  webhook: string | null; // sealed
  events: Partial<Record<EventGroup, boolean>>;
}

const DEFAULT_EVENTS: Record<EventGroup, boolean> = { problems: true, updates: true, restarts: false, moderation: true, servers: false };
const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

// Status colours: problem, resolved/success, information, moderation.
const RED = 0xd64541;
const GREEN = 0x2e9e5b;
const BLUE = 0x2a78d6;
const ORANGE = 0xe08a1e;

interface Embed {
  title: string;
  description?: string;
  color: number;
  footer?: { text: string };
  timestamp: string;
}

/** Turns an Activity entry into a Discord message, if it's one people may want to hear about. */
export function describeEvent(e: AuditEvent, names: { user: string | null; server: string | null }): { group: EventGroup; embed: Omit<Embed, "timestamp"> } | null {
  const d = e.details;
  const str = (k: string) => (d[k] === undefined || d[k] === null ? "" : String(d[k]));
  const who = names.user ?? "Someone";
  const server = names.server;
  const footer = server ? { text: server } : undefined;
  switch (e.action) {
    case "alert.raised":
      return { group: "problems", embed: { title: "⚠ Warning", description: str("message"), color: RED, footer } };
    case "alert.cleared":
      return { group: "problems", embed: { title: "✓ Back to normal", description: `Cleared: ${str("message")}`, color: GREEN, footer } };
    case "server.crashed":
      return { group: "problems", embed: { title: `💥 ${server ?? "A server"} crashed`, description: "systemd restarted it automatically.", color: RED, footer } };
    case "server.restart.failed":
      return { group: "problems", embed: { title: `Couldn't restart ${server ?? "a server"}`, description: `${str("trigger")}: ${str("error")}`, color: RED, footer } };
    case "game.update.available":
      return { group: "updates", embed: { title: "A CS2 update is out", description: `Build ${str("latest")} (installed: ${str("installed")}).`, color: BLUE } };
    case "game.update.start":
      return {
        group: "updates",
        embed: { title: "Updating CS2", description: d.trigger ? `Started automatically: ${str("trigger")}. Servers restart when it's done.` : `${who} started it. Servers restart when it's done.`, color: BLUE },
      };
    case "game.update.finish":
      return d.result === "succeeded"
        ? { group: "updates", embed: { title: "✓ CS2 updated", description: "Running servers have been started again.", color: GREEN } }
        : { group: "problems", embed: { title: "CS2 update failed", description: str("error") || "See the Game update page.", color: RED } };
    case "server.restart":
      if (d.trigger) return { group: "restarts", embed: { title: `${server ?? "A server"} restarted`, description: `Reason: ${str("trigger")}.`, color: BLUE, footer } };
      return { group: "servers", embed: { title: `${server ?? "A server"} restarted`, description: `By ${who}.`, color: BLUE, footer } };
    case "server.start":
    case "server.stop":
    case "server.kill":
      return {
        group: "servers",
        embed: { title: `${server ?? "A server"} ${e.action === "server.start" ? "started" : e.action === "server.kill" ? "force-stopped" : "stopped"}`, description: `By ${who}.`, color: BLUE, footer },
      };
    case "player.kick":
      return { group: "moderation", embed: { title: `${str("name") || "A player"} was kicked`, description: `By ${who}${d.reason ? `: ${str("reason")}` : "."}`, color: ORANGE, footer } };
    case "player.ban": {
      const minutes = Number(d.minutes);
      const length = minutes === 0 ? "permanently" : minutes % 1440 === 0 ? `for ${minutes / 1440} day${minutes === 1440 ? "" : "s"}` : `for ${minutes} minutes`;
      return {
        group: "moderation",
        embed: { title: `${str("name") || str("steamId") || "A player"} was banned ${length}`, description: `By ${who}: ${str("reason")}`, color: ORANGE, footer },
      };
    }
    case "player.unban":
      return { group: "moderation", embed: { title: `${str("name") || str("steamId") || "A player"} was unbanned`, description: `By ${who}${d.reason ? `: ${str("reason")}` : "."}`, color: GREEN, footer } };
    default:
      return null;
  }
}

/** Sends chosen Activity events to a Discord channel through a webhook. */
export class DiscordNotifier {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly box: SecretBox,
    private readonly fetchFn: typeof fetch,
  ) {}

  private stored(): Stored {
    return { webhook: null, events: {}, ...this.settings.get<Partial<Stored>>("discord", {}) };
  }

  private webhook(): string | null {
    const s = this.stored().webhook;
    if (!s) return null;
    try {
      return this.box.open(s);
    } catch {
      return null;
    }
  }

  view(): DiscordSettings {
    const url = this.webhook();
    return { webhookSet: !!url, webhookHint: url ? `…${url.slice(-6)}` : null, events: { ...DEFAULT_EVENTS, ...this.stored().events } };
  }

  /** webhook: undefined keeps it, "" removes it. */
  set(input: { webhook?: string; events: Partial<Record<EventGroup, boolean>> }): DiscordSettings {
    const cur = this.stored();
    let webhook = cur.webhook;
    if (input.webhook !== undefined) {
      const w = input.webhook.trim();
      if (w && !WEBHOOK_RE.test(w)) throw badRequest("That doesn't look like a Discord webhook link (https://discord.com/api/webhooks/…).");
      webhook = w ? this.box.seal(w) : null;
    }
    const events: Partial<Record<EventGroup, boolean>> = {};
    for (const k of Object.keys(EVENT_GROUPS) as EventGroup[]) events[k] = input.events[k] ?? cur.events[k] ?? DEFAULT_EVENTS[k];
    this.settings.set("discord", { webhook, events });
    return this.view();
  }

  /** Activity listener. */
  onEvent = (e: AuditEvent): void => {
    const url = this.webhook();
    if (!url) return;
    const names = this.names(e);
    const msg = describeEvent(e, names);
    if (!msg || !this.view().events[msg.group]) return;
    this.enqueue(url, { ...msg.embed, timestamp: new Date().toISOString() });
  };

  /** Sends a test message and reports whether Discord took it. */
  async test(): Promise<void> {
    const url = this.webhook();
    if (!url) throw badRequest("Save a webhook link first.");
    const res = await this.post(url, { title: "✓ CS2 Panel is connected", description: "Notifications from the panel will show up in this channel.", color: GREEN, timestamp: new Date().toISOString() });
    if (!res.ok) throw badRequest(`Discord refused the message (${res.status}). Check that the webhook still exists.`);
  }

  /** Waits for queued messages (tests). */
  flush(): Promise<void> {
    return this.queue;
  }

  private names(e: AuditEvent): { user: string | null; server: string | null } {
    const user = e.userId
      ? ((this.db.prepare("SELECT COALESCE(display_name, steam_id) AS n FROM users WHERE id = ?").get(e.userId) as { n: string } | undefined)?.n ?? null)
      : null;
    const server = e.serverId ? ((this.db.prepare("SELECT name FROM servers WHERE id = ?").get(e.serverId) as { name: string } | undefined)?.name ?? null) : null;
    return { user, server };
  }

  /** One message at a time, so Discord's rate limit isn't hit by a burst. */
  private enqueue(url: string, embed: Embed): void {
    this.queue = this.queue.then(async () => {
      try {
        const res = await this.post(url, embed);
        if (res.status === 429) {
          const wait = Math.min(10, Number((await res.json().catch(() => ({}))).retry_after ?? 1));
          await new Promise((r) => setTimeout(r, wait * 1000));
          await this.post(url, embed);
        }
      } catch {
        /* Discord unreachable; the event is still in Activity */
      }
    });
  }

  private post(url: string, embed: Embed): Promise<Response> {
    return this.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "CS2 Panel", embeds: [embed], allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}
