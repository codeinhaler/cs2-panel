import { useEffect, useState } from "react";
import { api, fullTime, timeAgo, type PanelAlert } from "../api";

/** Open warnings for one server (from the monitor). */
export function ServerAlerts({ serverId }: { serverId: number }) {
  const [alerts, setAlerts] = useState<PanelAlert[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void api.alerts().then((r) => alive && setAlerts(r.alerts.filter((a) => a.serverId === serverId)), () => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [serverId]);
  return (
    <>
      {alerts.map((a) => (
        <div key={a.id} className="notice error" style={{ marginBottom: 16 }}>
          <strong>⚠ {a.message}</strong>{" "}
          <span className="hint">
            Since <span title={fullTime(a.startedAt)}>{timeAgo(a.startedAt)}</span>
          </span>
        </div>
      ))}
    </>
  );
}
