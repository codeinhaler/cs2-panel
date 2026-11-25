import { useEffect, useState } from "react";
import { api, fullTime, type InGameAdmin, type InGameInfo, type InGameRole, type Server } from "../api";
import { useAction, useApp } from "../app-context";

/** People who may use the CS2 Panel Bridge's in-game menu (!panel), their roles, and extra maps for its map list. */
export function InGameAdminsPage() {
  const { can } = useApp();
  const { busy, run } = useAction();
  const [info, setInfo] = useState<InGameInfo | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const manage = can("gameadmins.manage");

  const load = () => api.ingame().then(setInfo);
  useEffect(() => {
    void load();
    void api.servers().then((r) => setServers(r.servers));
  }, []);

  if (!info) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>In-game admins</h1>
          <p>
            People who may use the admin menu in the game: they type <code>!panel</code> in chat on a server. Each person gets a role for one server or every
            server; a role decides what they may do.
          </p>
        </div>
      </div>

      {info.coverage.missing.length > 0 && (
        <div className="notice info" style={{ marginBottom: 16 }}>
          The menu works on servers with the CS2 Panel Bridge plugin. Without it: {info.coverage.missing.map((s) => s.name).join(", ")}.
        </div>
      )}
      {!manage && <div className="notice info">Only the Owner can change in-game admins and roles.</div>}

      <PeoplePanel info={info} servers={servers} manage={manage} busy={busy} run={run} reload={load} />
      <RolesPanel info={info} manage={manage} busy={busy} run={run} reload={load} />
      <MapsPanel info={info} manage={manage} busy={busy} run={run} reload={load} />
    </>
  );
}

type Run = ReturnType<typeof useAction>["run"];
interface PanelProps {
  info: InGameInfo;
  manage: boolean;
  busy: boolean;
  run: Run;
  reload: () => Promise<void>;
}

// ------------------------------------------------------------- people

interface PersonForm {
  steam: string;
  name: string;
  roleId: number;
  serverId: number | null;
  expires: string;
}

