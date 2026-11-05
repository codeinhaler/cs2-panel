import type { AuditLog } from "../audit.js";
import { conflict } from "../errors.js";
import type { Host } from "../host/host.js";
import type { InstanceFiles } from "../servers/instance-files.js";
import type { OperationGate } from "../servers/service.js";
import type { ServerStore } from "../servers/store.js";
import type { RconExec } from "./rcon.js";

export type JobState = "idle" | "running" | "succeeded" | "failed";

export interface UpdateJob {
  state: JobState;
  startedAt: string | null;
  finishedAt: string | null;
  startedBy: number | null;
  lines: string[];
}

const MAX_LINES = 5000;

/**
 * Runs the CS2 update flow from DESIGN.md §7: warn players, stop and unmount
 * every server, update the shared base, regenerate gameinfo.gi, check for
 * stale files, and start the servers that were running.
 */
export class GameUpdater {
  job: UpdateJob = { state: "idle", startedAt: null, finishedAt: null, startedBy: null, lines: [] };

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
  start(opts: { validate: boolean; warnSeconds: number }, userId: number): void {
    this.gate.assertFree();
    if (this.job.state === "running") throw conflict("An update is already running.");
    this.gate.busy = "a CS2 update";
    this.job = { state: "running", startedAt: new Date().toISOString(), finishedAt: null, startedBy: userId, lines: [] };
    this.audit.record(userId, "game.update.start", null, opts);
    void this.run(opts)
      .then(() => {
        this.job.state = "succeeded";
        this.audit.record(userId, "game.update.finish", null, { result: "succeeded" });
      })
      .catch((err: Error) => {
        this.log(`ERROR: ${err.message}`);
        this.job.state = "failed";
        this.audit.record(userId, "game.update.finish", null, { result: "failed", error: err.message });
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

  private async run(opts: { validate: boolean; warnSeconds: number }): Promise<void> {
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
    for (const s of servers) {
      await this.host.cs2ctl("umount", s.slug);
      this.log(`  ${s.name}: stopped`);
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
        const stale = await this.files.hygieneScan(s.slug);
        for (const f of stale) this.log(`  ${s.name}: WARNING ${f} overrides a CS2 file and may be out of date`);
      } catch (e) {
        this.log(`  ${s.name}: ERROR ${(e as Error).message}`);
      }
    }

    this.log("Mounting overlays and starting servers…");
    for (const s of servers) {
      try {
        if (running.includes(s)) {
          await this.host.cs2ctl("start", s.slug);
          this.log(`  ${s.name}: started`);
        } else {
          await this.host.cs2ctl("mount", s.slug);
        }
      } catch (e) {
        this.log(`  ${s.name}: ERROR ${(e as Error).message}`);
      }
    }

    if (updateError) throw updateError;
    this.log("Done.");
  }
}
