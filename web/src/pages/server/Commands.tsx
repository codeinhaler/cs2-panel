import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Server } from "../../api";
import { useAction, useApp } from "../../app-context";

type Body = { action: string; [k: string]: unknown };

/** Buttons for the everyday server commands, so nobody needs to remember console syntax. */
export function CommandsTab({ server }: { server: Server }) {
  const { can } = useApp();
  const { busy, run } = useAction();
  const mapsId = useId();
  const [maps, setMaps] = useState<string[]>([]);
  const [map, setMap] = useState("");
  const [quota, setQuota] = useState(0);
  const [message, setMessage] = useState("");
  const [lastOutput, setLastOutput] = useState<string | null>(null);

  useEffect(() => {
    void api.installedMaps().then((r) => setMaps(r.maps), () => undefined);
  }, []);

  const running = server.status.state === "active";
  const control = can("server.control");

  const send = async (body: Body, done: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return false;
    const r = await run(() => api.command(server.id, body), done);
    if (r) setLastOutput(r.output.trim() || null);
    return !!r;
  };

  const changeMap = async (e: React.FormEvent) => {
    e.preventDefault();
    // A Workshop link or bare number means a Workshop map.
    const raw = map.trim();
    const id = /[?&]id=(\d+)/.exec(raw)?.[1] ?? (/^\d+$/.test(raw) ? raw : null);
    const value = id ? `workshop:${id}` : raw;
    if (await send({ action: "changemap", map: value }, `Changing map to ${id ? `Workshop map ${id}` : raw}.`)) setMap("");
  };

  const say = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await send({ action: "say", text: message }, "Message sent.")) setMessage("");
  };

  if (!running) {
    return <div className="notice info">The server isn't running. Start it to send commands.</div>;
  }

  return (
    <>
      {control && (
        <>
          <div className="panel">
            <h2 style={{ marginBottom: 6 }}>Map</h2>
            <p className="hint" style={{ marginTop: 0 }}>
              Everyone on the server moves to the new map. This doesn't change the start map in Settings.
            </p>
            <form className="row-actions" style={{ flexWrap: "wrap" }} onSubmit={changeMap}>
              <input
                value={map}
                onChange={(e) => setMap(e.target.value)}
                list={mapsId}
                placeholder="de_mirage, or a Workshop link or ID"
                spellCheck={false}
                aria-label="Map"
                style={{ maxWidth: 320 }}
              />
              <datalist id={mapsId}>
                {maps.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <button className="btn primary" disabled={busy || !map.trim()}>
                Change map
              </button>
            </form>
          </div>

          <div className="panel">
            <h2 style={{ marginBottom: 12 }}>Match</h2>
            <div className="command-grid">
              <CommandButton busy={busy} onClick={() => send({ action: "restart-game" }, "Game restarting.", "Restart the game? Scores and money reset.")}>
                Restart game
                <small>Resets scores and money</small>
              </CommandButton>
              <CommandButton busy={busy} onClick={() => send({ action: "warmup-start" }, "Warmup started.")}>
                Start warmup
              </CommandButton>
              <CommandButton busy={busy} onClick={() => send({ action: "warmup-end" }, "Warmup ended.")}>
                End warmup
                <small>Starts the match</small>
              </CommandButton>
              <CommandButton busy={busy} onClick={() => send({ action: "pause" }, "Match pauses at the next freeze time.")}>
                Pause match
                <small>At the next freeze time</small>
              </CommandButton>
              <CommandButton busy={busy} onClick={() => send({ action: "unpause" }, "Match resumed.")}>
                Resume match
              </CommandButton>
            </div>
          </div>

          <div className="panel">
            <h2 style={{ marginBottom: 12 }}>Teams and bots</h2>
            <div className="command-grid">
              <CommandButton busy={busy} onClick={() => send({ action: "swap-teams" }, "Teams swapped.")}>
                Swap teams
                <small>T and CT change sides</small>
              </CommandButton>
              <CommandButton busy={busy} onClick={() => send({ action: "scramble-teams" }, "Teams scrambled.")}>
                Scramble teams
                <small>Shuffles players</small>
              </CommandButton>
              <CommandButton busy={busy} onClick={() => send({ action: "bot-add", team: "t" }, "Bot added to T.")}>
                Add bot to T
              </CommandButton>
              <CommandButton busy={busy} onClick={() => send({ action: "bot-add", team: "ct" }, "Bot added to CT.")}>
                Add bot to CT
              </CommandButton>
              <CommandButton busy={busy} onClick={() => send({ action: "bot-kick" }, "Bots kicked.")}>
                Kick all bots
              </CommandButton>
            </div>
            <form
              className="row-actions"
              style={{ marginTop: 16, flexWrap: "wrap" }}
              onSubmit={(e) => {
                e.preventDefault();
                void send({ action: "bot-quota", count: quota }, quota === 0 ? "Bots won't fill empty slots." : `Bots fill up to ${quota} players.`);
              }}
            >
              <label className="field" style={{ maxWidth: 220 }}>
                <span>Fill with bots up to</span>
                <input type="number" min={0} max={64} value={quota} onChange={(e) => setQuota(Math.max(0, Math.min(64, Number(e.target.value) || 0)))} />
              </label>
              <button className="btn" disabled={busy} style={{ alignSelf: "flex-end" }}>
                Set bot count
              </button>
            </form>
            <p className="hint" style={{ marginBottom: 0 }}>
              Lasts until the next map change, when the server's config sets it again. To make it permanent, set <code>bot_quota</code> on the{" "}
              <Link to={`/servers/${server.id}/configs`}>Config files</Link> tab.
            </p>
          </div>
        </>
      )}

      <form className="panel" onSubmit={say}>
        <h2 style={{ marginBottom: 6 }}>Message all players</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Shows in chat as a message from the server.
        </p>
        <div className="row-actions" style={{ flexWrap: "wrap" }}>
          <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} placeholder="Server restarts in 5 minutes" aria-label="Message" style={{ flex: "1 1 280px" }} />
          <button className="btn primary" disabled={busy || !message.trim()}>
            Send
          </button>
        </div>
      </form>

      {lastOutput && (
        <div className="panel">
          <h2 style={{ marginBottom: 6 }}>Server reply</h2>
          <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {lastOutput}
          </pre>
        </div>
      )}
    </>
  );
}

function CommandButton({ busy, onClick, children }: { busy: boolean; onClick: () => unknown; children: React.ReactNode }) {
  return (
    <button type="button" className="command-btn" disabled={busy} onClick={() => void onClick()}>
      {children}
    </button>
  );
}
