import { useCallback, useEffect, useRef, useState } from "react";
import { api, fullTime, timeAgo, type Ban, type GameAdmin, type ModerationInfo, type Server } from "../../api";
import { useAction, useApp } from "../../app-context";
import { DurationSelect, lengthText, SteamLink } from "../../components/player-bits";

/** The tab a moderation plugin (CS2-SimpleAdmin) brings: its own bans and in-game admins. */
export function ModerationTab({ server, label }: { server: Server; label: string }) {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const [mod, setMod] = useState<ModerationInfo | null>(null);
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [showAllBans, setShowAllBans] = useState(false);
  const [admins, setAdmins] = useState<GameAdmin[] | null>(null);

  const load = useCallback(async () => {
    const info = await api.moderation(server.id);
    setMod(info);
    if (info.provider) {
      const [b, a] = await Promise.all([api.bans(server.id, showAllBans).catch(() => ({ bans: [] })), api.gameAdmins(server.id).catch(() => ({ admins: [] }))]);
      setBans(b.bans);
      setAdmins(a.admins);
    }
  }, [server.id, showAllBans]);

  useEffect(() => {
    void load().catch((e: Error) => toast(e.message, "error"));
  }, [load, toast]);

  const afterChange = load;

  const unban = async (b: Ban) => {
    if (!b.steamId || !window.confirm(`Unban ${b.playerName ?? b.steamId}?`)) return;
    if (await run(() => api.unban(server.id, b.steamId!), `Unbanned ${b.playerName ?? b.steamId}.`)) await afterChange();
  };

  const removeAdmin = async (a: GameAdmin) => {
    if (!window.confirm(`Remove ${a.name} as in-game admin?`)) return;
    if (await run(() => api.removeGameAdmin(server.id, a.steamId), `Removed ${a.name} as admin.`)) await afterChange();
  };

  const moderate = can("players.moderate");
  if (!mod) return <p className="hint">Loading…</p>;
  if (!mod.provider) return <div className="notice info">{label} isn't installed on this server anymore.</div>;

  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        This tab is here because {mod.provider} is installed. Its bans and admins are its own: in-game commands like !ban add to these lists.
        Bans made on the Players tab belong to the panel and work without {label}.
      </p>
      {mod.error && <div className="notice error" style={{ marginBottom: 16 }}>Couldn't read {mod.provider}'s data: {mod.error}</div>}
      {!mod.canAct && (
        <div className="notice info" style={{ marginBottom: 16 }}>
          The server is stopped. You can look at bans and admins, but changes need the server running because {mod.provider} makes them.
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Bans</h2>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              Managed by {mod.provider}. {mod.shared ? "Shared by every server that uses the same database." : "These apply to this server only."}
            </p>
          </div>
          <label className="check">
            <input type="checkbox" checked={showAllBans} onChange={(e) => setShowAllBans(e.target.checked)} />
            <span className="hint">Show expired and lifted bans</span>
          </label>
        </div>
        {moderate && <OfflineBanForm server={server} disabled={!mod.canAct} onDone={afterChange} />}
        {bans && bans.length === 0 && <p className="hint">No {showAllBans ? "" : "active "}bans.</p>}
        {bans && bans.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Reason</th>
                  <th>Length</th>
                  <th>Ends</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {bans.map((b) => (
                  <tr key={b.id} style={b.status !== "active" ? { opacity: 0.6 } : undefined}>
                    <td>
                      {b.playerName ?? <span className="hint">Name unknown</span>}
                      <small style={{ display: "block" }}>
                        <SteamLink id={b.steamId} />
                      </small>
                    </td>
                    <td>
                      {b.reason}
                      <small className="hint" style={{ display: "block" }}>
                        by {b.adminName || "unknown"}, <span title={fullTime(b.createdAt)}>{timeAgo(b.createdAt)}</span>
                      </small>
                    </td>
                    <td>{lengthText(b.duration)}</td>
                    <td>{b.status === "unbanned" ? "Lifted" : b.status === "expired" ? "Expired" : b.endsAt ? fullTime(b.endsAt) : "Never"}</td>
                    <td>
                      {moderate && b.status === "active" && b.steamId && (
                        <button className="btn small" disabled={busy || !mod.canAct} onClick={() => void unban(b)}>
                          Unban
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2 style={{ marginBottom: 6 }}>In-game admins</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          People who can use {mod.provider}'s commands in game (like !admin). This is separate from who can use this panel.
        </p>
        {can("gameadmins.manage") && <AddAdminForm server={server} presets={mod.flagPresets} disabled={!mod.canAct} onDone={afterChange} />}
        {admins && admins.length === 0 && <p className="hint">No in-game admins yet.</p>}
        {admins && admins.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Admin</th>
                  <th>Permissions</th>
                  <th>Immunity</th>
                  <th>Until</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => (
                  <tr key={a.steamId}>
                    <td>
                      {a.name}
                      <small style={{ display: "block" }}>
                        <SteamLink id={a.steamId} />
                      </small>
                    </td>
                    <td>
                      {a.group && <div>Group: {a.group}</div>}
                      <span className="mono">{a.flags.join(", ") || "none"}</span>
                    </td>
                    <td>{a.immunity}</td>
                    <td>{a.endsAt ? fullTime(a.endsAt) : "Permanent"}</td>
                    <td>
                      {can("gameadmins.manage") && (
                        <button className="btn small danger" disabled={busy || !mod.canAct} onClick={() => void removeAdmin(a)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function OfflineBanForm({ server, disabled, onDone }: { server: Server; disabled: boolean; onDone: () => Promise<void> }) {
  const { busy, run } = useAction();
  const box = useRef<HTMLDetailsElement>(null);
  const [steam, setSteam] = useState("");
  const [minutes, setMinutes] = useState(0);
  const [reason, setReason] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => api.ban(server.id, { steam, minutes, reason }), "Ban added.")) {
      setSteam("");
      setReason("");
      if (box.current) box.current.open = false;
      await onDone();
    }
  };
  return (
    <details className="inline-form" ref={box}>
      <summary className="btn small">Ban by SteamID</summary>
      <form onSubmit={submit} className="form-grid" style={{ marginTop: 12 }}>
        <label className="field">
          <span>Steam profile</span>
          <input value={steam} onChange={(e) => setSteam(e.target.value)} placeholder="Profile URL or SteamID64" required spellCheck={false} />
        </label>
        <label className="field">
          <span>Length</span>
          <DurationSelect value={minutes} onChange={setMinutes} />
        </label>
        <label className="field wide">
          <span>Reason</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} required />
        </label>
        <div className="wide">
          <button className="btn danger" disabled={busy || disabled}>
            Add ban
          </button>
        </div>
      </form>
    </details>
  );
}

function AddAdminForm({ server, presets, disabled, onDone }: { server: Server; presets: { label: string; flags: string }[]; disabled: boolean; onDone: () => Promise<void> }) {
  const { busy, run } = useAction();
  const box = useRef<HTMLDetailsElement>(null);
  const [steam, setSteam] = useState("");
  const [name, setName] = useState("");
  const [preset, setPreset] = useState(presets[0]?.flags ?? "custom");
  const [custom, setCustom] = useState("");
  const [immunity, setImmunity] = useState("50");
  const [minutes, setMinutes] = useState(0);
  const flags = preset === "custom" ? custom : preset;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => api.addGameAdmin(server.id, { steam, name, flags, immunity: Number(immunity), minutes }), `Added ${name} as admin.`)) {
      setSteam("");
      setName("");
      if (box.current) box.current.open = false;
      await onDone();
    }
  };
  return (
    <details className="inline-form" ref={box}>
      <summary className="btn small">Add admin</summary>
      <form onSubmit={submit} className="form-grid" style={{ marginTop: 12 }}>
        <label className="field">
          <span>Steam profile</span>
          <input value={steam} onChange={(e) => setSteam(e.target.value)} placeholder="Profile URL or SteamID64" required spellCheck={false} />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required />
        </label>
        <label className="field">
          <span>Permissions</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {presets.map((p) => (
              <option key={p.flags} value={p.flags}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom flags…</option>
          </select>
          {preset === "custom" && (
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="@css/generic,@css/kick" style={{ marginTop: 6 }} required spellCheck={false} />
          )}
        </label>
        <label className="field">
          <span>Immunity</span>
          <input inputMode="numeric" value={immunity} onChange={(e) => setImmunity(e.target.value)} />
          <small>0–100. Admins can't target admins with higher immunity.</small>
        </label>
        <label className="field">
          <span>For how long</span>
          <DurationSelect value={minutes} onChange={setMinutes} />
        </label>
        <div className="wide">
          <button className="btn primary" disabled={busy || disabled}>
            Add admin
          </button>
        </div>
      </form>
    </details>
  );
}
