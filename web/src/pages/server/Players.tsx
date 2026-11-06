import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, fullTime, timeAgo, type BanCoverage, type OnlinePlayer, type PanelBan, type RecentPlayer, type Server } from "../../api";
import { useAction, useApp, usePolling } from "../../app-context";
import { DurationSelect, lengthText, SteamLink } from "../../components/player-bits";

type Target = { kind: "kick" | "ban"; player: OnlinePlayer } | { kind: "ban-offline"; name: string; steamId: string };

export function PlayersTab({ server, bridge }: { server: Server; bridge: boolean }) {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const [bans, setBans] = useState<PanelBan[] | null>(null);
  const [showAllBans, setShowAllBans] = useState(false);
  const [coverage, setCoverage] = useState<BanCoverage | null>(null);
  const [recent, setRecent] = useState<RecentPlayer[]>([]);
  const [target, setTarget] = useState<Target | null>(null);

  const live = usePolling(() => api.players(server.id), 10_000, [server.id]);

  const loadBans = useCallback(async () => {
    const [b, c] = await Promise.all([api.panelBans(showAllBans), api.banCoverage()]);
    setBans(b.bans);
    setCoverage(c);
  }, [showAllBans]);
  const loadRecent = useCallback(async () => setRecent((await api.recentPlayers(server.id)).players), [server.id]);

  useEffect(() => {
    void loadBans().catch((e: Error) => toast(e.message, "error"));
    void loadRecent();
  }, [loadBans, loadRecent, toast]);

  const afterChange = async () => {
    await Promise.all([loadBans(), live.refresh(), loadRecent()]);
  };

  const unban = async (b: PanelBan) => {
    const who = b.name ?? b.steamId;
    if (!window.confirm(`Unban ${who}? They can join every server again.`)) return;
    if (await run(() => api.panelUnban(b.id), `Unbanned ${who}.`)) await afterChange();
  };

  const moderate = can("players.moderate");
  const players = live.data?.players ?? [];
  const humans = players.filter((p) => !p.bot);
  const bots = players.length - humans.length;
  const banned = new Set((bans ?? []).filter((b) => b.status === "active").map((b) => b.steamId));

  return (
    <>
      {!bridge && (
        <div className="notice info" style={{ marginBottom: 16 }}>
          This server doesn't have CS2 Panel Bridge, so it can't show SteamIDs or enforce panel bans. Install it on the{" "}
          <Link to={`/servers/${server.id}/plugins`}>Plugins tab</Link>; it needs CounterStrikeSharp, which is added with it if missing. Kicking works either way.
        </div>
      )}

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
                          <button
                            className="btn small danger"
                            disabled={!p.steamId}
                            title={p.steamId ? undefined : "The SteamID isn't known yet, so this player can't be banned from here."}
                            onClick={() => setTarget({ kind: "ban", player: p })}
                          >
                            Ban
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

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Bans</h2>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              One list for all your servers. Banned players are kicked as soon as they join.
              {coverage && coverage.missing.length > 0 && <> Not enforced on {coverage.missing.map((s) => s.name).join(", ")} (no bridge plugin).</>}
            </p>
          </div>
          <label className="check">
            <input type="checkbox" checked={showAllBans} onChange={(e) => setShowAllBans(e.target.checked)} />
            <span className="hint">Show expired and lifted bans</span>
          </label>
        </div>
        {moderate && <SteamBanForm onDone={afterChange} />}
        {bans && bans.length === 0 && <p className="hint">No {showAllBans ? "" : "active "}bans.</p>}
        {bans && bans.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Reason</th>
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
                      {b.name ?? <span className="hint">Name unknown</span>}
                      <small style={{ display: "block" }}>
                        <SteamLink id={b.steamId} />
                      </small>
                    </td>
                    <td>
                      {b.reason}
                      <small className="hint" style={{ display: "block" }}>
                        by {b.createdBy ?? "unknown"}
                        {b.serverName && <> on {b.serverName}</>}, <span title={fullTime(b.createdAt)}>{timeAgo(b.createdAt)}</span>
                      </small>
                    </td>
                    <td>
                      {b.status === "unbanned" ? (
                        <span title={b.revokeReason ?? undefined}>Lifted by {b.revokedBy ?? "unknown"}</span>
                      ) : b.status === "expired" ? (
                        "Expired"
                      ) : b.expiresAt ? (
                        fullTime(b.expiresAt)
                      ) : (
                        "Never"
                      )}
                    </td>
                    <td>
                      {moderate && b.status === "active" && (
                        <button className="btn small" disabled={busy} onClick={() => void unban(b)}>
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
                      {r.steamId && banned.has(r.steamId) ? (
                        <span className="hint">Banned</span>
                      ) : (
                        moderate &&
                        r.steamId &&
                        !r.online && (
                          <button className="btn small danger" onClick={() => setTarget({ kind: "ban-offline", name: r.name, steamId: r.steamId! })}>
                            Ban
                          </button>
                        )
                      )}
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

function coverageNote(c: BanCoverage): string | null {
  if (c.missing.length === 0) return null;
  return ` Not enforced on ${c.missing.map((s) => s.name).join(", ")}.`;
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
      action = () => api.panelBan({ steam, name, minutes, reason, serverId: server.id });
    } else {
      const userId = target.player.userId;
      action = isKick ? () => api.kick(server.id, userId, reason) : () => api.panelBan({ serverId: server.id, userId, minutes, reason });
    }
    const ok = await run(action, isKick ? `Kicked ${name}.` : `Banned ${name} (${lengthText(minutes).toLowerCase()}).`);
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
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              The ban applies on all your servers.
            </p>
            <label className="field" style={{ marginBottom: 12 }}>
              <span>Length</span>
              <DurationSelect value={minutes} onChange={setMinutes} />
            </label>
          </>
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

function SteamBanForm({ onDone }: { onDone: () => Promise<void> }) {
  const { busy, run } = useAction();
  const { toast } = useApp();
  const box = useRef<HTMLDetailsElement>(null);
  const [steam, setSteam] = useState("");
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState(0);
  const [reason, setReason] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let note: string | null = null;
    const ok = await run(async () => {
      const r = await api.panelBan({ steam, name: name || undefined, minutes, reason });
      note = coverageNote(r.coverage);
    }, "Ban added.");
    if (ok) {
      if (note) toast(`Ban added.${note}`, "info");
      setSteam("");
      setName("");
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
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="Optional, to recognise them" />
        </label>
        <label className="field">
          <span>Length</span>
          <DurationSelect value={minutes} onChange={setMinutes} />
        </label>
        <label className="field">
          <span>Reason</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} required />
        </label>
        <div className="wide">
          <button className="btn danger" disabled={busy}>
            Add ban
          </button>
        </div>
      </form>
    </details>
  );
}
