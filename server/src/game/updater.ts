import type { AuditLog } from "../audit.js";
import { conflict } from "../errors.js";
import type { Host } from "../host/host.js";
import type { InstanceFiles } from "../servers/instance-files.js";
import type { OperationGate } from "../servers/service.js";
import type { ServerRecord, ServerStore } from "../servers/store.js";
import type { RconExec } from "./rcon.js";

/** servers-down: the game files were updated, but a server that was running didn't come back up. */
export type JobState = "idle" | "running" | "succeeded" | "failed" | "servers-down";

export interface UpdateJob {
  state: JobState;
  startedAt: string | null;
  finishedAt: string | null;
  startedBy: number | null;
  /** Why it ran when nobody clicked: "automatic", or null for a manual update. */
  trigger: string | null;
  lines: string[];
  /** SteamCMD finished without an error (the files are the latest build). */
  filesUpdated?: boolean;
  /** Servers that were running before but didn't come back, and why. */
  down?: { name: string; reason: string }[];
}

interface RunResult {
  filesUpdated: boolean;
  down: { name: string; reason: string }[];
}

const MAX_LINES = 5000;

/**
 * Runs the CS2 update flow from DESIGN.md §7: warn players, stop and unmount
 * every server, update the shared base, regenerate gameinfo.gi, check for
 * stale files, and start the servers that were running.
 */
export class GameUpdater {
  job: UpdateJob = { state: "idle", startedAt: null, finishedAt: null, startedBy: null, trigger: null, lines: [] };
  /** Called with the servers that were started again; returns lines for the log (plugin health). */
  afterStart: ((started: ServerRecord[]) => Promise<string[]>) | null = null;
  pluginCheckDelayMs = 45_000;
  /**
   * After starting a server: how long it may take to come up, how often to look, and how long it must have
   * stayed up (same systemd start time on two looks in a row) to count. A crash loop keeps restarting, so it
   * never counts; a brief "active" between crashes isn't enough.
   */
  recoveryWindowMs = 120_000;
  recoveryPollMs = 5_000;
  recoveryStableMs = 20_000;

