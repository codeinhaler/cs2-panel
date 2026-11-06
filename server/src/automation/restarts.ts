import type { AuditLog } from "../audit.js";
import type { Db } from "../db.js";
import { badRequest } from "../errors.js";
import type { GameUpdater } from "../game/updater.js";
import type { RconExec } from "../game/rcon.js";
import type { Host } from "../host/host.js";
import type { OperationGate, ServerService } from "../servers/service.js";
import type { ServerRecord } from "../servers/store.js";
import type { Settings } from "../settings.js";
import type { HumanCounter } from "./humans.js";

export interface RestartSchedule {
  /** Daily restart time in the panel host's local time, "HH:MM"; null = no scheduled restart. */
  restartAt: string | null;
  /** With players online at that time: wait for the server to empty (up to maxWaitMinutes), or warn and restart. */
  ifPlayers: "wait" | "restart";
  maxWaitMinutes: number;
}

export const DEFAULT_SCHEDULE: RestartSchedule = { restartAt: null, ifPlayers: "wait", maxWaitMinutes: 120 };

export interface ScheduleView {
  schedule: RestartSchedule;
  /** Next planned restart (ISO), or null. */
  nextAt: string | null;
  /** Set while a restart is due but waiting for players to leave. */
  waitingSince: string | null;
  /** Latest time it restarts anyway while waiting. */
  deadline: string | null;
  timezone: string;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** If the panel was down past this point after a slot (plus any waiting time), the slot is skipped rather than caught up. */
const GRACE_MINUTES = 15;
const WARN_SECONDS = 60;

/** Daily restarts per server, optionally waiting until nobody's playing. */
export class RestartScheduler {
  private readonly busy = new Set<number>();
  /** Last slot handled per server (ISO), so each day's restart happens once. */
  private handled: Record<string, string>;

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly servers: ServerService,
    private readonly host: Host,
    private readonly gate: OperationGate,
    private readonly updater: GameUpdater,
    private readonly humans: HumanCounter,
    private readonly rcon: RconExec,
    private readonly audit: AuditLog,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.handled = settings.get<Record<string, string>>("restart.handled", {});
  }

  get(serverId: number): RestartSchedule {
    const row = this.db.prepare("SELECT schedule FROM servers WHERE id = ?").get(serverId) as { schedule: string } | undefined;
    let raw: Partial<RestartSchedule> = {};
    try {
      raw = JSON.parse(row?.schedule ?? "{}") as Partial<RestartSchedule>;
    } catch {
      /* treat as unset */
    }
    return { ...DEFAULT_SCHEDULE, ...raw };
  }

  set(serverId: number, next: RestartSchedule, actorId: number, now = new Date()): RestartSchedule {
    const restartAt = next.restartAt?.trim() || null;
    if (restartAt && !TIME_RE.test(restartAt)) throw badRequest("Enter the time as HH:MM, like 06:00.");
    if (next.ifPlayers !== "wait" && next.ifPlayers !== "restart") throw badRequest("Pick what happens when players are on.");
    const maxWaitMinutes = Math.round(next.maxWaitMinutes);
    if (!(maxWaitMinutes >= 5 && maxWaitMinutes <= 720)) throw badRequest("The longest wait must be between 5 minutes and 12 hours.");
    const clean: RestartSchedule = { restartAt, ifPlayers: next.ifPlayers, maxWaitMinutes };
    this.db.prepare("UPDATE servers SET schedule = ? WHERE id = ?").run(JSON.stringify(clean), serverId);
    // A time set for later today should still happen today, but one already passed shouldn't fire right away.
    this.markHandled(serverId, lastSlot(clean.restartAt, now));
    this.audit.record(actorId, "server.schedule", serverId, { ...clean });
    return clean;
  }

