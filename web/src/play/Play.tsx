import { useCallback, useEffect, useRef, useState } from "react";
import {
  API,
  BOT_ID,
  formatRating,
  mapName,
  play,
  teamsLabel,
  type Draft,
  type LobbyPlayer,
  type Match,
  type Member,
  type Rating,
  type Side,
  type State,
  type TeamKey,
} from "./api";

const POLL_MS = 2000;

export function Play() {
  const [state, setState] = useState<State | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(() => new URLSearchParams(window.location.search).get("error"));
  const [busy, setBusy] = useState(false);
  // The server's clock minus ours, so countdowns are right even if the phone's clock isn't.
  const skew = useRef(0);

  const load = useCallback(async () => {
    try {
      const s = await play.state();
      skew.current = s.now - Date.now();
      setState(s);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    if (error) window.history.replaceState(null, "", window.location.pathname);
    void load();
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
        void load();
      }
    },
    [load],
  );

  if (!state) {
    return <div className="play-loading">{offline ? "Can't reach the matchmaking site. Retrying…" : "Loading…"}</div>;
  }

  document.title = state.title;
  const me = state.me;
  const myMatch = me ? state.matches.find((m) => isActive(m) && inTeams(m, me.steamId)) : undefined;
  const otherMatches = state.matches.filter((m) => m !== myMatch);
  const myDraft = me?.mode ? state.drafts.find((d) => d.mode === me.mode) : undefined;

  return (
    <div className="play">
      <header className="play-head">
        <div className="play-brand">
          {state.look.icon ? (
            <img className="play-logo" src={state.look.icon} alt="" />
          ) : (
            <span className="play-mark" aria-hidden="true">
              <span />
              <span />
            </span>
          )}
          <h1>{state.title}</h1>
        </div>
        {me ? (
          <div className="play-me">
            {me.avatarUrl ? <img src={me.avatarUrl} alt="" /> : <span className="play-avatar" aria-hidden="true" />}
            <span className="play-me-name">{me.name}</span>
            <button className="btn small ghost" onClick={() => act(async () => (await play.logout(), window.location.reload()))}>
              Sign out
            </button>
          </div>
        ) : null}
      </header>

      {state.look.banner && <img className="play-banner" src={state.look.banner} alt="" />}

      {offline && <div className="notice warn">Lost the connection. Retrying…</div>}
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button className="btn small ghost" style={{ marginLeft: 12 }} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!state.enabled && <div className="notice info">Matchmaking is closed right now. Check back when the event starts.</div>}

      {!me ? (
        <section className="panel play-signin">
          <h2>Play with even teams</h2>
          <p>
            Sign in with Steam and pick a lobby: {state.lobbies.map((l) => `${l.label}`).join(", ") || "Competitive"}. Teams are made from everyone's Premier
            rating so both sides are about equal, and a bot fills in when the numbers are odd. The captains then ban maps until one is left, and you get a
            button to join the server.
          </p>
          <a className="btn primary play-steam" href={`${API}/auth/steam`}>
            Sign in through Steam
          </a>
          <p className="hint">Steam only tells this site your SteamID, name and avatar. Your password stays with Steam.</p>
        </section>
      ) : (
        <>
          {myMatch && <MatchCard match={myMatch} meId={me.steamId} skew={skew.current} busy={busy} act={act} mine />}
          {myDraft && <DraftCard draft={myDraft} state={state} busy={busy} act={act} />}
          {state.enabled && (me.inLobby ? <LobbyCard state={state} busy={busy} act={act} /> : <LobbyPicker state={state} busy={busy} act={act} />)}
          <RatingCard state={state} busy={busy} act={act} />
        </>
      )}

      {otherMatches.length > 0 && (
        <section className="play-section">
          <h2 className="play-section-title">Matches</h2>
          {otherMatches.map((m) => (
            <MatchCard key={m.id} match={m} meId={me?.steamId ?? null} skew={skew.current} busy={busy} act={act} />
          ))}
        </section>
      )}

      <footer className="play-foot">
        <a href="https://leetify.com/" target="_blank" rel="noreferrer" className="play-leetify">
          Data provided by Leetify
        </a>
        <span className="hint">Premier ratings come from Leetify when they have one; otherwise players enter their own.</span>
      </footer>
    </div>
  );
}

type Act = (fn: () => Promise<unknown>) => Promise<void>;

const isActive = (m: Match) => ["veto", "side", "starting", "live"].includes(m.phase);
const inTeams = (m: { teamA: Member[]; teamB: Member[] }, id: string) => [...m.teamA, ...m.teamB].some((p) => p.steamId === id);

