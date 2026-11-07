import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type MatchmakingInfo, type MatchmakingSettings, type MmRating } from "../api";
import { useAction, useApp, usePolling } from "../app-context";
import { formatDateTime } from "../format";

const SOURCE = { leetify: "Leetify", self: "self-set", admin: "set by you", none: "no rating", bot: "bot" } as const;
const PHASE = {
  veto: "Banning maps",
  side: "Picking sides",
  starting: "Starting",
  live: "On the server",
  over: "Finished",
  cancelled: "Cancelled",
  abandoned: "Ended",
} as const;

const mapLabel = (m: string) => (m.startsWith("workshop:") ? `Workshop ${m.slice(9)}` : m);
const utc = (t: string) => new Date(`${t.replace(" ", "T")}Z`);

/** The matchmaking site for players: settings, who's in the lobby, matches. */
export function MatchmakingPage() {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const { data, refresh } = usePolling(() => api.matchmaking(), 4000);
  const [form, setForm] = useState<MatchmakingSettings | null>(null);
  const [saved, setSaved] = useState<MatchmakingSettings | null>(null);
  const [key, setKey] = useState("");

  useEffect(() => {
    if (data && !saved) {
      setSaved(data.settings);
      setForm(data.settings);
    }
  }, [data, saved]);

  if (!data || !form || !saved) return null;
  const manage = can("server.manage");
  const moderate = can("players.moderate");
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const set = <K extends keyof MatchmakingSettings>(k: K, v: MatchmakingSettings[K]) => setForm({ ...form, [k]: v });

  const save = async (e: React.FormEvent, leetifyKey?: string | null) => {
    e.preventDefault();
    const r = await run(() => api.saveMatchmaking(form, leetifyKey));
    if (!r) return;
    setSaved(r.settings);
    setForm(r.settings);
    setKey("");
    if (r.site.error) toast(`Saved, but the site couldn't start: ${r.site.error}`, "warn");
    else toast(r.settings.enabled ? `Saved. The matchmaking site is open on port ${r.site.port}.` : "Saved. The matchmaking site is closed.", "ok");
    void refresh();
  };

  const pageUrl = data.site.port ? `http://${window.location.hostname}:${data.site.port}` : null;
  const poolServers = data.servers.filter((s) => form.serverIds.includes(s.id));
  const missingBridge = poolServers.filter((s) => !s.hasBridge);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Matchmaking</h1>
          <p>A page where players sign in with Steam, get put in even teams by their Premier rating, ban maps and join a server.</p>
        </div>
      </div>

      <SiteStatus info={data} pageUrl={pageUrl} />

      <form onSubmit={(e) => save(e)}>
        <div className="panel">
          <h2 style={{ marginBottom: 14 }}>Settings</h2>
          <div className="form-grid">
            <label className="check wide">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} disabled={!manage} />
              <span>
                <b>Matchmaking site is open</b>
                <br />
                <span className="hint">When it's off, the page isn't served at all. Running matches finish either way.</span>
              </span>
            </label>
            <label className="field">
              <span>Name on the page</span>
              <input value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={60} disabled={!manage} />
            </label>
            <label className="field">
              <span>Port</span>
              <input type="number" min={1024} max={65535} value={form.port} onChange={(e) => set("port", Number(e.target.value))} disabled={!manage} />
              <small>Players open the page on this port. Forward it (TCP) on your router to let people outside your network in.</small>
            </label>
            <label className="field">
              <span>Address players connect to</span>
              <input value={form.gameAddress} onChange={(e) => set("gameAddress", e.target.value)} placeholder="Same as the page" disabled={!manage} />
              <small>Leave empty to use the address people opened the page with. Set it if they reach the page through another name than the servers.</small>
            </label>
            <label className="field">
              <span>Seconds per ban</span>
              <input
                type="number"
                min={10}
                max={120}
                value={form.vetoSeconds}
                onChange={(e) => set("vetoSeconds", Number(e.target.value))}
                disabled={!manage}
              />
              <small>A captain who runs out of time bans a random map. Also the time to pick a side.</small>
            </label>
          </div>
        </div>

        <div className="panel">
          <h2 style={{ marginBottom: 6 }}>Servers for matches</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            A free server from these is used for each match: started if it's stopped, set to Competitive on the voted map, locked to the match's players with a
            password, and opened again when the match ends. Pick servers nobody else plays on during the event.
          </p>
          <div className="exec-list">
            {data.servers.length === 0 && <span className="hint">No servers yet.</span>}
            {data.servers.map((s) => (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={form.serverIds.includes(s.id)}
                  onChange={(e) => set("serverIds", e.target.checked ? [...form.serverIds, s.id] : form.serverIds.filter((x) => x !== s.id))}
                  disabled={!manage}
                />
                <span>
                  <Link to={`/servers/${s.id}`}>{s.name}</Link> <span className="hint">port {s.port}</span>
                  {!s.hasBridge && <span className="hint"> · needs CounterStrikeSharp (with CS2 Panel Bridge) installed</span>}
                </span>
              </label>
            ))}
          </div>
          {missingBridge.length > 0 && (
            <p className="notice warn" style={{ marginTop: 12 }}>
              {missingBridge.map((s) => s.name).join(", ")} can't be used until CounterStrikeSharp is installed on its Plugins tab. The CS2 Panel Bridge comes
              with it and keeps strangers off the server during a match.
            </p>
          )}
        </div>

        <div className="panel">
          <h2 style={{ marginBottom: 6 }}>Lobbies</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Players pick one of the open lobbies when they come to the page. Each has its own map pool: the captains take turns banning from it until one is
            left, like on FACEIT, and the team that didn't make the last ban picks its side.
          </p>
          <div className="mm-lobbies">
            {MODES.map((mode) => (
              <LobbySettings
                key={mode}
                mode={mode}
                value={form.modes[mode]}
                stock={data.maps}
                manage={manage}
                onChange={(v) => set("modes", { ...form.modes, [mode]: v })}
              />
            ))}
          </div>
          <label className="field" style={{ marginTop: 16, maxWidth: 320 }}>
            <span>Bot for odd numbers</span>
            <select value={form.botDifficulty} onChange={(e) => set("botDifficulty", Number(e.target.value))} disabled={!manage}>
              {BOT_LEVELS.map((b, i) => (
                <option key={b.label} value={i}>
                  {b.label} (counts as {b.rating.toLocaleString("en")})
                </option>
              ))}
            </select>
            <small>With an odd number of players in Competitive or Wingman, a bot joins the smaller team so nobody sits out.</small>
          </label>
        </div>

        {manage && (
          <div className="row-actions" style={{ margin: "16px 0" }}>
            <button className="btn primary" disabled={busy || !dirty}>
              Save
            </button>
            {dirty && (
              <button type="button" className="btn ghost" onClick={() => setForm(saved)}>
                Undo changes
              </button>
            )}
          </div>
        )}
      </form>

      <div className="panel">
        <h2 style={{ marginBottom: 6 }}>Leetify</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Premier ratings come from Leetify's public API; players Leetify doesn't know can type in their own. It works without a key, but a key from{" "}
          <a href="https://leetify.com/app/developer" target="_blank" rel="noreferrer">
            leetify.com/app/developer
          </a>{" "}
          gets higher limits. Leetify's data isn't stored, as their rules ask; it's looked up again when needed.
        </p>
        {manage ? (
          <form className="row-actions" onSubmit={(e) => save(e, key)}>
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={data.leetifyKeyHint ? `Key set (${data.leetifyKeyHint})` : "Leetify API key"}
              style={{ maxWidth: 320 }}
              aria-label="Leetify API key"
            />
            <button className="btn" disabled={busy || !key.trim()}>
              {data.leetifyKeyHint ? "Replace key" : "Save key"}
            </button>
            {data.leetifyKeyHint && (
              <button type="button" className="btn ghost danger" disabled={busy} onClick={(e) => save(e, null)}>
                Remove key
              </button>
            )}
          </form>
        ) : (
          <p className="hint">{data.leetifyKeyHint ? `A key is set (${data.leetifyKeyHint}).` : "No key set."}</p>
        )}
      </div>

      <LiveSection info={data} moderate={moderate} refresh={refresh} />
      <HistorySection info={data} />
    </div>
  );
}

