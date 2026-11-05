import { lazy, Suspense } from "react";
import { Link, NavLink, Route, Routes, useParams } from "react-router-dom";
import { api, modeName, timeAgo, uptime, type Server } from "../api";
import { useApp, usePolling } from "../app-context";
import { ControlButtons, Slots, StateLabel } from "../components/server-bits";
import { ConsoleTab } from "./server/Console";
import { SettingsTab } from "./server/Settings";
import { PluginsTab } from "./server/Plugins";
import { ActivityList } from "./Activity";

// The config editor pulls in Monaco, so load it only when that tab opens.
const ConfigsTab = lazy(() => import("./server/Configs").then((m) => ({ default: m.ConfigsTab })));

export function ServerPage() {
  const id = Number(useParams().id);
  const { data, error, setData, refresh } = usePolling(() => api.server(id).then((r) => r.server), 5000, [id]);

  if (error && !data) {
    return (
      <div className="notice error">
        {error} <Link to="/">Back to servers</Link>
      </div>
    );
  }
  if (!data) return null;
  const s = data;

  return (
    <>
      <div className="detail-head">
        <div className="detail-port" data-state={s.status.state} title="UDP game port">
          {s.port}
        </div>
        <div className="titles">
          <h1>{s.name}</h1>
          <p>
            <StateLabel state={s.status.state} />
            {s.status.state === "active" && <span style={{ marginLeft: 12 }}>up {uptime(s.status.since)}</span>}
          </p>
        </div>
        <div className="row-actions">
          <ControlButtons server={s} onChange={setData} showForceStop />
        </div>
      </div>

      <nav className="tabs" aria-label="Server sections">
        <NavLink end to={`/servers/${id}`} className="tab">
          Overview
        </NavLink>
        <NavLink to={`/servers/${id}/console`} className="tab">
          Console
        </NavLink>
        <NavLink to={`/servers/${id}/configs`} className="tab">
          Config files
        </NavLink>
        <NavLink to={`/servers/${id}/plugins`} className="tab">
          Plugins
        </NavLink>
        <NavLink to={`/servers/${id}/settings`} className="tab">
          Settings
        </NavLink>
      </nav>

      <Routes>
        <Route index element={<Overview server={s} />} />
        <Route path="console" element={<ConsoleTab server={s} />} />
        <Route
          path="configs"
          element={
            <Suspense fallback={<p className="hint">Loading editor…</p>}>
              <ConfigsTab server={s} />
            </Suspense>
          }
        />
        <Route path="plugins" element={<PluginsTab server={s} />} />
        <Route path="settings" element={<SettingsTab server={s} onSaved={() => void refresh()} />} />
      </Routes>
    </>
  );
}

function Overview({ server: s }: { server: Server }) {
  const { can } = useApp();
  return (
    <>
      <div className="panel">
        <div className="unit-slots" style={{ border: 0, padding: 0, maxWidth: 420, marginBottom: 20 }}>
          <Slots server={s} />
        </div>
        <dl className="facts">
          <div>
            <dt>Game mode</dt>
            <dd>{modeName(s)}</dd>
          </div>
          <div>
            <dt>Map</dt>
            <dd>{s.live?.map ?? s.map}</dd>
          </div>
          <div>
            <dt>Join password</dt>
            <dd>{s.password ? (can("server.manage") ? <code>{s.password}</code> : "Set") : "None"}</dd>
          </div>
          <div>
            <dt>Public listing</dt>
            <dd>{s.gsltSet ? `GSLT set (${s.gsltHint})` : "No GSLT: LAN or direct connect only"}</dd>
          </div>
          <div>
            <dt>CPU core</dt>
            <dd>{s.cpu}</dd>
          </div>
          <div>
            <dt>Starts on boot</dt>
            <dd>{s.autostart ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>Short name</dt>
            <dd>
              <code>{s.slug}</code>
            </dd>
          </div>
          {s.live && (
            <div>
              <dt>Game version</dt>
              <dd>{s.live.version}</dd>
            </div>
          )}
          <div>
            <dt>Created</dt>
            <dd>{timeAgo(s.createdAt)}</dd>
          </div>
        </dl>
        <p className="hint" style={{ marginTop: 18, marginBottom: 0 }}>
          Players connect with <code>connect &lt;your public IP&gt;:{s.port}</code>
          {s.password ? <> and the join password</> : null}.
        </p>
      </div>

      <div className="panel">
        <h2 style={{ marginBottom: 12 }}>Recent activity</h2>
        <ActivityList serverId={s.id} limit={10} compact />
      </div>
    </>
  );
}
