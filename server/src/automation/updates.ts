import type { AuditLog } from "../audit.js";
import { badRequest } from "../errors.js";
import { latestPublicBuild } from "../game/steam-vdf.js";
import type { GameUpdater } from "../game/updater.js";
import type { Host } from "../host/host.js";
import type { InstanceFiles } from "../servers/instance-files.js";
import type { OperationGate } from "../servers/service.js";
import type { ServerStore } from "../servers/store.js";
import type { Settings } from "../settings.js";
import type { HumanCounter } from "./humans.js";

/**
 * - off: never look for updates on its own
 * - notify: look, and show that an update is available
 * - when-empty: update once no players are on, or after maxWaitMinutes at the latest
 * - now: update as soon as one is found (players get warnSeconds of warning)
 */
export type UpdatePolicy = "off" | "notify" | "when-empty" | "now";

export interface UpdateSettings {
  policy: UpdatePolicy;
  checkMinutes: number;
  maxWaitMinutes: number;
  warnSeconds: number;
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { policy: "notify", checkMinutes: 10, maxWaitMinutes: 60, warnSeconds: 60 };

interface CheckState {
  checkedAt: string | null;
  latestBuild: string | null;
  latestUpdatedAt: string | null;
  error: string | null;
  /** When we first saw that latestBuild was newer than the install. */
  pendingSince: string | null;
  /** Build we last tried to install automatically, and when (so a failing update isn't retried every minute). */
  lastAttemptBuild: string | null;
  lastAttemptAt: string | null;
}

export interface UpdateStatus extends CheckState {
  settings: UpdateSettings;
  installedBuild: string | null;
  updateAvailable: boolean;
  checking: boolean;
  /** For when-empty: the time the update happens even if players are still on. */
  deadline: string | null;
}

const EMPTY_STATE: CheckState = {
  checkedAt: null,
  latestBuild: null,
  latestUpdatedAt: null,
  error: null,
  pendingSince: null,
  lastAttemptBuild: null,
  lastAttemptAt: null,
};
const RETRY_FAILED_MINUTES = 30;

/** Watches Steam for new CS2 builds and runs the update according to the policy. */
export class UpdateWatcher {
  private checking: Promise<void> | null = null;
  private state: CheckState;

  constructor(
    private readonly settings: Settings,
    private readonly files: InstanceFiles,
    private readonly host: Host,
    private readonly updater: GameUpdater,
    private readonly gate: OperationGate,
    private readonly servers: ServerStore,
    private readonly humans: HumanCounter,
    private readonly audit: AuditLog,
  ) {
    this.state = { ...EMPTY_STATE, ...settings.get<Partial<CheckState>>("update.state", {}) };
  }

  config(): UpdateSettings {
    return { ...DEFAULT_UPDATE_SETTINGS, ...this.settings.get<Partial<UpdateSettings>>("update.settings", {}) };
  }

  setConfig(next: UpdateSettings, actorId: number): UpdateSettings {
    if (!["off", "notify", "when-empty", "now"].includes(next.policy)) throw badRequest("Unknown update policy.");
    const clean: UpdateSettings = {
      policy: next.policy,
      checkMinutes: clamp(next.checkMinutes, 5, 1440),
      maxWaitMinutes: clamp(next.maxWaitMinutes, 5, 1440),
      warnSeconds: clamp(next.warnSeconds, 0, 600),
    };
    this.settings.set("update.settings", clean);
    this.audit.record(actorId, "game.update.settings", null, { ...clean });
    return clean;
  }

  async status(): Promise<UpdateStatus> {
    const installedBuild = await this.files.baseBuildId();
    const settings = this.config();
    const updateAvailable = isNewer(this.state.latestBuild, installedBuild);
    const deadline =
      updateAvailable && settings.policy === "when-empty" && this.state.pendingSince
        ? new Date(Date.parse(this.state.pendingSince) + settings.maxWaitMinutes * 60_000).toISOString()
        : null;
    return { ...this.state, settings, installedBuild, updateAvailable, checking: this.checking !== null, deadline };
  }

  /** Asks Steam for the newest build. Concurrent calls share one check. */
  check(now = new Date()): Promise<void> {
    if (!this.checking) {
      this.checking = this.doCheck(now).finally(() => {
        this.checking = null;
      });
    }
    return this.checking;
  }

  private async doCheck(now: Date): Promise<void> {
    try {
      const latest = latestPublicBuild(await this.host.steamAppInfo());
      const installed = await this.files.baseBuildId();
      const wasKnown = this.state.latestBuild;
      this.state.latestBuild = latest.buildId;
      this.state.latestUpdatedAt = latest.updatedAt;
      this.state.error = null;
      if (isNewer(latest.buildId, installed)) {
        if (!this.state.pendingSince || wasKnown !== latest.buildId) {
          this.state.pendingSince = now.toISOString();
          this.audit.record(null, "game.update.available", null, { installed, latest: latest.buildId });
        }
      } else {
        this.state.pendingSince = null;
      }
    } catch (e) {
      this.state.error = (e as Error).message;
    }
    this.state.checkedAt = now.toISOString();
    this.save();
  }

  private save(): void {
    this.settings.set("update.state", this.state);
  }

  /** Called every minute by the scheduler. */
  async tick(now = new Date()): Promise<void> {
    const cfg = this.config();
    if (cfg.policy === "off" || this.updater.job.state === "running") return;

    const due = !this.state.checkedAt || now.getTime() - Date.parse(this.state.checkedAt) >= cfg.checkMinutes * 60_000;
    if (due) await this.check(now);

    if (cfg.policy === "notify") return;
    const installed = await this.files.baseBuildId();
    // Never install CS2 from scratch on its own; that's a deliberate first step.
    if (!installed || !isNewer(this.state.latestBuild, installed)) return;
    if (
      this.state.lastAttemptBuild === this.state.latestBuild &&
      this.state.lastAttemptAt &&
      now.getTime() - Date.parse(this.state.lastAttemptAt) < RETRY_FAILED_MINUTES * 60_000
    ) {
      return;
    }
    if (this.gate.busy) return; // something else is going on; try next minute

    let warnSeconds = cfg.warnSeconds;
    let reason = `new CS2 build ${this.state.latestBuild}`;
    if (cfg.policy === "when-empty") {
      const pendingSince = Date.parse(this.state.pendingSince ?? now.toISOString());
      const overdue = now.getTime() - pendingSince >= cfg.maxWaitMinutes * 60_000;
      if (await this.allEmpty()) {
        warnSeconds = 0;
        reason += ", no players online";
      } else if (overdue) {
        reason += `, waited ${cfg.maxWaitMinutes} minutes for the servers to empty`;
      } else {
        return;
      }
    }

    this.state.lastAttemptBuild = this.state.latestBuild;
    this.state.lastAttemptAt = now.toISOString();
    this.save();
    // Runs in the background; the Game update page shows its log.
    void this.updater.start({ validate: false, warnSeconds }, null, reason).then(() => {
      if (this.updater.job.state === "succeeded") this.state.pendingSince = null;
      this.save();
    });
  }

  /** True when no running server has a human player on it. A server we can't read counts as not empty. */
  private async allEmpty(): Promise<boolean> {
    for (const s of this.servers.list()) {
      const n = await this.humans(s.id);
      if (n === null || n > 0) return false;
    }
    return true;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));
}

/** Steam build IDs only go up. */
export function isNewer(latest: string | null, installed: string | null): boolean {
  if (!latest || !installed) return false;
  return BigInt(latest) > BigInt(installed);
}