  view(serverId: number, now = new Date()): ScheduleView {
    const schedule = this.get(serverId);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!schedule.restartAt) return { schedule, nextAt: null, waitingSince: null, deadline: null, timezone };
    const slot = lastSlot(schedule.restartAt, now);
    const pending = slot && this.handled[serverId] !== slot.toISOString() && this.withinWindow(schedule, slot, now);
    if (pending && this.waiting.has(serverId)) {
      return {
        schedule,
        nextAt: slot.toISOString(),
        waitingSince: slot.toISOString(),
        deadline: new Date(slot.getTime() + schedule.maxWaitMinutes * 60_000).toISOString(),
        timezone,
      };
    }
    return { schedule, nextAt: nextSlot(schedule.restartAt, now).toISOString(), waitingSince: null, deadline: null, timezone };
  }

  /** Servers whose restart is due but are waiting for players to leave. */
  private readonly waiting = new Set<number>();

  private withinWindow(s: RestartSchedule, slot: Date, now: Date): boolean {
    const wait = s.ifPlayers === "wait" ? s.maxWaitMinutes : 0;
    return now.getTime() - slot.getTime() <= (wait + GRACE_MINUTES) * 60_000;
  }

  private markHandled(serverId: number, slot: Date | null): void {
    if (slot) this.handled[serverId] = slot.toISOString();
    else delete this.handled[serverId];
    this.waiting.delete(serverId);
    this.settings.set("restart.handled", this.handled);
  }

  /** Called every minute by the scheduler. Restarts run in the background. */
  async tick(now = new Date()): Promise<void> {
    for (const s of this.servers.listRecords()) {
      const schedule = this.get(s.id);
      if (!schedule.restartAt || this.busy.has(s.id)) continue;
      const slot = lastSlot(schedule.restartAt, now);
      if (!slot || this.handled[s.id] === slot.toISOString()) continue;
      if (this.handled[s.id] && Date.parse(this.handled[s.id]!) > slot.getTime()) continue;

      if (!this.withinWindow(schedule, slot, now)) {
        this.markHandled(s.id, slot); // missed (panel was down); wait for the next one
        continue;
      }
      const st = await this.host.serviceStatus(s.slug);
      if (st.state !== "active") {
        this.markHandled(s.id, slot); // nothing to restart
        continue;
      }
      if (this.gate.busy || this.updater.job.state === "running") continue; // try again next minute

      const humans = await this.humans(s.id);
      const overdue = now.getTime() - slot.getTime() >= schedule.maxWaitMinutes * 60_000;
      if (humans !== 0 && schedule.ifPlayers === "wait" && !overdue) {
        this.waiting.add(s.id);
        continue;
      }
      this.markHandled(s.id, slot);
      const reason =
        humans !== 0 && schedule.ifPlayers === "wait" ? `scheduled restart, players still on after waiting ${schedule.maxWaitMinutes} minutes` : "scheduled restart";
      void this.restart(s, humans === 0 ? 0 : WARN_SECONDS, reason);
    }
  }

  private async restart(s: ServerRecord, warnSeconds: number, reason: string): Promise<void> {
    this.busy.add(s.id);
    try {
      if (warnSeconds > 0) {
        await this.say(s, `Scheduled server restart in ${warnSeconds} seconds.`);
        await this.sleep((warnSeconds - 10) * 1000);
        await this.say(s, "Scheduled server restart in 10 seconds.");
        await this.sleep(10_000);
      }
      await this.servers.control(s.id, "restart", { id: null }, { trigger: reason });
    } catch (e) {
      this.audit.record(null, "server.restart.failed", s.id, { trigger: reason, error: (e as Error).message });
    } finally {
      this.busy.delete(s.id);
    }
  }

  private async say(s: ServerRecord, text: string): Promise<void> {
    try {
      await this.rcon({ port: s.port, password: s.rconPassword, timeoutMs: 3000 }, `say ${text}`);
    } catch {
      /* the restart goes ahead anyway */
    }
  }
}

/** The most recent time HH:MM (local) at or before now. */
export function lastSlot(hhmm: string | null, now: Date): Date | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
  return d;
}

/** The next time HH:MM (local) after now. */
export function nextSlot(hhmm: string, now: Date): Date {
  const d = lastSlot(hhmm, now)!;
  d.setDate(d.getDate() + 1);
  return d;
}
