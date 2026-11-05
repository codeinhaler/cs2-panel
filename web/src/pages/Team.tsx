import { useEffect, useState } from "react";
import { api, timeAgo, type User } from "../api";
import { useAction, useApp } from "../app-context";

const ROLE_HELP = {
  admin: "Admins run servers, edit configs, create servers and update CS2.",
  moderator: "Moderators can watch servers and handle players.",
};

export function TeamPage() {
  const { can, me } = useApp();
  const { busy, run } = useAction();
  const [users, setUsers] = useState<User[] | null>(null);
  const [steam, setSteam] = useState("");
  const [role, setRole] = useState<"admin" | "moderator">("admin");

  const load = () => api.users().then((r) => setUsers(r.users));
  useEffect(() => {
    void load();
  }, []);

  if (!can("users.manage")) return <div className="notice error">Only the Owner manages the team.</div>;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.addUser(steam, role));
    if (r) {
      setSteam("");
      await load();
    }
  };

  const update = async (u: User, changes: { role?: "admin" | "moderator"; disabled?: boolean }) => {
    if (await run(() => api.updateUser(u.id, changes))) await load();
  };

  const remove = async (u: User) => {
    if (!window.confirm(`Remove ${u.displayName ?? u.steamId} from the team? They'll be signed out right away.`)) return;
    if (await run(() => api.removeUser(u.id))) await load();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p>People who can sign in to the panel with Steam.</p>
        </div>
      </div>

      <form className="panel" onSubmit={add}>
        <h2 style={{ marginBottom: 14 }}>Add someone</h2>
        <div className="form-grid">
          <label className="field">
            <span>Steam profile</span>
            <input
              value={steam}
              onChange={(e) => setSteam(e.target.value)}
              placeholder="Profile URL or SteamID64"
              required
              spellCheck={false}
            />
            <small>Paste their steamcommunity.com profile link, or their 17-digit SteamID64.</small>
          </label>
          <label className="field">
            <span>Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "moderator")}>
              <option value="admin">Admin</option>
              <option value="moderator">Moderator</option>
            </select>
            <small>{ROLE_HELP[role]}</small>
          </label>
        </div>
        <div className="row-actions" style={{ marginTop: 16 }}>
          <button className="btn primary" disabled={busy || !steam.trim()}>
            Add to team
          </button>
        </div>
      </form>

      <div className="panel">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Last sign-in</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users?.map((u) => (
                <tr key={u.id} style={u.disabled ? { opacity: 0.6 } : undefined}>
                  <td>
                    <div className="person">
                      {u.avatarUrl ? <img className="avatar" src={u.avatarUrl} alt="" /> : <span className="avatar" aria-hidden="true" />}
                      <div>
                        {u.displayName ?? "Unknown name"}
                        {u.id === me.user.id && " (you)"}
                        <small>
                          <a href={`https://steamcommunity.com/profiles/${u.steamId}`} target="_blank" rel="noreferrer">
                            {u.steamId}
                          </a>
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    {u.role === "owner" ? (
                      "Owner"
                    ) : (
                      <select
                        value={u.role}
                        onChange={(e) => void update(u, { role: e.target.value as "admin" | "moderator" })}
                        aria-label={`Role for ${u.displayName ?? u.steamId}`}
                        style={{ width: "auto" }}
                      >
                        <option value="admin">Admin</option>
                        <option value="moderator">Moderator</option>
                      </select>
                    )}
                    {u.disabled && <div className="hint">Disabled</div>}
                  </td>
                  <td>{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "Not yet"}</td>
                  <td>
                    {u.role !== "owner" && (
                      <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                        <button className="btn small" onClick={() => void update(u, { disabled: !u.disabled })} disabled={busy}>
                          {u.disabled ? "Enable" : "Disable"}
                        </button>
                        <button className="btn small danger" onClick={() => void remove(u)} disabled={busy}>
                          Remove
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