const MODES = ["competitive", "wingman", "duel"] as const;
const MODE_TEXT = {
  competitive: { label: "Competitive", size: "up to 5v5", hint: "Classic maps." },
  wingman: { label: "Wingman", size: "2v2", hint: "Wingman maps; short halves." },
  duel: { label: "1v1", size: "1v1", hint: "Runs in Wingman mode. Aim maps from the Workshop work well." },
} as const;
const BOT_LEVELS = [
  { label: "Easy", rating: 3000 },
  { label: "Normal", rating: 6000 },
  { label: "Hard", rating: 9000 },
  { label: "Expert", rating: 12000 },
];

function LobbySettings({
  mode,
  value,
  stock,
  manage,
  onChange,
}: {
  mode: (typeof MODES)[number];
  value: { enabled: boolean; maps: string[] };
  stock: string[];
  manage: boolean;
  onChange: (v: { enabled: boolean; maps: string[] }) => void;
}) {
  const [workshop, setWorkshop] = useState("");
  const text = MODE_TEXT[mode];
  // Maps from the install, plus whatever is in the pool that isn't installed (Workshop maps).
  const installed = stock.filter((m) => /^(de|cs|ar|aim)_/.test(m));
  const choices = [...installed, ...value.maps.filter((m) => !installed.includes(m))];
  const toggle = (m: string, on: boolean) => onChange({ ...value, maps: on ? [...value.maps, m] : value.maps.filter((x) => x !== m) });
  return (
    <div className={`mm-lobby ${value.enabled ? "" : "off"}`}>
      <label className="check">
        <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} disabled={!manage} />
        <span>
          <b>{text.label}</b> <span className="hint">{text.size}</span>
          <br />
          <span className="hint">{text.hint}</span>
        </span>
      </label>
      {value.enabled && (
        <>
          <div className="mm-maps">
            {choices.map((m) => (
              <label key={m} className="check">
                <input type="checkbox" checked={value.maps.includes(m)} onChange={(e) => toggle(m, e.target.checked)} disabled={!manage} />
                <span>{mapLabel(m)}</span>
              </label>
            ))}
          </div>
          {manage && (
            <div className="row-actions" style={{ marginTop: 10 }}>
              <input
                value={workshop}
                onChange={(e) => setWorkshop(e.target.value)}
                placeholder="Workshop map ID or link"
                style={{ maxWidth: 240 }}
                aria-label={`Workshop map for ${text.label}`}
              />
              <button
                type="button"
                className="btn small"
                disabled={!/\d{5,20}/.test(workshop)}
                onClick={() => {
                  const id = /(\d{5,20})/.exec(workshop)![1];
                  if (!value.maps.includes(`workshop:${id}`)) onChange({ ...value, maps: [...value.maps, `workshop:${id}`] });
                  setWorkshop("");
                }}
              >
                Add Workshop map
              </button>
            </div>
          )}
          <p className="hint" style={{ margin: "8px 0 0" }}>
            {value.maps.length} map{value.maps.length === 1 ? "" : "s"} in the pool.
          </p>
        </>
      )}
    </div>
  );
}

