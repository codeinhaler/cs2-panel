import { useCallback, useEffect, useRef, useState } from "react";
import { api, fullTime, timeAgo, type Ban, type GameAdmin, type ModerationInfo, type OnlinePlayer, type RecentPlayer, type Server } from "../../api";
import { useAction, useApp, usePolling } from "../../app-context";

const DURATIONS = [
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "1 day", minutes: 1440 },
  { label: "1 week", minutes: 10080 },
  { label: "30 days", minutes: 43200 },
  { label: "Permanent", minutes: 0 },
];

function lengthText(minutes: number): string {
  if (minutes === 0) return "Permanent";
  return DURATIONS.find((d) => d.minutes === minutes)?.label ?? (minutes % 1440 === 0 ? `${minutes / 1440} days` : `${minutes} min`);
}

function SteamLink({ id }: { id: string | null }) {
  if (!id) return <span className="hint">unknown</span>;
  return (
    <a href={`https://steamcommunity.com/profiles/${id}`} target="_blank" rel="noreferrer" className="mono">
      {id}
    </a>
  );
}

type Target = { kind: "kick" | "ban"; player: OnlinePlayer } | { kind: "ban-offline"; name: string; steamId: string };

export function PlayersTab({ server }: { server: Server }) {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const [mod, setMod] = useState<ModerationInfo | null>(null);
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [showAllBans, setShowAllBans] = useState(false);
  const [admins, setAdmins] = useState<GameAdmin[] | null>(null);
  const [recent, setRecent] = useState<RecentPlayer[]>([]);
  const [target, setTarget] = useState<Target | null>(null);

  const live = usePolling(() => api.players(server.id), 10_000, [server.id]);

  const loadModeration = useCallback(async () => {
    const info = await api.moderation(server.id);
    setMod(info);
    if (info.provider) {
      const [b, a] = await Promise.all([api.bans(server.id, showAllBans).catch(() => ({ bans: [] })), api.gameAdmins(server.id).catch(() => ({ admins: [] }))]);
      setBans(b.bans);
      setAdmins(a.admins);
    }
  }, [server.id, showAllBans]);

  const loadRecent = useCallback(async () => setRecent((await api.recentPlayers(server.id)).players), [server.id]);

  useEffect(() => {
    void loadModeration().catch((e: Error) => toast(e.message, "error"));
    void loadRecent();
  }, [loadModeration, loadRecent, toast]);

  const afterChange = async () => {
    await Promise.all([loadModeration(), live.refresh(), loadRecent()]);
  };

  const unban = async (b: Ban) => {
    if (!b.steamId || !window.confirm(`Unban ${b.playerName ?? b.steamId}?`)) return;
    if (await run(() => api.unban(server.id, b.steamId!), `Unbanned ${b.playerName ?? b.steamId}.`)) await afterChange();
  };

  const removeAdmin = async (a: GameAdmin) => {
    if (!window.confirm(`Remove ${a.name} as in-game admin?`)) return;
    if (await run(() => api.removeGameAdmin(server.id, a.steamId), `Removed ${a.name} as admin.`)) await afterChange();
  };

  const moderate = can("players.moderate");
  const players = live.data?.players ?? [];
  const humans = players.filter((p) => !p.bot);
  const bots = players.length - humans.length;
  const banned = new Set((bans ?? []).filter((b) => b.status === "active").map((b) => b.steamId));

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Online now</h2>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              {!live.data
                ? "Loading…"
                : !live.data.running
                  ? "The server isn't running."
                  : `${humans.length} ${humans.length === 1 ? "player" : "players"}${bots ? ` and ${bots} ${bots === 1 ? "bot" : "bots"}` : ""}. Updates every 10 seconds.`}
            </p>
          </div>
        </div>
        {live.data?.error && <div className="notice error">Couldn't read the player list: {live.data.error}</div>}
        {humans.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>SteamID</th>
                  <th>Connected</th>
                  <th>Ping</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {humans.map((p) => (
                  <tr key={p.userId}>
                    <td>
                      {p.name}
                      {p.state !== "active" && <span className="hint"> ({p.state})</span>}
                    </td>
                    <td>
                      <SteamLink id={p.steamId} />
                    </td>
                    <td className="mono">{p.time}</td>
                    <td>{p.ping} ms</td>
                    <td>
                      {moderate && (
                        <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                          <button className="btn small" onClick={() => setTarget({ kind: "kick", player: p })}>
                            Kick
                          </button>
                          {mod?.provider && (
                            <button className="btn small danger" onClick={() => setTarget({ kind: "ban", player: p })}>
                              Ban
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {live.data?.running && humans.length > 0 && !mod?.provider && (
          <p className="hint" style={{ marginBottom: 0 }}>
            CS2 doesn't report SteamIDs on its own. Install CS2-SimpleAdmin on the Plugins tab to see them, and to ban players.
          </p>
        )}
      </div>

      {mod && !mod.provider && (
        <div className="panel">
          <h2 style={{ marginBottom: 6 }}>Bans and in-game admins</h2>
          <p className="hint" style={{ margin: 0 }}>
            These need a plugin that provides them. Install CS2-SimpleAdmin on the Plugins tab and they appear here.
          </p>
        </div>
      )}

      {mod?.provider && (
        <>
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
      )}

      <div className="panel">
        <h2 style={{ marginBottom: 6 }}>Recent players</h2>
        <p className="hint" style={{ marginTop: 0 }}>Everyone seen on this server in the last 90 days, newest first.</p>
        {recent.length === 0 && <p className="hint">Nobody yet. Players show up here once they've joined while the panel is running.</p>}
        {recent.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>SteamID</th>
                  <th>Last seen</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={`${r.steamId ?? r.name}`}>
                    <td>{r.name}</td>
                    <td>
                      <SteamLink id={r.steamId} />
                    </td>
                    <td>{r.online ? "Online now" : <span title={fullTime(r.lastSeenAt)}>{timeAgo(r.lastSeenAt)}</span>}</td>
                    <td>
                      {moderate && mod?.provider && r.steamId && !r.online && !banned.has(r.steamId) && (
                        <button className="btn small danger" disabled={!mod.canAct} onClick={() => setTarget({ kind: "ban-offline", name: r.name, steamId: r.steamId! })}>
                          Ban
                        </button>
                      )}
                      {r.steamId && banned.has(r.steamId) && <span className="hint">Banned</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {target && <ActionDialog server={server} target={target} onClose={() => setTarget(null)} onDone={afterChange} />}
    </>
  );
}

function ActionDialog({ server, target, onClose, onDone }: { server: Server; target: Target; onClose: () => void; onDone: () => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { busy, run } = useAction();
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(60);
  useEffect(() => ref.current?.showModal(), []);

  const name = target.kind === "ban-offline" ? target.name : target.player.name;
  const isKick = target.kind === "kick";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let action: () => Promise<unknown>;
    if (target.kind === "ban-offline") {
      const steam = target.steamId;
      action = () => api.ban(server.id, { steam, minutes, reason });
    } else {
      const userId = target.player.userId;
      action = target.kind === "kick" ? () => api.kick(server.id, userId, reason) : () => api.ban(server.id, { userId, minutes, reason });
    }
    const ok = await run(
      action,
      isKick ? `Kicked ${name}.` : `Banned ${name} (${lengthText(minutes).toLowerCase()}).`,
    );
    if (ok) {
      ref.current?.close();
      await onDone();
    }
  };

  return (
    <dialog ref={ref} onClose={onClose}>
      <form onSubmit={submit}>
        <h2>
          {isKick ? "Kick" : "Ban"} {name}
        </h2>
        {!isKick && (
          <label className="field" style={{ marginBottom: 12 }}>
            <span>Length</span>
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d.minutes} value={d.minutes}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Reason</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} autoFocus required={!isKick} placeholder={isKick ? "Optional; shown to the player" : "Shown to the player"} />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button className="btn danger solid" disabled={busy}>
            {isKick ? "Kick" : "Ban"} {name}
          </button>
        </div>
      </form>
    </dialog>
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
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d.minutes} value={d.minutes}>
                {d.label}
              </option>
            ))}
          </select>
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
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d.minutes} value={d.minutes}>
                {d.label}
              </option>
            ))}
          </select>
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
