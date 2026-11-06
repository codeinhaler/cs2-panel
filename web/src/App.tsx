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
        {can("users.manage") && (
          <NavLink to="/team" className="nav-link">
            Team
          </NavLink>
        )}
        <NavLink to="/activity" className="nav-link">
          Activity
        </NavLink>
        <NavLink to="/preferences" className="nav-link">
          Preferences
        </NavLink>
        <div className="sidebar-foot">
          {me.user.avatarUrl ? <img src={me.user.avatarUrl} alt="" /> : <span className="avatar" aria-hidden="true" />}
          <div className="who">
            <div>{name}</div>
            <div className="role">{ROLE_NAMES[me.user.role]}</div>
          </div>
          <button className="btn small ghost" onClick={logout} style={{ marginLeft: "auto" }}>
            Sign out
          </button>
        </div>
      </nav>
      <main className="main">
        {me.dev && (
          <div className="notice warn" style={{ marginBottom: 20 }}>
            Development mode: servers are simulated and nothing runs for real.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