function SiteStatus({ info, pageUrl }: { info: MatchmakingInfo; pageUrl: string | null }) {
  if (info.site.error)
    return (
      <div className="notice error" style={{ marginBottom: 16 }}>
        The matchmaking site couldn't start: {info.site.error}
      </div>
    );
  if (!info.settings.enabled)
    return (
      <div className="notice info" style={{ marginBottom: 16 }}>
        The matchmaking site is closed. Tick "open" below and save to start it.
      </div>
    );
  if (!info.site.listening)
    return (
      <div className="notice warn" style={{ marginBottom: 16 }}>
        The matchmaking site isn't running. Check the panel's log.
      </div>
    );
  return (
    <div className="notice ok" style={{ marginBottom: 16 }}>
      Open on port {info.site.port}. On your network:{" "}
      <a href={pageUrl!} target="_blank" rel="noreferrer">
        {pageUrl}
      </a>
      . For people outside, give them your public address with <b>:{info.site.port}</b> and forward TCP port {info.site.port} on the router.{" "}
      {info.state.freeServers} server
      {info.state.freeServers === 1 ? "" : "s"} free for a match.
    </div>
  );
}

function RatingText({ r }: { r: MmRating }) {
  return (
    <span title={r.note ?? undefined}>
      <b>{r.value === null ? "—" : r.value.toLocaleString("en")}</b> <span className="hint">{r.pending ? "asking Leetify…" : SOURCE[r.source]}</span>
    </span>
  );
}

