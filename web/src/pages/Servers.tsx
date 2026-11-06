import { Link } from "react-router-dom";
import { api, fullTime, modeName, uptime, type Server } from "../api";
import { useApp, usePolling } from "../app-context";
import { ControlButtons, Slots, StateLabel } from "../components/server-bits";

export function ServersPage() {
  const { can } = useApp();
  const { data, error, setData } = usePolling(() => Promise.all([api.servers(), api.host()]), 5000);
  const servers = data?.[0].servers;
  const host = data?.[1];

  const replace = (s: Server) =>
    setData((d) => (d ? [{ servers: d[0].servers.map((x) => (x.id === s.id ? s : x)) }, d[1]] : d));

  const running = servers?.filter((s) => s.status.state === "active").length ?? 0;
  const players = servers?.reduce((n, s) => n + (s.live?.players ?? 0), 0) ?? 0;
  const overCores = host && running > Math.max(1, host.cpuCount - 1);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Servers</h1>
          {servers && servers.length > 0 && (
            <p>
              {running} of {servers.length} running, {players} {players === 1 ? "player" : "players"} online
            </p>
          )}
        </div>
        {can("server.manage") && (
          <Link to="/servers/new" className="btn primary">
            New server
          </Link>
        )}
      </div>

      {error && <div className="notice error">{error}</div>}

      {host?.update.available && !host.busy && (
        <div className="notice info" style={{ marginBottom: 16 }}>
          A CS2 update is out.{" "}
          {host.update.policy === "when-empty"
            ? `It installs once the servers are empty${host.update.deadline ? `, at the latest ${fullTime(host.update.deadline)}` : ""}. `
            : host.update.policy === "now"
              ? "It's being installed. "
              : "Players can't join until the servers are updated. "}
          <Link to="/game">Game update</Link>
        </div>
      )}

      {host && !host.cs2.installed && (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          CS2 isn't installed on this machine yet. You can create servers now; start them after installing CS2 on the{" "}
          <Link to="/game">Game update</Link> page.
        </div>
      )}
      {host?.busy && (
        <div className="notice info" style={{ marginBottom: 16 }}>
          A {host.busy.replace(/^a /, "")} is in progress. Server actions are paused until it finishes.
        </div>
      )}
      {overCores && (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          {running} servers are running on {host.cpuCount} CPU cores, so some share a core. That's fine for small or quiet servers,
          but busy ones may lag.
        </div>
      )}

      {servers && servers.length === 0 && (
        <div className="empty">
          <h2>No servers yet</h2>
          <p>Create a server, pick its game mode and port, and it shows up here with its status and player count.</p>
          {can("server.manage") && (
            <Link to="/servers/new" className="btn primary">
              Create your first server
            </Link>
          )}
        </div>
      )}

      <div className="rack">
        {servers?.map((s) => (
          <div key={s.id} className="unit" data-state={s.status.state}>
            <div className="unit-bar" />
            <div className="unit-port">
              {s.port}
              <small>UDP port</small>
            </div>
            <div className="unit-body">
              <Link to={`/servers/${s.id}`} className="unit-name unit-link">
                {s.name}
              </Link>
              <div className="unit-meta">
                <StateLabel state={s.status.state} />
                <span>{modeName(s)}</span>
                <span>{s.live?.map ?? s.map}</span>
                {s.status.state === "active" && <span>up {uptime(s.status.since)}</span>}
              </div>
            </div>
            <div className="unit-slots">
              <Slots server={s} />
            </div>
            <div className="unit-actions">
              <ControlButtons server={s} onChange={replace} compact />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