// ------------------------------------------------------------- your rating

function RatingCard({ state, busy, act }: { state: State; busy: boolean; act: Act }) {
  const me = state.me!;
  const [value, setValue] = useState(me.selfRating?.toString() ?? "");
  useEffect(() => setValue(me.selfRating?.toString() ?? ""), [me.selfRating]);
  const fromLeetify = me.rating.source === "leetify";
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const n = value.trim() === "" ? null : Number(value.replace(/[\s,.]/g, ""));
    void act(() => play.setRating(n));
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Your rating</h2>
        <RatingBadge rating={me.rating} big />
      </div>
      {me.rating.pending ? (
        <p className="hint">Asking Leetify…</p>
      ) : fromLeetify ? (
        <p className="hint">
          Your Premier rating from Leetify.{" "}
          <a href={me.leetifyUrl} target="_blank" rel="noreferrer">
            View on Leetify
          </a>
        </p>
      ) : me.rating.source === "admin" ? (
        <p className="hint">Set by the organiser.</p>
      ) : (
        <p className="hint">{me.rating.note ? `${me.rating.note}. ` : ""}Enter your Premier rating so the teams come out even.</p>
      )}
      {!fromLeetify && me.rating.source !== "admin" && (
        <form className="play-rating-form" onSubmit={save}>
          <label className="field">
            <span>Premier rating</span>
            <input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 14500" maxLength={6} />
          </label>
          <button className="btn" disabled={busy}>
            Save
          </button>
        </form>
      )}
    </section>
  );
}

function RatingBadge({ rating, big }: { rating: Rating; big?: boolean }) {
  const label = { leetify: "Leetify", self: "self-set", admin: "set by organiser", none: "no rating", bot: "bot" }[rating.source];
  return (
    <span className={`rating ${tier(rating.value)} ${big ? "big" : ""}`} title={rating.note ?? label}>
      <b>{formatRating(rating.value)}</b>
      <small>{rating.pending ? "…" : label}</small>
    </span>
  );
}

/** Premier's colour bands. */
function tier(v: number | null): string {
  if (v === null) return "t-none";
  if (v < 5000) return "t-grey";
  if (v < 10000) return "t-cyan";
  if (v < 15000) return "t-blue";
  if (v < 20000) return "t-purple";
  if (v < 25000) return "t-pink";
  if (v < 30000) return "t-red";
  return "t-gold";
}

// ------------------------------------------------------------- lobby

