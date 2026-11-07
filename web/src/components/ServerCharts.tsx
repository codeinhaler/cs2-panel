import { useEffect, useState } from "react";
import { api, type MetricRange, type MetricSeries } from "../api";
import { alignSeries, RangePicker } from "../pages/Monitor";
import { fmtBytes, niceBytes, fmtCount, fmtPct, LineChart } from "./LineChart";

/** CPU, memory and players for one server, on its Overview. */
export function ServerCharts({ serverId, core }: { serverId: number; core: number }) {
  const [range, setRange] = useState<MetricRange>("6h");
  const [data, setData] = useState<MetricSeries | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void api.metrics(serverId, range).then((d) => alive && setData(d), () => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [serverId, range]);

  const one = (name: string, pick: (p: MetricSeries["points"][number]) => number | null) =>
    data ? alignSeries([{ key: name, name, color: "var(--series-1)", data }], pick) : null;
  const cpu = one("CPU", (p) => p.cpu);
  const mem = one("Memory", (p) => p.mem);
  const players = one("Players", (p) => p.players);
  const from = data?.from ?? Date.now();
  const to = data?.to ?? Date.now();

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Performance</h2>
        <RangePicker value={range} onChange={setRange} />
      </div>
      <div className="chart-grid">
        <div className="chart-card">
          <h3>CPU</h3>
          <p className="chart-sub">Of its CPU core ({core}); 100% means fully busy.</p>
          {cpu && <LineChart times={cpu.times} series={cpu.series} from={from} to={to} yMax={100} format={fmtPct} height={140} />}
        </div>
        <div className="chart-card">
          <h3>Memory</h3>
          <p className="chart-sub">Used by the CS2 process.</p>
          {mem && <LineChart times={mem.times} series={mem.series} from={from} to={to} format={fmtBytes} niceTop={niceBytes} height={140} />}
        </div>
        <div className="chart-card">
          <h3>Players</h3>
          <p className="chart-sub">People only, not bots.</p>
          {players && <LineChart times={players.times} series={players.series} from={from} to={to} format={fmtCount} height={140} />}
        </div>
      </div>
    </div>
  );
}