function LiveSection({ info, moderate, refresh }: { info: MatchmakingInfo; moderate: boolean; refresh: () => Promise<void> }) {
  const { run, busy } = useAction();
  const { lobby, matches } = info.state;
  const setRating = async (steamId: string, name: string, current: number | null) => {
    const answer = window.prompt(`Rating for ${name} (Premier, 0 to 40000). Leave empty to use Leetify or their own again.`, current?.toString() ?? "");
    if (answer === null) return;
    const value = answer.trim() === "" ? null : Number(answer.replace(/[\s,.]/g, ""));
    if (value !== null && !Number.isInteger(value)) return;
    if (await run(() => api.mmSetRating(steamId, value), "Rating saved.")) void refresh();
  };
  const remove = async (steamId: string) => {
    if (await run(() => api.mmRemove(steamId), "Removed from the lobby.")) void refresh();
  };
  const cancel = async (id: number) => {
    if (!window.confirm("Cancel this match? The server is unlocked right away.")) return;
    if (await run(() => api.mmCancel(id), "Match cancelled.")) void refresh();
  };

  return (
    <>
      <div className="panel">
        <h2 style={{ marginBottom: 10 }}>
          Lobby <span className="hint">({lobby.length})</span>
        </h2>
        {lobby.length === 0 ? (
          <p className="hint">Nobody is in the lobby.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Rating</th>
                <th>Lobby</th>
                <th>Status</th>
                {moderate && <th />}
              </tr>
            </thead>
            <tbody>
              {lobby.map((p) => (
                <tr key={p.steamId}>
                  <td>
                    <a href={`https://steamcommunity.com/profiles/${p.steamId}`} target="_blank" rel="noreferrer">
                      {p.name}
                    </a>
                  </td>
                  <td>
                    <RatingText r={p.rating} />
                  </td>
                  <td>{MODE_TEXT[p.mode].label}</td>
                  <td>{{ ready: "Ready", away: "Not ready", "in-match": "In a match" }[p.status]}</td>
                  {moderate && (
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="btn small ghost"
                        disabled={busy}
                        onClick={() => setRating(p.steamId, p.name, p.rating.source === "admin" ? p.rating.value : null)}
                      >
                        Set rating
                      </button>
                      <button className="btn small ghost danger" disabled={busy} onClick={() => remove(p.steamId)}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {matches.length > 0 && (
        <div className="panel">
          <h2 style={{ marginBottom: 10 }}>Matches now</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Map</th>
                <th>Teams</th>
                <th>Server</th>
                <th>Status</th>
                {moderate && <th />}
              </tr>
            </thead>
            <tbody>
              {matches.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.map ? mapLabel(m.map) : "—"}
                    <div className="hint">{m.modeLabel}</div>
                  </td>
                  <td>
                    {m.teamA.map((p) => p.name).join(", ")} <span className="hint">vs</span> {m.teamB.map((p) => p.name).join(", ")}
                    {m.score && (
                      <b>
                        {" "}
                        ({m.score.a}–{m.score.b})
                      </b>
                    )}
                  </td>
                  <td>{m.serverName ?? "—"}</td>
                  <td>
                    {PHASE[m.phase]}
                    <div className="hint">{m.status}</div>
                  </td>
                  {moderate && (
                    <td style={{ textAlign: "right" }}>
                      {["veto", "side", "starting", "live"].includes(m.phase) && (
                        <button className="btn small ghost danger" disabled={busy} onClick={() => cancel(m.id)}>
                          Cancel
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function HistorySection({ info }: { info: MatchmakingInfo }) {
  const done = info.history.filter((h) => !["veto", "side", "starting", "live"].includes(h.status));
  if (done.length === 0) return null;
  const serverName = (id: number | null) => info.servers.find((s) => s.id === id)?.name ?? "—";
  return (
    <div className="panel">
      <h2 style={{ marginBottom: 10 }}>Earlier matches</h2>
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Map</th>
            <th>Teams</th>
            <th>Server</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {done.map((h) => (
            <tr key={h.id}>
              <td>{formatDateTime(utc(h.createdAt))}</td>
              <td>
                {h.map ? mapLabel(h.map) : "—"}
                <div className="hint">{MODE_TEXT[h.mode as keyof typeof MODE_TEXT]?.label ?? h.mode}</div>
              </td>
              <td>
                {h.teamA.map((p) => p.name).join(", ")} <span className="hint">vs</span> {h.teamB.map((p) => p.name).join(", ")}
              </td>
              <td>{serverName(h.serverId)}</td>
              <td>
                {h.status === "over" && h.scoreA !== null ? `${h.scoreA}–${h.scoreB}` : (PHASE[h.status as keyof typeof PHASE] ?? h.status)}
                {h.note && h.status !== "over" && <div className="hint">{h.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
