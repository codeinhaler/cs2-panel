import { useEffect, useState } from "react";
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { api, type Me } from "./api";
import { AppProvider, useApp } from "./app-context";
import { LoginPage } from "./pages/Login";
import { ServersPage } from "./pages/Servers";
import { NewServerPage } from "./pages/NewServer";
import { ServerPage } from "./pages/Server";
import { GameUpdatePage } from "./pages/GameUpdate";
import { TeamPage } from "./pages/Team";
import { ActivityPage } from "./pages/Activity";
import { PreferencesPage } from "./pages/Preferences";
import { PresetsPage } from "./pages/Presets";
import { MonitorPage } from "./pages/Monitor";

export function App() {
  const [me, setMe] = useState<Me | null | "loading">("loading");

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);

  if (me === "loading") return null;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={me ? <Navigate to="/" replace /> : <LoginPage />} />
        {me ? (
          <Route
            element={
              <AppProvider me={me}>
                <Shell />
              </AppProvider>
            }
          >
            <Route index element={<ServersPage />} />
            <Route path="servers/new" element={<NewServerPage />} />
            <Route path="servers/:id/*" element={<ServerPage />} />
            <Route path="game" element={<GameUpdatePage />} />
            <Route path="team" element={<TeamPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="preferences" element={<PreferencesPage />} />
            <Route path="presets" element={<PresetsPage />} />
            <Route path="monitor" element={<MonitorPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        ) : (
          <Route path="*" element={<Navigate to="/login" replace />} />
        )}
      </Routes>
    </BrowserRouter>
  );
}

const ROLE_NAMES = { owner: "Owner", admin: "Admin", moderator: "Moderator" } as const;

function Shell() {
  const { me, can } = useApp();
  const name = me.user.displayName ?? me.user.steamId;

  const logout = async () => {
    await api.logout().catch(() => undefined);
    window.location.assign("/login");
  };

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          CS2 Panel
        </div>
        <NavLink to="/" end className="nav-link">
          Servers
        </NavLink>
        <NavLink to="/game" className="nav-link">
          Game update
        </NavLink>
        <NavLink to="/monitor" className="nav-link">
          Monitor
        </NavLink>
        <NavLink to="/presets" className="nav-link">
          Presets
        </NavLink>
        {can("users.manage") && (
          <NavLink to="/team" className="nav-link">
            Team
          </NavLink>
        )}
        <NavLink to="/activity" className="nav-link">
          Activity
        </NavLink>
        <div className="sidebar-version" title={me.version === "dev" ? "Running from source" : `Panel release ${me.version}`}>
          CS2 Panel {me.version === "dev" ? "(development)" : me.version}
        </div>
        <div className="sidebar-foot">
          <NavLink to="/preferences" className="icon-btn" aria-label="Preferences" title="Preferences">
            <GearIcon />
          </NavLink>
          {me.user.avatarUrl ? <img src={me.user.avatarUrl} alt="" /> : <span className="avatar" aria-hidden="true" />}
          <div className="who">
            <div>{name}</div>
            <div className="role">{ROLE_NAMES[me.user.role]}</div>
          </div>
          <button className="icon-btn" onClick={logout} aria-label="Sign out" title="Sign out" style={{ marginLeft: "auto" }}>
            <SignOutIcon />
          </button>
        </div>
      </nav>
      <main className="main">
        {me.dev && (
          <div className="notice warn" style={{ marginBottom: 20 }}>
            Development mode: servers are simulated and nothing runs for real.
          </div>
        )}
        <UpdatedBanner loadedVersion={me.version} />
        <Outlet />
      </main>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

/**
 * A tab keeps the panel version it was opened with. When the panel on the server
 * has been updated since, say so, so nobody tests old code by accident.
 */
function UpdatedBanner({ loadedVersion }: { loadedVersion: string }) {
  const [serverVersion, setServerVersion] = useState(loadedVersion);
  useEffect(() => {
    const check = () => void api.me().then((m) => setServerVersion(m.version), () => undefined);
    const t = setInterval(check, 60_000);
    // Also check when coming back to the tab.
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  if (serverVersion === loadedVersion) return null;
  return (
    <div className="notice info" style={{ marginBottom: 20 }}>
      The panel has been updated to {serverVersion}. This page is still {loadedVersion}.{" "}
      <button className="btn small primary" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