/** "2026-12-01T18:00" for a datetime-local input, in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function PeoplePanel({ info, servers, manage, busy, run, reload }: PanelProps & { servers: Server[] }) {
  const empty = (): PersonForm => ({ steam: "", name: "", roleId: info.roles[0]?.id ?? 0, serverId: null, expires: "" });
  const [form, setForm] = useState<PersonForm>(empty);
  const [editing, setEditing] = useState<number | null>(null);
  const set = <K extends keyof PersonForm>(k: K, v: PersonForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = {
      steam: form.steam,
      name: form.name,
      roleId: form.roleId,
      serverId: form.serverId,
      expiresAt: form.expires ? new Date(form.expires).toISOString() : null,
    };
    const r = await run(
      () => api.saveIngameAdmin(editing, input),
      editing === null ? "Added. Servers get it within a minute." : "Saved. Servers get it within a minute.",
    );
    if (r) {
      setForm(empty());
      setEditing(null);
      await reload();
    }
  };
  const edit = (a: InGameAdmin) => {
    setEditing(a.id);
    setForm({ steam: a.steamId, name: a.name, roleId: a.roleId, serverId: a.serverId, expires: toLocalInput(a.expiresAt) });
  };
  const remove = async (a: InGameAdmin) => {
    if (!window.confirm(`Take ${a.name || a.steamId}'s ${a.roleName} role away${a.serverName ? ` on ${a.serverName}` : ""}?`)) return;
    if (await run(() => api.deleteIngameAdmin(a.id))) await reload();
  };
  const role = info.roles.find((r) => r.id === form.roleId);

  return (
    <div className="panel">
      <h2 style={{ marginBottom: 14 }}>People</h2>
      {manage && (
        <form onSubmit={(e) => void save(e)} style={{ marginBottom: 18 }}>
          <div className="form-grid">
            <label className="field">
              <span>Steam profile</span>
              <input value={form.steam} onChange={(e) => set("steam", e.target.value)} placeholder="Profile URL or SteamID64" required spellCheck={false} />
              <small>Their steamcommunity.com profile link, or the 17-digit SteamID64.</small>
            </label>
            <label className="field">
              <span>Name</span>
              <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={64} placeholder="So you know who it is" />
            </label>
            <label className="field">
              <span>Role</span>
              <select value={form.roleId} onChange={(e) => set("roleId", Number(e.target.value))}>
                {info.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              {role && <small>{role.perms.map((p) => info.perms.find((x) => x.id === p)?.label ?? p).join(", ")}</small>}
            </label>
            <label className="field">
              <span>Server</span>
              <select value={form.serverId ?? ""} onChange={(e) => set("serverId", e.target.value ? Number(e.target.value) : null)}>
                <option value="">Every server</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Until (optional)</span>
              <input type="datetime-local" value={form.expires} onChange={(e) => set("expires", e.target.value)} />
              <small>Leave empty to keep it until you take it away.</small>
            </label>
          </div>
          <div className="row-actions" style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={busy || !form.steam.trim() || !form.roleId}>
              {editing === null ? "Add" : "Save"}
            </button>
            {editing !== null && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setEditing(null);
                  setForm(empty());
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      {info.admins.length === 0 ? (
        <p className="hint">Nobody yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Server</th>
                <th>Until</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {info.admins.map((a) => (
                <tr key={a.id} style={a.expired ? { opacity: 0.6 } : undefined}>
                  <td>
                    {a.name || "No name"}
                    <div className="hint">
                      <a href={`https://steamcommunity.com/profiles/${a.steamId}`} target="_blank" rel="noreferrer">
                        {a.steamId}
                      </a>
                    </div>
                  </td>
                  <td>{a.roleName}</td>
                  <td>{a.serverName ?? "Every server"}</td>
                  <td>
                    {a.expiresAt ? <span title={fullTime(a.expiresAt)}>{a.expired ? `Ended ${fullTime(a.expiresAt)}` : fullTime(a.expiresAt)}</span> : "—"}
                  </td>
                  <td>
                    {manage && (
                      <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                        <button className="btn small" onClick={() => edit(a)} disabled={busy}>
                          Edit
                        </button>
                        <button className="btn small danger" onClick={() => void remove(a)} disabled={busy}>
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
      )}
    </div>
  );
}

// ------------------------------------------------------------- roles

function RolesPanel({ info, manage, busy, run, reload }: PanelProps) {
  const [editing, setEditing] = useState<{ id: number | null; name: string; perms: string[] } | null>(null);

  const save = async () => {
    if (!editing) return;
    const r = await run(() => api.saveIngameRole(editing.id, { name: editing.name, perms: editing.perms }), "Role saved.");
    if (r) {
      setEditing(null);
      await reload();
    }
  };
  const remove = async (r: InGameRole) => {
    if (!window.confirm(`Delete the role ${r.name}?`)) return;
    if (await run(() => api.deleteIngameRole(r.id))) await reload();
  };
  const toggle = (perm: string, on: boolean) => setEditing((e) => (e ? { ...e, perms: on ? [...e.perms, perm] : e.perms.filter((p) => p !== perm) } : e));

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Roles</h2>
          <p className="hint" style={{ margin: "4px 0 0" }}>
            What each role may do in the menu. Changes reach the servers within a minute.
          </p>
        </div>
        {manage && !editing && (
          <button className="btn small" onClick={() => setEditing({ id: null, name: "", perms: [] })} disabled={busy}>
            New role
          </button>
        )}
      </div>

      {editing && (
        <div style={{ background: "var(--panel-sunk)", border: "1px solid var(--line-soft)", borderRadius: 8, padding: 14, marginTop: 12 }}>
          <label className="field" style={{ maxWidth: 360 }}>
            <span>Name</span>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={40} autoFocus />
          </label>
          <fieldset className="choice-list" style={{ marginTop: 12 }}>
            <legend className="visually-hidden">May do</legend>
            {info.perms.map((p) => (
              <label key={p.id} className="choice">
                <input type="checkbox" checked={editing.perms.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
                <span>
                  {p.label}
                  <small className="hint" style={{ display: "block" }}>
                    {p.hint}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="row-actions" style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={() => void save()} disabled={busy || !editing.name.trim() || editing.perms.length === 0}>
              Save role
            </button>
            <button className="btn ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Role</th>
              <th>May</th>
              <th>People</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {info.roles.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.perms.map((p) => info.perms.find((x) => x.id === p)?.label ?? p).join(", ")}</td>
                <td>{r.people}</td>
                <td>
                  {manage && (
                    <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                      <button className="btn small" onClick={() => setEditing({ id: r.id, name: r.name, perms: [...r.perms] })} disabled={busy}>
                        Edit
                      </button>
                      <button
                        className="btn small danger"
                        onClick={() => void remove(r)}
                        disabled={busy || r.people > 0}
                        title={r.people > 0 ? "Give its people another role first" : undefined}
                      >
                        Delete
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
  );
}

// ------------------------------------------------------------- maps

function MapsPanel({ info, manage, busy, run, reload }: PanelProps) {
  const [id, setId] = useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = /(\d{3,20})/.exec(id)?.[1] ?? id.trim();
    if (await run(() => api.addIngameMap(clean))) {
      setId("");
      await reload();
    }
  };
  const remove = async (mapId: string) => {
    if (await run(() => api.removeIngameMap(mapId))) await reload();
  };

  return (
    <div className="panel">
      <h2 style={{ marginBottom: 6 }}>Maps in the menu</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Change map lists each server's maps by name: the built-in CS2 maps, plus the Workshop maps the server already uses (its start map, its map cycle and the
        matchmaking lobbies it serves). Add more Workshop maps here to offer them on every server.
      </p>
      {manage && (
        <form className="row-actions" onSubmit={(e) => void add(e)} style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Workshop link or ID" style={{ maxWidth: 320 }} spellCheck={false} />
          <button className="btn" disabled={busy || !/\d{3,20}/.test(id)}>
            Add Workshop map
          </button>
        </form>
      )}
      {info.maps.length === 0 ? (
        <p className="hint">No extra Workshop maps.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
          {info.maps.map((m) => (
            <li key={m.id} className="row-actions" style={{ justifyContent: "space-between" }}>
              <span>
                {m.title ?? `Workshop map ${m.id}`} <span className="hint">{m.id}</span>
              </span>
              {manage && (
                <button className="btn small ghost" onClick={() => void remove(m.id)} disabled={busy}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
