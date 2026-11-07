import type { AuditLog } from "../audit.js";
import type { Db } from "../db.js";
import type { A2sInfo } from "../game/a2s.js";
import type { Host } from "../host/host.js";
import type { MachineStats } from "../host/stats.js";
import type { ServerRecord } from "../servers/store.js";

export const MACHINE = 0;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KEEP_MINUTE_SAMPLES = 7 * 24 * HOUR;
const KEEP_HOURLY = 90 * 24 * HOUR;
/** A started server gets this long to answer before "not answering" starts counting. */
const STARTUP_GRACE = 90_000;

/** Thresholds for warnings. Raise at the first number, clear below the second, so a value hovering around the line doesn't flap. */
export const THRESHOLDS = {
  serverCpu: { raise: 90, clear: 75, minutes: 10 },
  machineCpu: { raise: 95, clear: 80, minutes: 10 },
  machineMem: { raise: 90, clear: 85, minutes: 5 },
  disk: { raise: 90, clear: 88 },
  notAnsweringMinutes: 5,
};

export type AlertKind = "server.cpu" | "server.not_answering" | "server.failed" | "machine.cpu" | "machine.mem" | "disk";

export interface Alert {
  id: number;
  kind: AlertKind;
  serverId: number | null;
  serverName: string | null;
  message: string;
  startedAt: string;
  resolvedAt: string | null;
}

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