/** First thing after signing in: which lobby to wait in. */
function LobbyPicker({ state, busy, act }: { state: State; busy: boolean; act: Act }) {
  return (
    <section className="panel">
      <h2 style={{ marginBottom: 12 }}>Pick a lobby</h2>
      {state.lobbies.length === 0 ? (
        <p className="hint">No lobbies are open right now.</p>
      ) : (
        <div className="play-lobbies">
          {state.lobbies.map((l) => (
            <button key={l.mode} className="play-lobby" disabled={busy} onClick={() => act(() => play.join(l.mode))}>
              <span className="play-lobby-name">{l.label}</span>
              {teamsLabel(l.teamSize) && <span className="play-lobby-size">{teamsLabel(l.teamSize)}</span>}
              <span className="hint">{l.players === 0 ? "Nobody here yet" : `${l.players} here, ${l.ready} ready`}</span>
              <span className="hint play-lobby-maps">{l.maps.map(mapName).join(" · ")}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function LobbyCard({ state, busy, act }: { state: State; busy: boolean; act: Act }) {
  const me = state.me!;
  const lobby = state.lobbies.find((l) => l.mode === me.mode);
  const members = state.lobby.filter((p) => p.mode === me.mode);
  const available = members.filter((p) => p.status === "ready");
  const myStatus = members.find((p) => p.steamId === me.steamId)?.status;
  const draft = state.drafts.find((d) => d.mode === me.mode);
  const size = lobby?.teamSize ?? 5;
  const max = size * 2;
  const canMake = myStatus === "ready" && available.length >= 2 && !draft && state.freeServers > 0;
  const n = Math.min(available.length, max);
  const reason =
    myStatus === "in-match"
      ? null
      : !me.ready
        ? "Mark yourself ready to make teams."
        : available.length < 2
          ? "Waiting for more ready players."
          : state.matchServers === 0
            ? "No server is set up for matches yet. Ask the organiser."
            : state.freeServers === 0
              ? "All servers are busy. Teams can be made when a match finishes."
              : draft
                ? null
                : available.length > max
                  ? `${available.length} ready: ${max} play now; the rest go first in the next match${size > 1 ? " (with a bot if needed)" : ""}.`
                  : n % 2 && size > 1
                    ? `${n} ready: a bot joins the smaller team so everyone plays.`
                    : n % 2
                      ? `${n} ready: two play now, the third goes first next time.`
                      : null;
  const others = state.lobbies.filter((l) => l.mode !== me.mode);
  const joinable = myStatus === "in-match" ? undefined : state.matches.find((m) => m.mode === me.mode && m.canJoin?.team);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {lobby?.label ?? "Lobby"} <span className="hint">{[teamsLabel(size), `${members.length} here`].filter(Boolean).join(" · ")}</span>
        </h2>
        <div className="play-row">
          {myStatus !== "in-match" && (
            <label className="check play-ready">
              <input type="checkbox" checked={me.ready} disabled={busy} onChange={(e) => act(() => play.ready(e.target.checked))} />
              <span>Ready</span>
            </label>
          )}
          <button className="btn small ghost" disabled={busy} onClick={() => act(play.leave)}>
            Leave
          </button>
        </div>
      </div>

      <ul className="play-list">
        {members.map((p) => (
          <LobbyRow key={p.steamId} p={p} me={p.steamId === me.steamId} />
        ))}
      </ul>

      {joinable && (
        <div className="play-latejoin">
          <div>
            <b>
              A {lobby?.label ?? ""} match on {joinable.map ? mapName(joinable.map) : "the veto"} has room.
            </b>
            <div className="hint">Jump in now instead of waiting for the next one.</div>
          </div>
          <button className="btn primary" disabled={busy} onClick={() => act(() => play.joinMatch(joinable.id))}>
            Join that match
          </button>
        </div>
      )}

      <div className="play-make">
        <button className="btn primary play-big" disabled={busy || !canMake} onClick={() => act(play.makeTeams)}>
          Make teams
        </button>
        {reason && <span className="hint">{reason}</span>}
      </div>

      {others.length > 0 && myStatus !== "in-match" && (
        <div className="play-switch">
          <span className="hint">Switch to</span>
          {others.map((l) => (
            <button key={l.mode} className="btn small" disabled={busy} onClick={() => act(() => play.join(l.mode))}>
              {l.label} <span className="hint">({l.players})</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function LobbyRow({ p, me }: { p: LobbyPlayer; me: boolean }) {
  const status = { ready: "Ready", away: "Not ready", "in-match": "In a match" }[p.status];
  return (
    <li className={`play-player ${p.status}`}>
      <Avatar url={p.avatarUrl} />
      <span className="play-player-name">
        {p.name}
        {me && <span className="hint"> (you)</span>}
        <span className={`play-status ${p.status}`}>{status}</span>
      </span>
      {p.rating.source === "leetify" ? (
        <a href={p.leetifyUrl} target="_blank" rel="noreferrer" title="View on Leetify" className="play-rating-link">
          <RatingBadge rating={p.rating} />
        </a>
      ) : (
        <RatingBadge rating={p.rating} />
      )}
    </li>
  );
}

function Avatar({ url }: { url: string | null }) {
  return url ? <img className="play-avatar" src={url} alt="" /> : <span className="play-avatar" aria-hidden="true" />;
}

// ------------------------------------------------------------- proposed teams

function DraftCard({ draft: d, state, busy, act }: { draft: Draft; state: State; busy: boolean; act: Act }) {
  const mine = state.me ? inTeams(d, state.me.steamId) : false;
  return (
    <section className="panel play-draft">
      <div className="panel-head">
        <h2>Proposed teams</h2>
        <span className="hint">
          Option {d.option} of {d.options}
        </span>
      </div>
      <TeamsView teams={d} labels={["Team 1", "Team 2"]} />
      <p className="hint play-gap">
        Difference in average rating: <b>{formatRating(Math.abs(d.avgA - d.avgB))}</b>
        {inTeams(d, BOT_ID) && <> · the bot counts as {formatRating([...d.teamA, ...d.teamB].find((p) => p.steamId === BOT_ID)!.effective)}</>}
      </p>
      {mine ? (
        <div className="row-actions play-actions">
          <button className="btn primary play-big" disabled={busy} onClick={() => act(() => play.startTeams(d.id))}>
            Go: ban maps
          </button>
          <button className="btn" disabled={busy || d.options < 2} onClick={() => act(() => play.reshuffle(d.id))}>
            Other teams
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => act(() => play.cancelTeams(d.id))}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="hint">The players on these teams decide whether to go.</p>
      )}
    </section>
  );
}

function TeamsView({
  teams,
  labels,
  captains,
  highlight,
}: {
  teams: { teamA: Member[]; teamB: Member[]; avgA: number; avgB: number };
  labels: [string, string];
  captains?: [string, string];
  highlight?: TeamKey | null;
}) {
  return (
    <div className="play-teams">
      {(["a", "b"] as const).map((k, i) => {
        const team = k === "a" ? teams.teamA : teams.teamB;
        const avg = k === "a" ? teams.avgA : teams.avgB;
        return (
          <div key={k} className={`play-team team-${k} ${highlight === k ? "on" : ""}`}>
            <div className="play-team-head">
              <h3>{labels[i]}</h3>
              <span className="hint">avg {formatRating(avg)}</span>
            </div>
            <ul className="play-list">
              {team.map((p) => (
                <li key={p.steamId} className="play-player">
                  <Avatar url={p.avatarUrl} />
                  <span className="play-player-name">
                    {p.name}
                    {captains?.[i] === p.steamId && <span className="tag play-captain">Captain</span>}
                  </span>
                  <RatingBadge rating={p.rating} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------- a match

function useCountdown(deadline: number | null, skew: number): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (deadline === null) return;
    const t = window.setInterval(() => tick((x) => x + 1), 250);
    return () => window.clearInterval(t);
  }, [deadline]);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - (Date.now() + skew)) / 1000));
}

function MatchCard({ match: m, meId, skew, busy, act, mine }: { match: Match; meId: string | null; skew: number; busy: boolean; act: Act; mine?: boolean }) {
  const left = useCountdown(m.deadline, skew);
  const nameOf = (id: string) => [...m.teamA, ...m.teamB].find((p) => p.steamId === id)?.name ?? "?";
  const labels: [string, string] = [`Team ${nameOf(m.captainA)}`, `Team ${nameOf(m.captainB)}`];
  const label = (k: TeamKey) => (k === "a" ? labels[0] : labels[1]);
  const myTeam: TeamKey | null = meId ? (m.teamA.some((p) => p.steamId === meId) ? "a" : m.teamB.some((p) => p.steamId === meId) ? "b" : null) : null;
  const iAmCaptainOf = (k: TeamKey | null) => k !== null && meId === (k === "a" ? m.captainA : m.captainB);
  const sideOf = (k: TeamKey): Side | null => (m.sideA === null ? null : k === "a" ? m.sideA : m.sideA === "ct" ? "t" : "ct");
  const ended = !isActive(m);

  return (
    <section className={`panel play-match ${mine ? "mine" : ""} phase-${m.phase}`}>
      <div className="panel-head">
        <h2>
          {m.map ? mapName(m.map) : "Map veto"}
          <span className="hint">
            {" "}
            · {m.modeLabel}
            {m.serverName && ` · ${m.serverName}`}
          </span>
        </h2>
        <PhaseTag m={m} />
      </div>

      {m.score && (
        <div className="play-score" aria-label="Score">
          <span>{labels[0]}</span>
          <b>
            {m.score.a} : {m.score.b}
          </b>
          <span>{labels[1]}</span>
        </div>
      )}

      {m.phase === "veto" && (
        <div className="play-veto">
          <p className="play-turn">
            {iAmCaptainOf(m.turn) ? <b>Your turn: ban a map.</b> : <>{label(m.turn!)} is banning a map.</>}{" "}
            {left !== null && <span className="play-clock">{left}s</span>}
          </p>
          <div className="play-maps">
            {m.pool.map((map) => {
              const ban = m.bans.find((b) => b.map === map);
              const canBan = !ban && iAmCaptainOf(m.turn) && !busy;
              return (
                <button key={map} className={`play-map ${ban ? "banned" : ""}`} disabled={!canBan} onClick={() => act(() => play.ban(m.id, map))}>
                  <span className="play-map-name">{mapName(map)}</span>
                  {ban ? (
                    <small>
                      Banned by {label(ban.by)}
                      {ban.auto ? " (time ran out)" : ""}
                    </small>
                  ) : canBan ? (
                    <small>Ban</small>
                  ) : null}
                </button>
              );
            })}
          </div>
          {!iAmCaptainOf(m.turn) && myTeam && <p className="hint">Tell your captain which maps to ban. A random map is banned if time runs out.</p>}
        </div>
      )}

      {m.phase === "side" && m.sidePicker && (
        <div className="play-veto">
          <p className="play-turn">
            {iAmCaptainOf(m.sidePicker) ? (
              <b>Pick your side on {mapName(m.map!)}.</b>
            ) : (
              <>
                {label(m.sidePicker)} is picking a side on {mapName(m.map!)}.
              </>
            )}{" "}
            {left !== null && <span className="play-clock">{left}s</span>}
          </p>
          {iAmCaptainOf(m.sidePicker) && (
            <div className="play-sides">
              <button className="btn play-side ct" disabled={busy} onClick={() => act(() => play.side(m.id, "ct"))}>
                Counter-Terrorists
              </button>
              <button className="btn play-side t" disabled={busy} onClick={() => act(() => play.side(m.id, "t"))}>
                Terrorists
              </button>
            </div>
          )}
        </div>
      )}

      {m.phase === "starting" && (
        <p className="play-status-line">
          <span className="play-spinner" aria-hidden="true" /> {m.status}…
        </p>
      )}

      {m.phase === "live" && (
        <div className="play-live">
          <p className="play-status-line">{m.status}</p>
          {m.joinInfo && (
            <div className="play-join">
              <a className="btn primary play-big" href={m.joinInfo.steamUrl}>
                Join the server
              </a>
              <CopyLine label="Or paste in the CS2 console" text={m.joinInfo.console} />
            </div>
          )}
          {myTeam && m.warmup && (
            <div className="row-actions">
              <button
                className="btn small"
                disabled={busy}
                onClick={() => window.confirm("Start the match now, without waiting for everyone?") && act(() => play.startNow(m.id))}
              >
                Start without waiting
              </button>
            </div>
          )}
        </div>
      )}

      {ended && m.phase !== "over" && m.error && <p className="notice warn">{m.error}</p>}

      <TeamsView
        teams={m}
        labels={[
          `${labels[0]}${sideOf("a") ? ` · ${sideOf("a")!.toUpperCase()}` : ""}`,
          `${labels[1]}${sideOf("b") ? ` · ${sideOf("b")!.toUpperCase()}` : ""}`,
        ]}
        captains={[m.captainA, m.captainB]}
        highlight={m.phase === "veto" ? m.turn : m.phase === "side" ? m.sidePicker : myTeam}
      />

      {m.canJoin?.team && (
        <div className="play-latejoin">
          <div>
            <b>There's room in this match.</b>
            <div className="hint">
              You'd play for {label(m.canJoin.team)}
              {(m.canJoin.team === "a" ? m.teamA : m.teamB).some((p) => p.steamId === BOT_ID) ? " in place of the bot" : ""}.
            </div>
          </div>
          <button className="btn primary" disabled={busy} onClick={() => act(() => play.joinMatch(m.id))}>
            Join this match
          </button>
        </div>
      )}
      {m.canJoin && !m.canJoin.team && m.canJoin.reason && !m.canJoin.reason.startsWith("Join the") && <p className="hint">{m.canJoin.reason}</p>}

      {!ended && (iAmCaptainOf("a") || iAmCaptainOf("b")) && (
        <div className="play-vote">
          <label className="check">
            <input
              type="checkbox"
              disabled={busy}
              checked={m.lateJoins.votes[iAmCaptainOf("a") ? "a" : "b"]}
              onChange={(e) => act(() => play.lateJoins(m.id, e.target.checked))}
            />
            <span>Let people join mid-match</span>
          </label>
          <span className="hint">
            {m.lateJoins.open
              ? m.lateJoins.votes.a && m.lateJoins.votes.b
                ? "Open. It closes only if both captains untick this."
                : "Still open: the other captain wants it open."
              : "Closed: both captains said no."}
          </span>
        </div>
      )}
      {!ended && myTeam && !iAmCaptainOf(myTeam) && (
        <p className="hint">{m.lateJoins.open ? "Others can join this match if a team has room." : "Closed to new players by the captains."}</p>
      )}

      {myTeam && !ended && (
        <div className="row-actions">
          <button
            className="btn small ghost danger"
            disabled={busy}
            onClick={() => window.confirm("Cancel this match for everyone?") && act(() => play.cancelMatch(m.id))}
          >
            Cancel match
          </button>
        </div>
      )}
    </section>
  );
}

function PhaseTag({ m }: { m: Match }) {
  const text = {
    veto: "Banning maps",
    side: "Picking sides",
    starting: "Starting",
    live: m.warmup ? `Warmup · ${m.connected}/${m.expected} in` : "Live",
    over: "Finished",
    cancelled: "Cancelled",
    abandoned: "Ended",
  }[m.phase];
  return <span className={`play-phase phase-${m.phase}`}>{text}</span>;
}

function CopyLine({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the text is selectable anyway */
    }
  };
  return (
    <div className="play-copy">
      <span className="hint">{label}</span>
      <div className="play-copy-row">
        <code>{text}</code>
        <button className="btn small" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
