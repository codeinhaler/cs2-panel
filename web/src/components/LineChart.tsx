import { useEffect, useMemo, useRef, useState } from "react";
import { formatDate, formatDateTime, formatTime } from "../format";

export interface ChartSeries {
  key: string;
  name: string;
  /** A CSS colour, normally var(--series-N); assign by entity, never by rank. */
  color: string;
  /** One value per entry in `times`; null leaves a gap. */
  values: (number | null)[];
}

/**
 * A plain SVG line chart: one y-axis, 2px lines, recessive grid, a crosshair that
 * snaps to the nearest time with a tooltip listing every series, a legend for two
 * or more series and labels at the line ends for up to four.
 */
export function LineChart({
  times,
  series,
  from,
  to,
  yMax,
  format,
  height = 170,
  empty = "No data yet. The panel takes a sample every minute.",
  niceTop = niceCeil,
}: {
  times: number[];
  series: ChartSeries[];
  from: number;
  to: number;
  /** Fixed top of the y-axis (e.g. 100 for percentages); otherwise from the data. */
  yMax?: number;
  format: (v: number) => string;
  height?: number;
  empty?: string;
  /** How to round the axis top; defaults to 1/2/5 × 10^n. */
  niceTop?: (max: number) => number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const hasData = series.some((s) => s.values.some((v) => v !== null));
  // Draw at the real width, so text and lines keep their size instead of being scaled.
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);
  const H = height;
  const pad = { l: 46, r: series.length > 1 && series.length <= 4 ? 70 : 10, t: 8, b: 22 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const top = useMemo(() => {
    if (yMax !== undefined) return yMax;
    const m = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
    return niceTop(m || 1);
  }, [series, yMax, niceTop]);

  const x = (t: number) => pad.l + ((t - from) / Math.max(1, to - from)) * plotW;
  const y = (v: number) => pad.t + plotH - (Math.min(v, top) / top) * plotH;
  const span = to - from;
  const tickLabel = (t: number) => (span <= 36 * 3_600_000 ? formatTime(new Date(t)) : formatDate(new Date(t)));
  const xTicks = [0, 1, 2, 3].map((i) => from + (span * (i + 0.5)) / 4);

  const paths = series.map((s) => {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(times[i]!).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  });

  const lastIndex = (s: ChartSeries) => {
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] !== null) return i;
    return -1;
  };

  const onMove = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = from + ((px - pad.l) / plotW) * span;
    let best = -1;
    let bestD = Infinity;
    times.forEach((tt, i) => {
      const d = Math.abs(tt - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best >= 0 ? best : null);
  };

  if (!hasData) return <div className="chart-empty" ref={box}>{empty}</div>;

  const hx = hover !== null ? x(times[hover]!) : 0;
  const labelled = series.length > 1 && series.length <= 4;

  return (
    <div>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.key}>
              <i className="swatch-line" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="chart" ref={box} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${series.map((s) => s.name).join(", ")} over time`}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(top * f)} y2={y(top * f)} />
              <text className="axis-label" x={pad.l - 6} y={y(top * f) + 4} textAnchor="end">
                {format(top * f)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} className="axis-label" x={x(t)} y={H - 6} textAnchor="middle">
              {tickLabel(t)}
            </text>
          ))}
          {paths.map((d, i) => (
            <path key={series[i]!.key} d={d} fill="none" stroke={series[i]!.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {labelled &&
            series.map((s) => {
              const i = lastIndex(s);
              if (i < 0) return null;
              return (
                <text key={s.key} className="end-label" x={x(times[i]!) + 6} y={y(s.values[i]!) + 4}>
                  {s.name.length > 10 ? `${s.name.slice(0, 9)}…` : s.name}
                </text>
              );
            })}
          {hover !== null && (
            <>
              <line className="crosshair" x1={hx} x2={hx} y1={pad.t} y2={pad.t + plotH} />
              {series.map((s) =>
                s.values[hover] !== null ? (
                  <circle key={s.key} cx={hx} cy={y(s.values[hover]!)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
                ) : null,
              )}
            </>
          )}
        </svg>
        {hover !== null && (
          <div className="chart-tip" style={{ left: `${(hx / W) * 100}%`, transform: hx > W * 0.6 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
            <div className="tip-time">{formatDateTime(new Date(times[hover]!))}</div>
            {series.map((s) => (
              <div key={s.key} className="tip-row">
                <i className="swatch-line" style={{ background: s.color }} />
                <span>{s.name}</span>
                <b style={{ marginLeft: "auto" }}>{s.values[hover] === null ? "–" : format(s.values[hover]!)}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Rounds up to 1, 2 or 5 × a power of ten, for a tidy axis top. */
function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Axis top for byte values: whole GB (or MB) steps. */
export function niceBytes(max: number): number {
  const unit = max >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2;
  return niceCeil(max / unit) * unit;
}

export const SERIES_COLORS = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);

/** Colour for a server: fixed by its id, so filters and ranges never repaint it. */
export function seriesColorFor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

export const fmtPct = (v: number) => `${Math.round(v)}%`;
export function fmtBytes(v: number): string {
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(v >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (v >= 1024 ** 2) return `${Math.round(v / 1024 ** 2)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} kB`;
  return `${Math.round(v)} B`;
}
export const fmtRate = (v: number) => `${fmtBytes(v)}/s`;
export const fmtCount = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