  constructor(
    private readonly host: Host,
    private readonly files: InstanceFiles,
    private readonly servers: ServerStore,
    private readonly audit: AuditLog,
    private readonly gate: OperationGate,
    private readonly rcon: RconExec,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  linesSince(index: number): { lines: string[]; next: number } {
    const from = Math.max(0, Math.min(index, this.job.lines.length));
    return { lines: this.job.lines.slice(from), next: this.job.lines.length };
  }

  /** Starts the update in the background. Throws if something else is running. */
  start(opts: { validate: boolean; warnSeconds: number }, userId: number | null, trigger: string | null = null): Promise<void> {
    this.gate.assertFree();
    if (this.job.state === "running") throw conflict("An update is already running.");
    this.gate.busy = "a CS2 update";
    this.job = { state: "running", startedAt: new Date().toISOString(), finishedAt: null, startedBy: userId, trigger, lines: [] };
    this.audit.record(userId, "game.update.start", null, { ...opts, ...(trigger ? { trigger } : {}) });
    if (trigger) this.log(`Started automatically: ${trigger}.`);
    return this.run(opts)
      .then((r) => {
        this.job.filesUpdated = r.filesUpdated;
        this.job.down = r.down;
        if (r.down.length) {
          const list = r.down.map((d) => `${d.name} (${d.reason})`).join(", ");
          this.log(
            `CS2 was updated, but these servers didn't come back up: ${list}. Check their Console tab; a plugin may need an update for the new CS2 version.`,
          );
          this.job.state = "servers-down";
          this.audit.record(userId, "game.update.finish", null, { result: "servers_down", filesUpdated: true, down: list });
        } else {
          this.job.state = "succeeded";
          this.audit.record(userId, "game.update.finish", null, { result: "succeeded" });
        }
      })
      .catch((err: Error & { down?: { name: string; reason: string }[] }) => {
        this.log(`ERROR: ${err.message}`);
        this.job.state = "failed";
        this.job.down = err.down ?? [];
        const down = this.job.down.map((d) => `${d.name} (${d.reason})`).join(", ");
        this.audit.record(userId, "game.update.finish", null, { result: "failed", error: err.message, ...(down ? { down } : {}) });
      })
      .finally(() => {
        this.job.finishedAt = new Date().toISOString();
        this.gate.busy = null;
      });
  }

  private log(line: string): void {
    this.job.lines.push(line);
    if (this.job.lines.length > MAX_LINES) this.job.lines.splice(0, this.job.lines.length - MAX_LINES);
  }

  private async run(opts: { validate: boolean; warnSeconds: number }): Promise<RunResult> {
    const servers = this.servers.list();
    const before = (await this.files.baseVersion()).patchVersion;
    this.log(`Installed CS2 version: ${before ?? "not installed"}`);

    const running: typeof servers = [];
    for (const s of servers) {
      const st = await this.host.serviceStatus(s.slug);
      if (st.state === "active" || st.state === "activating") running.push(s);
    }
    this.log(running.length ? `Running servers: ${running.map((s) => s.name).join(", ")}` : "No servers are running.");

    if (running.length && opts.warnSeconds > 0) {
      this.log(`Warning players, then waiting ${opts.warnSeconds} seconds…`);
      for (const s of running) {
        try {
          await this.rcon(
            { port: s.port, password: s.rconPassword, timeoutMs: 3000 },
            `say Server restarting in ${opts.warnSeconds} seconds for a CS2 update.`,
          );
        } catch (e) {
          this.log(`  could not warn ${s.name}: ${(e as Error).message}`);
        }
      }
      await this.sleep(opts.warnSeconds * 1000);
    }

    this.log("Stopping servers and unmounting overlays…");
    const touched: typeof servers = [];
    for (const s of servers) {
      touched.push(s);
      try {
        await this.host.cs2ctl("umount", s.slug);
        this.log(`  ${s.name}: stopped`);
      } catch (e) {
        // Don't update with a server half-stopped: put back the ones already stopped, then report.
        const msg = (e as Error).message;
        this.log(`  ${s.name}: ERROR ${msg}`);
        this.log("Not running SteamCMD. Starting the servers that were stopped again…");
        const down = await this.bringBack(touched, running);
        const err = new Error(
          `Couldn't stop ${s.name} (${msg}), so CS2 wasn't updated.` +
            (down.length ? ` Not back up: ${down.map((d) => `${d.name} (${d.reason})`).join(", ")}.` : ""),
        ) as Error & { down?: { name: string; reason: string }[] };
        err.down = down;
        throw err;
      }
    }

    let updateError: Error | null = null;
    try {
      this.log(`Running SteamCMD${opts.validate ? " with validate (slower, checks every file)" : ""}…`);
      await this.host.steamUpdate(opts.validate, (l) => this.log(`  ${l}`));
      const after = (await this.files.baseVersion()).patchVersion;
      this.log(after === before ? `CS2 is up to date (${after}).` : `CS2 updated: ${before ?? "none"} → ${after}`);
    } catch (e) {
      updateError = e as Error;
      this.log(`SteamCMD failed: ${updateError.message}`);
    }

    this.log("Checking server files…");
    for (const s of servers) {
      try {
        const gi = await this.files.regenerateGameinfo(s.slug);
        this.log(`  ${s.name}: gameinfo.gi ${gi === "patched" ? "regenerated with Metamod" : "uses the stock file"}`);
        const deduped = await this.files.dedupeStockConfigs(s.slug);
        if (deduped.length) this.log(`  ${s.name}: removed ${deduped.length} config copies identical to stock`);
        const stale = await this.files.hygieneScan(s.slug);
        for (const f of stale) this.log(`  ${s.name}: WARNING ${f} overrides a CS2 file and may be out of date`);
      } catch (e) {
        this.log(`  ${s.name}: ERROR ${(e as Error).message}`);
      }
    }

    const down = await this.bringBack(servers, running);
    const up = running.filter((s) => !down.some((d) => d.name === s.name));

    if (this.afterStart && up.length) {
      this.log(`Checking that plugins loaded (in ${Math.round(this.pluginCheckDelayMs / 1000)} seconds)…`);
      await this.sleep(this.pluginCheckDelayMs);
      try {
        for (const l of await this.afterStart(up)) this.log(l);
      } catch (e) {
        this.log(`  plugin check failed: ${(e as Error).message}`);
      }
    }

    if (updateError) {
      const err = new Error(
        updateError.message + (down.length ? ` Also not back up: ${down.map((d) => `${d.name} (${d.reason})`).join(", ")}.` : ""),
      ) as Error & { down?: { name: string; reason: string }[] };
      err.down = down;
      throw err;
    }
    if (!down.length) this.log("Done.");
    return { filesUpdated: true, down };
  }

  /**
   * Mounts the given servers and starts those that were running, then waits until each started one has
   * stayed up. Returns the ones that didn't come back, with the reason.
   */
  private async bringBack(list: ServerRecord[], running: ServerRecord[]): Promise<{ name: string; reason: string }[]> {
    this.log("Mounting overlays and starting servers…");
    const down: { name: string; reason: string }[] = [];
    const started: ServerRecord[] = [];
    for (const s of list) {
      try {
        if (running.includes(s)) {
          await this.host.cs2ctl("start", s.slug);
          this.log(`  ${s.name}: started`);
          started.push(s);
        } else {
          await this.host.cs2ctl("mount", s.slug);
        }
      } catch (e) {
        const msg = (e as Error).message;
        this.log(`  ${s.name}: ERROR ${msg}`);
        if (running.includes(s)) down.push({ name: s.name, reason: `couldn't start: ${msg}` });
      }
    }
    if (!started.length) return down;

    this.log(`Checking that the servers stay up (up to ${Math.round(this.recoveryWindowMs / 1000)} seconds)…`);
    const deadline = Date.now() + this.recoveryWindowMs;
    const seen = new Map<string, string>();
    const last = new Map<string, string>();
    const healthy = new Set<string>();
    for (;;) {
      for (const s of started) {
        if (healthy.has(s.slug)) continue;
        const st = await this.host.serviceStatus(s.slug);
        last.set(s.slug, st.state);
        if (st.state === "active" && st.since) {
          const stableFor = Date.now() - Date.parse(st.since);
          if (seen.get(s.slug) === st.since && stableFor >= this.recoveryStableMs) {
            healthy.add(s.slug);
            this.log(`  ${s.name}: up`);
          } else seen.set(s.slug, st.since);
        } else seen.delete(s.slug);
      }
      if (healthy.size === started.length || Date.now() >= deadline) break;
      await this.sleep(this.recoveryPollMs);
    }
    for (const s of started) {
      if (healthy.has(s.slug)) continue;
      const state = last.get(s.slug);
      const reason =
        state === "failed"
          ? "crashed, and systemd gave up restarting it"
          : state === "activating" || state === "active"
            ? "keeps crashing and restarting"
            : `is ${state ?? "not running"}`;
      this.log(`  ${s.name}: NOT UP: ${reason}`);
      down.push({ name: s.name, reason });
    }
    return down;
  }
}
