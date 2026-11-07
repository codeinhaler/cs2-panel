import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fullTime, timeAgo, type MetricRange, type MetricSeries, type MonitorOverview, type PanelAlert } from "../api";
import { useApp } from "../app-context";
import { fmtBytes, niceBytes, fmtCount, fmtPct, fmtRate, LineChart, seriesColorFor, type ChartSeries } from "../components/LineChart";

const RANGES: { value: MetricRange; label: string }[] = [
  { value: "1h", label: "1 hour" },
  { value: "6h", label: "6 hours" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

export function RangePicker({ value, onChange }: { value: MetricRange; onChange: (r: MetricRange) => void }) {
  return (
    <div className="segmented range-picker" role="radiogroup" aria-label="Time range">
      {RANGES.map((r) => (
        <button key={r.value} type="button" role="radio" aria-checked={value === r.value} className={value === r.value ? "on" : ""} onClick={() => onChange(r.value)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** Lines up several series on shared timestamps (they're bucketed the same way). */
export function alignSeries(sets: { key: string; name: string; color: string; data: MetricSeries }[], pick: (p: MetricSeries["points"][number]) => number | null) {
  const times = [...new Set(sets.flatMap((s) => s.data.points.map((p) => p.t)))].sort((a, b) => a - b);
  const series: ChartSeries[] = sets.map((s) => {
    const byT = new Map(s.data.points.map((p) => [p.t, pick(p)]));
    return { key: s.key, name: s.name, color: s.color, values: times.map((t) => byT.get(t) ?? null) };
  });
  return { times, series };
}

export function MonitorPage() {
  const { toast } = useApp();
  const [range, setRange] = useState<MetricRange>(() => {
    try {
      return (localStorage.getItem("monitor.range") as MetricRange) || "24h";
    } catch {
      return "24h";
    }
  });
  const [overview, setOverview] = useState<MonitorOverview | null>(null);
  const [machine, setMachine] = useState<MetricSeries | null>(null);
  const [perServer, setPerServer] = useState<{ id: number; name: string; index: number; data: MetricSeries }[]>([]);
  const [history, setHistory] = useState<PanelAlert[]>([]);

  const load = useCallback(async () => {
    try {
      const o = await api.monitor();
      setOverview(o);
      const [m, ...servers] = await Promise.all([api.metrics("machine", range), ...o.servers.map((s) => api.metrics(s.id, range))]);
      setMachine(m!);
      // Colour by position in the (id-ordered) server list, so a server keeps its colour.
      setPerServer(o.servers.map((s, i) => ({ id: s.id, name: s.name, index: i, data: servers[i]! })));
      setHistory((await api.alerts(true)).alerts.filter((a) => a.resolvedAt));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [range, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const pickRange = (r: MetricRange) => {
    setRange(r);
    try {
      localStorage.setItem("monitor.range", r);
    } catch {
      /* fine */
    }
  };

  const now = overview?.latest["0"];
  const players = overview ? overview.servers.reduce((n, s) => n + (overview.latest[String(s.id)]?.players ?? 0), 0) : 0;
  const diskPct = now?.diskUsed && now.diskTotal ? (now.diskUsed / now.diskTotal) * 100 : null;
  const memPct = now?.mem && now.memTotal ? (now.mem / now.memTotal) * 100 : null;

  const serverSets = perServer.map((s) => ({ key: String(s.id), name: s.name, color: seriesColorFor(s.index), data: s.data }));
  const cpuByServer = alignSeries(serverSets, (p) => p.cpu);
  const playersByServer = alignSeries(serverSets, (p) => p.players);
  const memByServer = alignSeries(serverSets, (p) => p.mem);
  const machineCpu = machine ? alignSeries([{ key: "cpu", name: "CPU", color: "var(--series-1)", data: machine }], (p) => p.cpu) : null;
  const machineMem = machine ? alignSeries([{ key: "mem", name: "Memory used", color: "var(--series-1)", data: machine }], (p) => p.mem) : null;
  const net = machine
    ? alignSeries(
        [
          { key: "rx", name: "In", color: "var(--series-1)", data: machine },
          { key: "tx", name: "Out", color: "var(--series-2)", data: machine },
        ],
        (p) => p.netRx,
      )
    : null;
  if (net && machine) {
    const byT = new Map(machine.points.map((p) => [p.t, p.netTx]));
    net.series[1]!.values = net.times.map((t) => byT.get(t) ?? null);
  }
  const from = machine?.from ?? Date.now() - 86_400_000;
  const to = machine?.to ?? Date.now();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Monitor</h1>
          <p>How hard the machine and each server are working. Sampled every minute; 7 days in detail, 90 days as hourly averages.</p>
        </div>
      </div>

      {overview && overview.alerts.length > 0 && (
        <div className="panel">
          <h2 style={{ marginBottom: 8 }}>Warnings</h2>
          {overview.alerts.map((a) => (
            <div key={a.id} className="notice error" style={{ marginBottom: 8 }}>
              <strong>⚠ {a.message}</strong>{" "}
              <span className="hint">
                Since <span title={fullTime(a.startedAt)}>{timeAgo(a.startedAt)}</span>
                {a.serverId && (
                  <>
                    {" · "}
                    <Link to={`/servers/${a.serverId}`}>Open {a.serverName}</Link>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="label">CPU, whole machine</div>
          <div className="value">{now?.cpu != null ? fmtPct(now.cpu) : "–"}</div>
          <div className="sub">{overview ? `${overview.cpuCount} cores` : ""}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Memory</div>
          <div className="value">{now?.mem != null ? fmtBytes(now.mem) : "–"}</div>
          <div className="sub">{now?.memTotal ? `of ${fmtBytes(now.memTotal)}` : ""}</div>
          {memPct !== null && (
            <div className="meter" role="img" aria-label={`${Math.round(memPct)}% used`}>
              <i className={memPct >= 90 ? "warn" : undefined} style={{ width: `${memPct}%` }} />
            </div>
          )}
        </div>
        <div className="stat-tile">
          <div className="label">Disk</div>
          <div className="value">{diskPct !== null ? fmtPct(diskPct) : "–"}</div>
          <div className="sub">{now?.diskTotal && now.diskUsed != null ? `${fmtBytes(now.diskTotal - now.diskUsed)} free` : ""}</div>
          {diskPct !== null && (
            <div className="meter" role="img" aria-label={`${Math.round(diskPct)}% full`}>
              <i className={diskPct >= 90 ? "warn" : undefined} style={{ width: `${diskPct}%` }} />
            </div>
          )}
        </div>
        <div className="stat-tile">
          <div className="label">Network</div>
          <div className="value" style={{ fontSize: "1.1rem", paddingTop: 6 }}>
            ↓ {now?.netRx != null ? fmtRate(now.netRx) : "–"}
          </div>
          <div className="sub">↑ {now?.netTx != null ? fmtRate(now.netTx) : "–"}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Players online</div>
          <div className="value">{overview ? players : "–"}</div>
          <div className="sub">people, not bots</div>
        </div>
      </div>

      <div className="row-actions" style={{ marginBottom: 16 }}>
        <RangePicker value={range} onChange={pickRange} />
      </div>

      <div className="chart-grid">
        <div className="panel chart-card">
          <h3>CPU per server</h3>
          <p className="chart-sub">Each server runs on one core; 100% means that core is fully busy.</p>
          <LineChart times={cpuByServer.times} series={cpuByServer.series} from={from} to={to} yMax={100} format={fmtPct} />
        </div>
        <div className="panel chart-card">
          <h3>Players per server</h3>
          <p className="chart-sub">People only, not bots.</p>
          <LineChart times={playersByServer.times} series={playersByServer.series} from={from} to={to} format={fmtCount} />
        </div>
        <div className="panel chart-card">
          <h3>CPU, whole machine</h3>
          <p className="chart-sub">All {overview?.cpuCount ?? ""} cores together.</p>
          {machineCpu && <LineChart times={machineCpu.times} series={machineCpu.series} from={from} to={to} yMax={100} format={fmtPct} />}
        </div>
        <div className="panel chart-card">
          <h3>Memory, whole machine</h3>
          <p className="chart-sub">The top of the chart is all the memory the machine has.</p>
          {machineMem && <LineChart times={machineMem.times} series={machineMem.series} from={from} to={to} yMax={now?.memTotal ?? undefined} format={fmtBytes} niceTop={niceBytes} />}
        </div>
        <div className="panel chart-card">
          <h3>Memory per server</h3>
          <p className="chart-sub">What each CS2 server process uses.</p>
          <LineChart times={memByServer.times} series={memByServer.series} from={from} to={to} format={fmtBytes} niceTop={niceBytes} />
        </div>
        <div className="panel chart-card">
          <h3>Network</h3>
          <p className="chart-sub">The whole machine, in and out.</p>
          {net && <LineChart times={net.times} series={net.series} from={from} to={to} format={fmtRate} />}
        </div>
      </div>

      {history.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2 style={{ marginBottom: 8 }}>Earlier warnings</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Warning</th>
                  <th>Started</th>
                  <th>Cleared</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 20).map((a) => (
                  <tr key={a.id}>
                    <td>{a.message}</td>
                    <td title={fullTime(a.startedAt)}>{fullTime(a.startedAt)}</td>
                    <td title={fullTime(a.resolvedAt)}>{timeAgo(a.resolvedAt!)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
