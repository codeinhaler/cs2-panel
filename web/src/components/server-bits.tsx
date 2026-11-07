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

/** Steam's server info counts bots as players; this is people only. */
export function humanCount(server: Server): number {
  return server.live ? Math.max(0, server.live.players - server.live.bots) : 0;
}

/** One segment per player slot: filled for each person, dimmed for each bot. */
export function Slots({ server }: { server: Server }) {
  const max = server.live?.maxPlayers || server.maxPlayers;
  const humans = humanCount(server);
  const bots = server.live?.bots ?? 0;
  const shown = Math.min(max, 32);
  const filledHumans = Math.min(shown, Math.round((humans / max) * shown));
  const filledBots = Math.min(shown - filledHumans, Math.round((bots / max) * shown));
  const label = server.live ? `${humans} of ${max} players${bots ? `, ${bots} ${bots === 1 ? "bot" : "bots"}` : ""}` : "Not running";
  return (
    <>
      <div className="slots-label">
        <span>Players</span>
        <span>
          <b>{server.live ? humans : "–"}</b> / {max}
          {bots > 0 && (
            <span className="slots-bots">
              {" "}
              + {bots} {bots === 1 ? "bot" : "bots"}
            </span>
          )}
        </span>
      </div>
      <div className="slots" role="img" aria-label={label}>
        {Array.from({ length: shown }, (_, i) => (
          <i key={i} className={i < filledHumans ? "on" : i < filledHumans + filledBots ? "bot" : undefined} />
        ))}
      </div>
    </>
  );
}

export function ControlButtons({
  server,
  onChange,
  compact = false,
  showForceStop = false,
}: {
  server: Server;
  onChange: (s: Server) => void;
  compact?: boolean;
  showForceStop?: boolean;
}) {
  const { can } = useApp();
  const { busy, run } = useAction();
  if (!can("server.control")) return null;
  const running = server.status.state === "active" || server.status.state === "activating";
  const act = async (action: "start" | "stop" | "restart" | "kill") => {
    if (
      action === "kill" &&
      !window.confirm(
        `Force stop ${server.name}? This kills the server process immediately, plus anything else still running from its folder. Players are dropped without warning.`,
      )
    ) {
      return;
    }
    const label = { start: "Started", stop: "Stopped", restart: "Restarted", kill: "Force-stopped" }[action];
    const r = await run(() => api.control(server.id, action), `${label} ${server.name}.`);
    if (r) onChange(r.server);
  };
  const cls = compact ? "btn small" : "btn";
  const force = showForceStop ? (
    <button className={`${cls} ghost danger`} disabled={busy} onClick={() => act("kill")} title="Kill the server process immediately">
      Force stop
    </button>
  ) : null;
  return running ? (
    <>
      <button className={cls} disabled={busy} onClick={() => act("restart")}>
        Restart
      </button>
      <button className={`${cls} danger`} disabled={busy} onClick={() => act("stop")}>
        Stop
      </button>
      {force}
    </>
  ) : (
    <>
      <button className={`${cls} primary`} disabled={busy} onClick={() => act("start")}>
        Start
      </button>
      {force}
    </>
  );
}
