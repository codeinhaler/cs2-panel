import { useCallback, useEffect, useRef, useState } from "react";
import {
  API,
  BOT_ID,
  setMapNames,
  formatRating,
  mapName,
  play,
  teamsLabel,
  type DiscordMe,
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
  /** Signed in and not in a lobby: the casual card shows once picked from the lobby choices. */
  const [casualOpen, setCasualOpen] = useState(false);
  // The server's clock minus ours, so countdowns are right even if the phone's clock isn't.
  const skew = useRef(0);

  const load = useCallback(async () => {
    try {
      const s = await play.state();
      skew.current = s.now - Date.now();
      setMapNames(s.mapNames);
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

      {state.look.layout === "board" ? (
        <BoardHome state={state} myMatch={myMatch} myDraft={myDraft} otherMatches={otherMatches} skew={skew.current} busy={busy} act={act} />
      ) : (
        <>
          {!me ? (
            <>
              {state.casual.servers.length > 0 && <CasualCard state={state} />}
              <section className="panel play-signin">
                <h2>Play with even teams</h2>
                {state.casual.servers.length > 0 && (
                  <p className="play-signin-note">
                    <b>{state.casual.name}</b> needs no sign-in: just press Join above. For{" "}
                    {state.lobbies
                      .map((l) => l.label)
                      .join(", ")
                      .replace(/, ([^,]*)$/, " and $1") || "Competitive"}{" "}
                    matches, sign in through Steam.
                  </p>
                )}
                <p>
                  Sign in with Steam and pick a lobby: {state.lobbies.map((l) => `${l.label}`).join(", ") || "Competitive"}. Teams are made from everyone's
                  Premier rating so both sides are about equal, and a bot fills in when the numbers are odd. The captains then ban maps until one is left, and
                  you get a button to join the server.
                </p>
                <a className="btn primary play-steam" href={`${API}/auth/steam`}>
                  Sign in through Steam
                </a>
                <p className="hint">Steam only tells this site your SteamID, name and avatar. Your password stays with Steam.</p>
              </section>
            </>
          ) : (
            <>
              {myMatch && <MatchCard match={myMatch} meId={me.steamId} skew={skew.current} busy={busy} act={act} mine />}
              {myDraft && <DraftCard draft={myDraft} state={state} busy={busy} act={act} />}
              {state.enabled &&
                (me.inLobby ? (
                  <LobbyCard state={state} busy={busy} act={act} />
                ) : (
                  <LobbyPicker state={state} busy={busy} act={act} casualOpen={casualOpen} onCasual={() => setCasualOpen((v) => !v)} />
                ))}
              {!me.inLobby && !myMatch && casualOpen && state.casual.servers.length > 0 && <CasualCard state={state} />}
              <RatingCard state={state} busy={busy} act={act} />
              <DiscordCard />
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
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- status board layout

const MODE_BLURB: Record<string, string> = {
  competitive: "Balanced by rating",
  wingman: "Short, small maps",
  duel: "Aim duel, first to 16",
  fixed5: "Pick your own side",
  fixed2: "Wingman, your own side",
};
const sizeText = (l: { teamSize: number; fixed: boolean }) => (l.teamSize === 1 ? "1v1" : l.teamSize === 2 ? "2v2" : `up to ${l.teamSize}v${l.teamSize}`);

/** The "Status board" layout: a ready-to-play checklist next to a table of every lobby, then live matches and casual servers. */
function BoardHome({
  state,
  myMatch,
  myDraft,
  otherMatches,
  skew,
  busy,
  act,
}: {
  state: State;
  myMatch: Match | undefined;
  myDraft: Draft | undefined;
  otherMatches: Match[];
  skew: number;
  busy: boolean;
  act: Act;
}) {
  const me = state.me;
  const [discord, setDiscord] = useState<DiscordMe | null>(null);
  useEffect(() => {
    if (me)
      void play
        .discord()
        .then(setDiscord)
        .catch(() => undefined);
  }, [me]);
  const steps: { done: boolean; title: string; text: string; optional?: boolean }[] = [
    { done: !!me, title: "Sign in with Steam", text: "Needed for matches, not for casual." },
    ...(discord?.available || !me
      ? [{ done: !!discord?.linked, title: "Link Discord", text: "We move you to your team's voice channel.", optional: true }]
      : []),
    { done: false, title: "Open CS2", text: "The Join button only works with the game running." },
    { done: !!me && (me.inLobby || !!myMatch), title: "Join a lobby", text: "Pick one in the table." },
  ];
  return (
    <div className="board">
      <aside className="board-side">
        <section className="panel board-check">
          <h2>Ready to play?</h2>
          <p className="hint">Tick these off and you're in.</p>
          <ul>
            {steps.map((s) => (
              <li key={s.title} className={s.done ? "done" : ""}>
                <span className="board-dot" aria-hidden="true">
                  {s.done ? "✓" : ""}
                </span>
                <span>
                  <b>{s.title}</b>
                  {s.optional && <span className="hint"> (optional)</span>}
                  <br />
                  <span className="hint">{s.text}</span>
                </span>
              </li>
            ))}
          </ul>
          {!me && (
            <a className="btn primary play-steam" href={`${API}/auth/steam`}>
              Sign in with Steam
            </a>
          )}
        </section>
        {me && <RatingCard state={state} busy={busy} act={act} />}
        {me && <DiscordCard />}
      </aside>

      <div className="board-main">
        {me && myMatch && <MatchCard match={myMatch} meId={me.steamId} skew={skew} busy={busy} act={act} mine />}
        {me && myDraft && <DraftCard draft={myDraft} state={state} busy={busy} act={act} />}
        {me?.inLobby && state.enabled ? (
          <LobbyCard state={state} busy={busy} act={act} />
        ) : (
          <section className="panel board-lobbies">
            <div className="board-lobbies-head">
              <h2>Lobbies</h2>
              <span className="hint">
                {state.freeServers} of {state.matchServers} match servers free
              </span>
            </div>
            <div className="board-table-wrap">
              <table className="board-table">
                <thead>
                  <tr>
                    <th>Mode</th>
                    <th>Teams</th>
                    <th>Waiting</th>
                    <th aria-label="Join" />
                  </tr>
                </thead>
                <tbody>
                  {state.lobbies.map((l) => (
                    <tr key={l.mode}>
                      <td>
                        <b>{l.label}</b>
                        <br />
                        <span className="hint">{MODE_BLURB[l.mode] ?? ""}</span>
                      </td>
                      <td className="hint">{sizeText(l)}</td>
                      <td>{l.players}</td>
                      <td className="board-join">
                        {me ? (
                          <button className="btn primary small" disabled={busy || !state.enabled || !!myMatch} onClick={() => act(() => play.join(l.mode))}>
                            Join
                          </button>
                        ) : (
                          <a className="btn small" href={`${API}/auth/steam`}>
                            Sign in to join
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {state.lobbies.length === 0 && <p className="hint">No lobbies are open right now.</p>}
          </section>
        )}
        {otherMatches.length > 0 && (
          <section className="play-section">
            <h2 className="play-section-title">Live matches</h2>
            {otherMatches.map((m) => (
              <MatchCard key={m.id} match={m} meId={me?.steamId ?? null} skew={skew} busy={busy} act={act} />
            ))}
          </section>
        )}
        {state.casual.servers.length > 0 && !myMatch && <CasualCard state={state} />}
      </div>
    </div>
  );
}

type Act = (fn: () => Promise<unknown>) => Promise<void>;

const isActive = (m: Match) => ["veto", "side", "starting", "live"].includes(m.phase);
const inTeams = (m: { teamA: Member[]; teamB: Member[] }, id: string) => [...m.teamA, ...m.teamB].some((p) => p.steamId === id);

// ------------------------------------------------------------- Discord (optional)

/** Link Discord once; being moved into your match's voice channel is then on by default (each player can switch it off). Never needed to play. */
function DiscordCard() {
  const [d, setD] = useState<DiscordMe | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const justLinked = useRef(new URLSearchParams(window.location.search).get("discord") === "linked");
  useEffect(() => {
    void play
      .discord()
      .then(setD)
      .catch(() => undefined);
    if (justLinked.current) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  if (!d || !d.available) return null;
  const run = async (fn: () => Promise<DiscordMe | unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setD(await play.discord());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel play-discord-card">
      <div className="panel-head">
        <h2>Discord</h2>
        {d.linked && <span className="hint">Linked as {d.linked.username}</span>}
      </div>
      {err && <p className="notice error">{err}</p>}
      {!d.linked ? (
        <>
          <p className="hint">
            Link your Discord account once{d.botOn ? " and the bot can move you into your team's voice channel when your match starts" : ""}. Optional: you can
            always play without it.
          </p>
          <a className="btn play-discord-btn" href={`${API}/discord/link`}>
            Link Discord account
          </a>
        </>
      ) : (
        <>
          {justLinked.current && <p className="notice info">Discord linked.</p>}
          {d.botOn ? (
            <div className="play-discord-prefs">
              <label className="check">
                <input
                  type="checkbox"
                  checked={d.autoMove}
                  disabled={busy}
                  onChange={(e) => void run(() => play.discordPrefs({ autoMove: e.target.checked, autoReturn: d.autoReturn }))}
                />
                <span>
                  Move me to my match's voice channel{" "}
                  <span className="hint">· {d.anyChannel && d.moveAny ? "from any voice channel on Discord" : "when I'm in the waiting room on Discord"}</span>
                </span>
              </label>
              {d.anyChannel && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={d.moveAny}
                    disabled={busy || !d.autoMove}
                    onChange={(e) => void run(() => play.discordPrefs({ autoMove: d.autoMove, autoReturn: d.autoReturn, moveAny: e.target.checked }))}
                  />
                  <span>Also when I'm in another voice channel, not just the waiting room</span>
                </label>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={d.autoReturn}
                  disabled={busy || !d.autoMove}
                  onChange={(e) => void run(() => play.discordPrefs({ autoMove: d.autoMove, autoReturn: e.target.checked }))}
                />
                <span>Move me back after the match{d.anyChannel && d.moveAny ? " (to the channel I came from)" : " to the waiting room"}</span>
              </label>
            </div>
          ) : (
            <p className="hint">Automatic voice moving isn't switched on for this event; the Join Discord channel button works as always.</p>
          )}
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => void run(() => play.discordUnlink())}>
            Unlink Discord
          </button>
        </>
      )}
    </section>
  );
}

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
function LobbyPicker({ state, busy, act, casualOpen, onCasual }: { state: State; busy: boolean; act: Act; casualOpen: boolean; onCasual: () => void }) {
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
          {state.casual.servers.length > 0 && (
            <button className={`play-lobby casual ${casualOpen ? "on" : ""}`} onClick={onCasual} aria-expanded={casualOpen}>
              <span className="play-lobby-name">{state.casual.name}</span>
              <span className="hint">Join any time, no teams made</span>
              <span className="hint">{state.casual.servers.reduce((n, s) => n + (s.online ? s.players : 0), 0)} playing now</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function LobbyCard({ state, busy, act }: { state: State; busy: boolean; act: Act }) {
  const me = state.me!;
  const lobby = state.lobbies.find((l) => l.mode === me.mode);
  if (lobby?.fixed) return <FixedLobbyCard state={state} busy={busy} act={act} />;
  const members = state.lobby.filter((p) => p.mode === me.mode);
  const available = members.filter((p) => p.status === "ready");
  const myStatus = members.find((p) => p.steamId === me.steamId)?.status;
  const draft = state.drafts.find((d) => d.mode === me.mode);
  const size = lobby?.teamSize ?? 5;
  const max = size * 2;
  // This lobby's servers only: a busy Wingman server doesn't stop a Competitive match.
  const free = lobby?.freeServers ?? state.freeServers;
  const canMake = myStatus === "ready" && available.length >= 2 && !draft && free > 0;
  const n = Math.min(available.length, max);
  const reason =
    myStatus === "in-match"
      ? null
      : !me.ready
        ? "Mark yourself ready to make teams."
        : available.length < 2
          ? "Waiting for more ready players."
          : (lobby?.matchServers ?? state.matchServers) === 0
            ? `No server is set up for ${lobby?.label ?? "matches"} yet. Ask the organiser.`
            : free === 0
              ? `All ${lobby?.label ?? "match"} servers are busy; teams can be made when one is free.`
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

/** Fixed teams: players pick Team 1 or Team 2; a full match starts at once, otherwise both captains vote to start. */
function FixedLobbyCard({ state, busy, act }: { state: State; busy: boolean; act: Act }) {
  const me = state.me!;
  const lobby = state.lobbies.find((l) => l.mode === me.mode)!;
  const f = state.fixed;
  const size = lobby.teamSize;
  const members = state.lobby.filter((p) => p.mode === me.mode);
  const mine = members.find((p) => p.steamId === me.steamId);
  const inMatch = mine?.status === "in-match";
  const waiting = members.filter((p) => p.status !== "in-match");
  const team = (k: "a" | "b") => waiting.filter((p) => p.team === k);
  const bench = waiting.filter((p) => !p.team);
  const myTeam = mine?.team ?? null;
  const captainOf = (k: "a" | "b") => (k === "a" ? f?.captainA : f?.captainB);
  const iAmCaptain = !!myTeam && captainOf(myTeam) === me.steamId;
  const iVoted = !!myTeam && !!f?.votes[myTeam];
  const free = lobby.freeServers;
  const canStart = !inMatch && !!myTeam && free > 0 && (f?.full || (iAmCaptain && !iVoted && !f?.reason?.startsWith("Each team")));
  const others = state.lobbies.filter((l) => l.mode !== me.mode);
  const hint = inMatch
    ? null
    : lobby.matchServers === 0
      ? `No server is set up for ${lobby.label} yet. Ask the organiser.`
      : free === 0
        ? `All ${lobby.label} servers are busy; you can start when one is free.`
        : !myTeam
          ? "Pick a team to play."
          : f?.full
            ? "Both teams are full: anyone on a team can start."
            : f?.reason?.startsWith("Each team")
              ? f.reason
              : iVoted
                ? "You voted to start. Waiting for the other captain."
                : iAmCaptain
                  ? `${f?.reason ?? ""}`
                  : "The teams aren't full: the two captains (★) vote to start.";
  const column = (k: "a" | "b", label: string) => (
    <div className="play-fixed-team">
      <div className="play-fixed-head">
        <b>{label}</b>{" "}
        <span className="hint">
          {team(k).length}/{size}
          {f?.votes[k] ? " · captain voted to start" : ""}
        </span>
      </div>
      <ul className="play-list">
        {team(k).map((p) => (
          <LobbyRow key={p.steamId} p={p} me={p.steamId === me.steamId} captain={captainOf(k) === p.steamId} />
        ))}
      </ul>
      {!inMatch && myTeam !== k && team(k).length < size && (
        <button className="btn small" disabled={busy} onClick={() => act(() => play.pickTeam(k))}>
          Join {label}
        </button>
      )}
    </div>
  );
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {lobby.label} <span className="hint">{`${members.length} here`}</span>
        </h2>
        <div className="play-row">
          {myTeam && !inMatch && (
            <button className="btn small ghost" disabled={busy} onClick={() => act(() => play.pickTeam(null))}>
              Sit out
            </button>
          )}
          <button className="btn small ghost" disabled={busy} onClick={() => act(play.leave)}>
            Leave
          </button>
        </div>
      </div>
      <div className="play-fixed">
        {column("a", "Team 1")}
        {column("b", "Team 2")}
      </div>
      {bench.length > 0 && (
        <>
          <p className="hint">Waiting for a spot</p>
          <ul className="play-list">
            {bench.map((p) => (
              <LobbyRow key={p.steamId} p={p} me={p.steamId === me.steamId} />
            ))}
          </ul>
        </>
      )}
      <div className="play-make">
        <button className="btn primary play-big" disabled={busy || !canStart} onClick={() => act(play.startFixed)}>
          {f?.full ? "Start: ban maps" : "Vote to start"}
        </button>
        {hint && <span className="hint">{hint}</span>}
      </div>
      {others.length > 0 && !inMatch && (
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

function LobbyRow({ p, me, captain }: { p: LobbyPlayer; me: boolean; captain?: boolean }) {
  const status = { ready: "Ready", away: "Not ready", "in-match": "In a match" }[p.status];
  return (
    <li className={`play-player ${p.status}`}>
      <Avatar url={p.avatarUrl} />
      <span className="play-player-name">
        {captain && <span title="Captain">★ </span>}
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
              {team.map((p, j) => (
                <li key={`${p.steamId}-${j}`} className="play-player">
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
              <p className="play-cs2-first">Start CS2 first, then press Join.</p>
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

      {m.discord && <DiscordLinks discord={m.discord} />}

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
      {m.canJoin && !m.canJoin.team && m.canJoin.reason && <p className="hint">{m.canJoin.reason}</p>}

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

      {!ended && m.bots && (iAmCaptainOf("a") || iAmCaptainOf("b")) && (
        <div className="play-vote">
          <label className="check">
            <input
              type="checkbox"
              disabled={busy}
              checked={m.bots.votes[iAmCaptainOf("a") ? "a" : "b"]}
              onChange={(e) => act(() => play.bot(m.id, e.target.checked))}
            />
            <span>{m.bots.counts.a + m.bots.counts.b > 1 ? "Fill the empty spots with bots" : "Fill the short team with a bot"}</span>
          </label>
          <span className="hint">
            {m.bots.on
              ? m.bots.votes.a && m.bots.votes.b
                ? "The bot plays. It's left out only if both captains untick this."
                : "The bot still plays: the other captain wants it."
              : m.bots.counts.a + m.bots.counts.b > 1
                ? "No bots: both captains said no, so the teams play short."
                : `No bot: both captains said no, so ${label(m.bots.team)} plays one short.`}
          </span>
        </div>
      )}
      {!ended && m.bots && myTeam && !iAmCaptainOf(myTeam) && (
        <p className="hint">
          {m.bots.counts.a + m.bots.counts.b > 1
            ? m.bots.on
              ? `Bots fill the empty spots (${m.bots.counts.a} on ${label("a")}, ${m.bots.counts.b} on ${label("b")}).`
              : "No bots: the teams play short."
            : m.bots.on
              ? `A bot fills the empty spot on ${label(m.bots.team)}.`
              : `No bot: ${label(m.bots.team)} plays one short.`}
        </p>
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

// ------------------------------------------------------------- casual servers

/** discord.com/channels/… → the same channel in the Discord app. */
function discordAppUrl(channel: string): string {
  const m = /discord\.com\/channels\/(\d+)\/(\d+)/.exec(channel);
  return m ? `discord://-/channels/${m[1]}/${m[2]}` : channel;
}

/** One plain button that opens the voice channel in the Discord app; the browser and the invite as small links. */
function DiscordLinks({ discord }: { discord: { channel: string; invite: string | null } }) {
  return (
    <div className="play-discord">
      <div className="play-discord-main">
        <a className="btn play-discord-btn" href={discordAppUrl(discord.channel)}>
          Join Discord channel
        </a>
        <a className="play-discord-browser" href={discord.channel} target="_blank" rel="noreferrer">
          Open in browser instead
        </a>
      </div>
      {discord.invite && (
        <a className="hint" href={discord.invite} target="_blank" rel="noreferrer">
          Not on our Discord? Join here
        </a>
      )}
    </div>
  );
}

function CasualCard({ state }: { state: State }) {
  const ownDiscord = state.casual.servers.some((s) => s.discord && s.discord.channel !== state.casual.discord?.channel);
  return (
    <section className="panel play-casual">
      <div className="panel-head">
        <h2>{state.casual.name}</h2>
        <span className="hint">Join any time · no sign-in</span>
      </div>
      <div className="play-casual-list">
        {state.casual.servers.map((s) => (
          <div key={s.id} className="play-casual-server">
            <div className="play-casual-info">
              <b>{s.name}</b>
              <span className="hint">
                {s.online ? (
                  <>
                    {s.map ? mapName(s.map) : "—"} · {s.players} / {s.maxPlayers} players
                  </>
                ) : (
                  "Offline right now"
                )}
              </span>
            </div>
            <a className={`btn primary ${s.online ? "" : "disabled"}`} href={s.online ? s.joinInfo.steamUrl : undefined} aria-disabled={!s.online}>
              Join the server
            </a>
            <p className="play-cs2-first">Start CS2 first, then press Join.</p>
            <CopyLine
              label={s.joinInfo.password ? `Or paste in the CS2 console (password ${s.joinInfo.password})` : "Or paste in the CS2 console"}
              text={s.joinInfo.console}
            />
            {ownDiscord && s.discord && <DiscordLinks discord={s.discord} />}
          </div>
        ))}
      </div>
      {/* One button for all, unless a server has its own channel: then each server gets its button. */}
      {!ownDiscord && state.casual.discord && <DiscordLinks discord={state.casual.discord} />}
    </section>
  );
}