export const RANGES = { "1h": HOUR, "6h": 6 * HOUR, "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR, "90d": 90 * 24 * HOUR } as const;
export type Range = keyof typeof RANGES;

interface Row {
  ts: number;
  scope: number;
  cpu: number | null;
  mem: number | null;
  mem_total: number | null;
  players: number | null;
  bots: number | null;
  disk_used: number | null;
  disk_total: number | null;
  net_rx: number | null;
  net_tx: number | null;
}

export interface MonitorDeps {
  db: Db;
  host: Host;
  servers: () => ServerRecord[];
  query: (port: number) => Promise<A2sInfo | null>;
  /** Exact people/bots from RCON status, preferred when known. */
  counts?: (serverId: number) => { humans: number; bots: number } | null;
  audit: AuditLog;
}

/**
 * Samples every server and the machine once a minute, keeps the history, and
 * raises or clears warnings.
 */
export class Monitor {
  private prevServer = new Map<number, { at: number; cpuNs: number | null; restarts: number }>();
  private prevMachine: { at: number; s: MachineStats } | null = null;
  private silentSince = new Map<number, number>();
  private lastRollupHour: number | null = null;

  constructor(private readonly d: MonitorDeps) {}

  async sample(now = Date.now()): Promise<void> {
    // All servers at once: a server that doesn't answer costs one query timeout, not one each.
    const [m, ...serverRows] = await Promise.all([this.sampleMachine(now), ...this.d.servers().map((s) => this.sampleServer(s, now))]);
    const rows: Row[] = [...serverRows];
    if (m) rows.push(m);
    const insert = this.d.db.prepare(
      `INSERT INTO metrics (ts, scope, res, cpu, cpu_max, mem, mem_total, players, bots, disk_used, disk_total, net_rx, net_tx)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) insert.run(r.ts, r.scope, r.cpu, r.cpu, r.mem, r.mem_total, r.players, r.bots, r.disk_used, r.disk_total, r.net_rx, r.net_tx);
    this.evaluateThresholds(now);
    this.rollup(now);
  }

  private async sampleServer(s: ServerRecord, now: number): Promise<Row> {
    const [status, stats] = await Promise.all([this.d.host.serviceStatus(s.slug), this.d.host.serviceStats(s.slug)]);
    const running = status.state === "active";
    const prev = this.prevServer.get(s.id);
    this.prevServer.set(s.id, { at: now, cpuNs: stats.cpuNs, restarts: stats.restarts });

    let cpu: number | null = null;
    if (running && prev && prev.cpuNs !== null && stats.cpuNs !== null && now > prev.at && stats.cpuNs >= prev.cpuNs) {
      cpu = round(((stats.cpuNs - prev.cpuNs) / ((now - prev.at) * 1e6)) * 100);
    }

    // systemd restarted it after a crash since the last look.
    if (prev && stats.restarts > prev.restarts) {
      this.d.audit.record(null, "server.crashed", s.id, { restarts: stats.restarts - prev.restarts });
    }
    if (status.state === "failed") this.raise("server.failed", s, `${s.name} stopped after crashing, and systemd gave up restarting it.`);
    else this.resolve("server.failed", s.id);

    let live: A2sInfo | null = null;
    if (running) live = await this.d.query(s.port).catch(() => null);

    // Not answering: running past the startup grace, but no reply to Steam queries for a while.
    const upMs = status.since ? now - Date.parse(status.since) : Infinity;
    if (running && !live && upMs > STARTUP_GRACE) {
      if (!this.silentSince.has(s.id)) this.silentSince.set(s.id, now);
      if (now - this.silentSince.get(s.id)! >= THRESHOLDS.notAnsweringMinutes * MINUTE) {
        this.raise("server.not_answering", s, `${s.name} is running but hasn't answered for ${THRESHOLDS.notAnsweringMinutes} minutes, so players can't join.`);
      }
    } else {
      this.silentSince.delete(s.id);
      this.resolve("server.not_answering", s.id);
    }

    const exact = live ? (this.d.counts?.(s.id) ?? null) : null;
    if (live && exact) {
      live = { ...live, players: exact.humans + exact.bots, bots: exact.bots };
    }
    return {
      ts: now,
      scope: s.id,
      cpu,
      mem: running ? stats.memBytes : null,
      mem_total: null,
      players: live ? Math.max(0, live.players - live.bots) : running ? null : 0,
      bots: live ? live.bots : running ? null : 0,
      disk_used: null,
      disk_total: null,
      net_rx: null,
      net_tx: null,
    };
  }

  private async sampleMachine(now: number): Promise<Row | null> {
    let s: MachineStats;
    try {
      s = await this.d.host.machineStats();
    } catch {
      return null;
    }
    const prev = this.prevMachine;
    this.prevMachine = { at: now, s };
    const dt = prev ? (now - prev.at) / 1000 : 0;
    const dTotal = prev ? s.cpuTotal - prev.s.cpuTotal : 0;
    return {
      ts: now,
      scope: MACHINE,
      cpu: prev && dTotal > 0 ? round(((s.cpuBusy - prev.s.cpuBusy) / dTotal) * 100) : null,
      mem: s.memTotal - s.memAvailable,
      mem_total: s.memTotal,
      players: null,
      bots: null,
      disk_used: s.diskTotal - s.diskFree,
      disk_total: s.diskTotal,
      net_rx: prev && dt > 0 ? Math.max(0, (s.netRx - prev.s.netRx) / dt) : null,
      net_tx: prev && dt > 0 ? Math.max(0, (s.netTx - prev.s.netTx) / dt) : null,
    };
  }

  /** Average of the last n one-minute values of an expression, or null if there aren't n yet. */
  private recentAvg(scope: number, expr: string, n: number, now: number): number | null {
    const r = this.d.db
      .prepare(`SELECT COUNT(v) AS c, AVG(v) AS a FROM (SELECT ${expr} AS v FROM metrics WHERE scope = ? AND res = 0 AND ts > ? ORDER BY ts DESC LIMIT ?)`)
      .get(scope, now - (n + 1) * MINUTE, n) as { c: number; a: number | null };
    return r.c >= n ? r.a : null;
  }

  private evaluateThresholds(now: number): void {
    const T = THRESHOLDS;
    for (const s of this.d.servers()) {
      const hi = this.recentAvg(s.id, "cpu", T.serverCpu.minutes, now);
      const lo = this.recentAvg(s.id, "cpu", 5, now);
      if (hi !== null && hi >= T.serverCpu.raise) {
        this.raise("server.cpu", s, `${s.name} has used ${Math.round(hi)}% of its CPU core for ${T.serverCpu.minutes} minutes. Players may notice lag.`);
      } else if (lo === null || lo < T.serverCpu.clear) {
        this.resolve("server.cpu", s.id);
      }
    }
    const cpuHi = this.recentAvg(MACHINE, "cpu", T.machineCpu.minutes, now);
    const cpuLo = this.recentAvg(MACHINE, "cpu", 5, now);
    if (cpuHi !== null && cpuHi >= T.machineCpu.raise) this.raise("machine.cpu", null, `The machine's CPU has been ${Math.round(cpuHi)}% busy for ${T.machineCpu.minutes} minutes.`);
    else if (cpuLo === null || cpuLo < T.machineCpu.clear) this.resolve("machine.cpu", null);

    const memHi = this.recentAvg(MACHINE, "100.0 * mem / mem_total", T.machineMem.minutes, now);
    if (memHi !== null && memHi >= T.machineMem.raise) this.raise("machine.mem", null, `The machine's memory is ${Math.round(memHi)}% used.`);
    else if (memHi === null || memHi < T.machineMem.clear) this.resolve("machine.mem", null);

    const disk = this.recentAvg(MACHINE, "100.0 * disk_used / disk_total", 1, now);
    if (disk !== null && disk >= T.disk.raise) this.raise("disk", null, `The disk is ${Math.round(disk)}% full. CS2 updates need several GB free.`);
    else if (disk === null || disk < T.disk.clear) this.resolve("disk", null);
  }

  private raise(kind: AlertKind, s: ServerRecord | null, message: string): void {
    const open = this.d.db
      .prepare("SELECT id FROM alerts WHERE kind = ? AND server_id IS ? AND resolved_at IS NULL")
      .get(kind, s?.id ?? null) as { id: number } | undefined;
    if (open) return;
    this.d.db.prepare("INSERT INTO alerts (kind, server_id, message) VALUES (?, ?, ?)").run(kind, s?.id ?? null, message);
    this.d.audit.record(null, "alert.raised", s?.id ?? null, { kind, message });
  }

  private resolve(kind: AlertKind, serverId: number | null): void {
    const open = this.d.db
      .prepare("SELECT id, message FROM alerts WHERE kind = ? AND server_id IS ? AND resolved_at IS NULL")
      .get(kind, serverId) as { id: number; message: string } | undefined;
    if (!open) return;
    this.d.db.prepare("UPDATE alerts SET resolved_at = datetime('now') WHERE id = ?").run(open.id);
    this.d.audit.record(null, "alert.cleared", serverId, { kind, message: open.message });
  }

  /** Hourly averages for finished hours, and dropping old samples. */
  private rollup(now: number): void {
    const hour = Math.floor(now / HOUR) * HOUR;
    if (this.lastRollupHour === hour) return;
    this.lastRollupHour = hour;
    const last = this.d.db.prepare("SELECT MAX(ts) AS t FROM metrics WHERE res = 1").get() as { t: number | null };
    const from = last.t !== null ? last.t + HOUR : 0;
    this.d.db
      .prepare(
        `INSERT INTO metrics (ts, scope, res, cpu, cpu_max, mem, mem_total, players, bots, disk_used, disk_total, net_rx, net_tx)
         SELECT (ts / ${HOUR}) * ${HOUR}, scope, 1, AVG(cpu), MAX(cpu), AVG(mem), MAX(mem_total), AVG(players), AVG(bots),
                AVG(disk_used), MAX(disk_total), AVG(net_rx), AVG(net_tx)
         FROM metrics WHERE res = 0 AND ts >= ? AND ts < ?
         GROUP BY ts / ${HOUR}, scope`,
      )
      .run(from, hour);
    this.d.db.prepare("DELETE FROM metrics WHERE res = 0 AND ts < ?").run(now - KEEP_MINUTE_SAMPLES);
    this.d.db.prepare("DELETE FROM metrics WHERE res = 1 AND ts < ?").run(now - KEEP_HOURLY);
    this.d.db.prepare("DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < datetime('now', '-90 days')").run();
  }

  /** A time series for one server or the machine, averaged into about 240 points. */
  series(scope: number, range: Range, now = Date.now()): { from: number; to: number; bucketMs: number; points: MetricPoint[] } {
    const span = RANGES[range];
    const res = span > 7 * 24 * HOUR ? 1 : 0;
    const bucketMs = Math.max(res ? HOUR : MINUTE, Math.ceil(span / 240 / MINUTE) * MINUTE);
    const from = now - span;
    const rows = this.d.db
      .prepare(
        `SELECT (ts / ?) * ? AS t, AVG(cpu) AS cpu, MAX(cpu_max) AS cpu_max, AVG(mem) AS mem, MAX(mem_total) AS mem_total,
                AVG(players) AS players, AVG(bots) AS bots, AVG(disk_used) AS disk_used, MAX(disk_total) AS disk_total,
                AVG(net_rx) AS net_rx, AVG(net_tx) AS net_tx
         FROM metrics WHERE scope = ? AND res = ? AND ts >= ?
         GROUP BY ts / ? ORDER BY t`,
      )
      .all(bucketMs, bucketMs, scope, res, from, bucketMs) as unknown as (Omit<Row, "ts" | "scope"> & { t: number; cpu_max: number | null })[];
    return {
      from,
      to: now,
      bucketMs,
      points: rows.map((r) => ({
        t: r.t,
        cpu: r.cpu === null ? null : round(r.cpu),
        cpuMax: r.cpu_max === null ? null : round(r.cpu_max),
        mem: r.mem === null ? null : Math.round(r.mem),
        memTotal: r.mem_total,
        players: r.players === null ? null : round(r.players),
        bots: r.bots === null ? null : round(r.bots),
        diskUsed: r.disk_used === null ? null : Math.round(r.disk_used),
        diskTotal: r.disk_total,
        netRx: r.net_rx === null ? null : Math.round(r.net_rx),
        netTx: r.net_tx === null ? null : Math.round(r.net_tx),
      })),
    };
  }

  /** The newest sample for the machine and every server. */
  latest(): Record<number, MetricPoint> {
    const rows = this.d.db
      .prepare(
        `SELECT m.* FROM metrics m
         JOIN (SELECT scope, MAX(ts) AS ts FROM metrics WHERE res = 0 GROUP BY scope) l ON l.scope = m.scope AND l.ts = m.ts
         WHERE m.res = 0`,
      )
      .all() as unknown as (Row & { cpu_max: number | null })[];
    const out: Record<number, MetricPoint> = {};
    for (const r of rows) {
      out[r.scope] = {
        t: r.ts,
        cpu: r.cpu,
        cpuMax: r.cpu_max,
        mem: r.mem,
        memTotal: r.mem_total,
        players: r.players,
        bots: r.bots,
        diskUsed: r.disk_used,
        diskTotal: r.disk_total,
        netRx: r.net_rx,
        netTx: r.net_tx,
      };
    }
    return out;
  }

  alerts(includeResolved = false): Alert[] {
    return (
      this.d.db
        .prepare(
          `SELECT a.id, a.kind, a.server_id, s.name AS server_name, a.message, a.started_at, a.resolved_at
           FROM alerts a LEFT JOIN servers s ON s.id = a.server_id
           ${includeResolved ? "" : "WHERE a.resolved_at IS NULL"}
           ORDER BY a.id DESC LIMIT 100`,
        )
        .all() as { id: number; kind: AlertKind; server_id: number | null; server_name: string | null; message: string; started_at: string; resolved_at: string | null }[]
    ).map((r) => ({
      id: r.id,
      kind: r.kind,
      serverId: r.server_id,
      serverName: r.server_name,
      message: r.message,
      startedAt: r.started_at,
      resolvedAt: r.resolved_at,
    }));
  }
}

const round = (n: number) => Math.round(n * 10) / 10;
