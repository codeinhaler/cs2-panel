import { Link } from "react-router-dom";
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

/** The server's state; "Running" only once the game actually answers. */
export function StateLabel({ server }: { server: Server }) {
  const state = server.status.state;
  if (state === "active" && server.answering === "starting") {
    return (
      <span className="state-pill" data-state="activating" title="The process runs; the game is still loading">
        Starting
      </span>
    );
  }
  if (state === "active" && server.answering === "no") {
    return (
      <span className="state-pill" data-state="failed" title="The process runs, but the game doesn't answer, so players can't join">
        Not answering
      </span>
    );
  }
  return (
    <span className="state-pill" data-state={state}>
      {STATE_TEXT[state]}
    </span>
  );
}

/** Explains a server that runs but doesn't answer, with the most likely reason. */
export function NotAnsweringNotice({ server, consoleHref }: { server: Server; consoleHref: string }) {
  if (server.status.state !== "active" || server.answering !== "no") return null;
  const workshop = /^(workshop|collection):/.test(server.map);
  return (
    <div className="notice error" style={{ marginBottom: 16 }}>
      <strong>The server process is running, but the game doesn't answer, so players can't join.</strong>{" "}
      {workshop
        ? "It's set to start on a Workshop map. It's probably still downloading it, or stuck because Steam won't hand it out (a removed map, or no GSLT token). Try an installed map in Settings to check."
        : "It may still be loading, or it's stuck. "}
      <Link to={consoleHref}>Check the Console</Link> for errors.
    </div>
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
