import { useEffect, useRef, useState } from "react";
import { api, timeAgo, type GameState } from "../api";
import { useAction, useApp } from "../app-context";

export function GameUpdatePage() {
  const { can } = useApp();
  const { busy, run } = useAction();
  const [state, setState] = useState<GameState | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [validate, setValidate] = useState(false);
  const [warn, setWarn] = useState("60");
  const next = useRef(0);
  const logBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const s = await api.game(next.current);
        if (stopped) return;
        setState(s);
        if (s.lines.length) setLines((prev) => (next.current === 0 ? s.lines : [...prev, ...s.lines]));
        next.current = s.next;
        timer = window.setTimeout(poll, s.job.state === "running" ? 1000 : 5000);
      } catch {
        timer = window.setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [lines]);

  const start = async () => {
    const installed = state?.cs2.installed;
    const msg = installed
      ? "All servers will be stopped while CS2 updates. Running servers start again afterwards. Continue?"
      : "This downloads CS2 (about 60 GB) and can take a long time. Continue?";
    if (!window.confirm(msg)) return;
    next.current = 0;
    setLines([]);
    const ok = await run(() => api.startUpdate(validate || !installed, Number(warn) || 0));
    if (ok) setState((s) => (s ? { ...s, job: { ...s.job, state: "running" } } : s));
  };

  if (!state) return null;
  const running = state.job.state === "running";
  const installed = state.cs2.installed;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Game update</h1>
          <p>
            {installed
              ? `CS2 ${state.cs2.patchVersion ?? "unknown version"} is installed${state.cs2.buildId ? ` (build ${state.cs2.buildId})` : ""}.`
              : "CS2 isn't installed on this machine yet."}
          </p>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginBottom: 6 }}>{installed ? "Update CS2" : "Install CS2"}</h2>
        <p className="hint" style={{ marginTop: 0, maxWidth: "70ch" }}>
          {installed
            ? "Every server shares one CS2 install. Updating stops all servers, updates the install with SteamCMD, refreshes each server's Metamod setup, and starts the servers that were running."
            : "Downloads the CS2 dedicated server with SteamCMD. It's about 60 GB; on a spinning disk this can take an hour or more."}
        </p>
        {can("game.update") ? (
          <div className="form-grid" style={{ maxWidth: 640 }}>
            {installed && (
              <label className="field">
                <span>Warn players first</span>
                <select value={warn} onChange={(e) => setWarn(e.target.value)} disabled={running}>
                  <option value="0">No warning, stop right away</option>
                  <option value="30">30 seconds</option>
                  <option value="60">1 minute</option>
                  <option value="180">3 minutes</option>
                  <option value="300">5 minutes</option>
                </select>
              </label>
            )}
            {installed && (
              <label className="check" style={{ alignSelf: "end", paddingBottom: 8 }}>
                <input type="checkbox" checked={validate} onChange={(e) => setValidate(e.target.checked)} disabled={running} />
                <span>
                  Verify all files
                  <small className="hint"> — slower; use if a server won't start after an update</small>
                </span>
              </label>
            )}
            <div className="wide">
              <button className="btn primary" onClick={start} disabled={busy || running}>
                {running ? "Updating…" : installed ? "Update now" : "Install CS2"}
              </button>
            </div>
          </div>
        ) : (
          <p className="hint">Only Admins and the Owner can run updates.</p>
        )}
      </div>

      {(lines.length > 0 || state.job.state !== "idle") && (
        <div className="panel">
          <div className="panel-head">
            <h2>{running ? "Update in progress" : "Last update"}</h2>
            {state.job.state === "succeeded" && <span className="state-pill" data-state="active">Finished {timeAgo(state.job.finishedAt)}</span>}
            {state.job.state === "failed" && <span className="state-pill" data-state="failed">Failed {timeAgo(state.job.finishedAt)}</span>}
            {running && <span className="state-pill" data-state="activating">Running</span>}
          </div>
          <div className="log" ref={logBox} role="log" aria-live="polite">
            {lines.join("\n") || "Waiting for output…"}
          </div>
        </div>
      )}
    </>
  );
}
