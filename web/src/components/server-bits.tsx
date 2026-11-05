import { api, type Server, type ServiceState } from "../api";
import { useAction, useApp } from "../app-context";

const STATE_TEXT: Record<ServiceState, string> = {
  active: "Running",
  activating: "Starting",
  deactivating: "Stopping",
  inactive: "Stopped",
  failed: "Crashed",
  unknown: "Unknown",
};

export function StateLabel({ state }: { state: ServiceState }) {
  return (
    <span className="state-pill" data-state={state}>
      {STATE_TEXT[state]}
    </span>
  );
}

/** One segment per player slot, filled for each connected player. */
export function Slots({ server }: { server: Server }) {
  const max = server.live?.maxPlayers || server.maxPlayers;
  const players = server.live ? server.live.players : 0;
  const shown = Math.min(max, 32);
  const filled = Math.round((players / max) * shown);
  return (
    <>
      <div className="slots-label">
        <span>Players</span>
        <span>
          <b>{server.live ? players : "–"}</b> / {max}
        </span>
      </div>
      <div className="slots" role="img" aria-label={server.live ? `${players} of ${max} players` : "Not running"}>
        {Array.from({ length: shown }, (_, i) => (
          <i key={i} className={i < filled ? "on" : undefined} />
        ))}
      </div>
    </>
  );
}

export function ControlButtons({ server, onChange, compact = false }: { server: Server; onChange: (s: Server) => void; compact?: boolean }) {
  const { can } = useApp();
  const { busy, run } = useAction();
  if (!can("server.control")) return null;
  const running = server.status.state === "active" || server.status.state === "activating";
  const act = async (action: "start" | "stop" | "restart", _e?: React.MouseEvent) => {
    const label = { start: "Started", stop: "Stopped", restart: "Restarted" }[action];
    const r = await run(() => api.control(server.id, action), `${label} ${server.name}.`);
    if (r) onChange(r.server);
  };
  const cls = compact ? "btn small" : "btn";
  return running ? (
    <>
      <button className={cls} disabled={busy} onClick={(e) => act("restart", e)}>
        Restart
      </button>
      <button className={`${cls} danger`} disabled={busy} onClick={(e) => act("stop", e)}>
        Stop
      </button>
    </>
  ) : (
    <button className={`${cls} primary`} disabled={busy} onClick={(e) => act("start", e)}>
      Start
    </button>
  );
}
