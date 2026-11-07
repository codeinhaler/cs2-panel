import type { Monitor } from "../monitor/monitor.js";
import type { RestartScheduler } from "./restarts.js";
import type { UpdateWatcher } from "./updates.js";

/** Runs the automatic jobs once a minute, even when nobody has the panel open. */
export class Automation {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    readonly updates: UpdateWatcher,
    readonly restarts: RestartScheduler,
    readonly monitor: Monitor | null = null,
  ) {}

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // The monitor runs alongside, so slow server queries never delay updates or restarts.
      const sampling = this.monitor?.sample(now.getTime()).catch(() => undefined);
      // Updates first: an update restarts every server anyway.
      await this.updates.tick(now).catch(() => undefined);
      await this.restarts.tick(now).catch(() => undefined);
      await sampling;
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
