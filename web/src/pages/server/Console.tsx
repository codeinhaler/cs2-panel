import { useEffect, useRef, useState } from "react";
import { api, type Server } from "../../api";
import { useApp } from "../../app-context";
import { formatLogLine } from "../../format";

interface Line {
  kind: "log" | "cmd" | "out" | "err";
  text: string;
}

const MAX_LINES = 2000;

export function ConsoleTab({ server }: { server: Server }) {
  const { can } = useApp();
  const [lines, setLines] = useState<Line[]>([]);
  const [connected, setConnected] = useState(false);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const push = (l: Line[]) => setLines((prev) => [...prev, ...l].slice(-MAX_LINES));

  useEffect(() => {
    setLines([]);
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/api/servers/${server.id}/console`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { type: string; line?: string; message?: string };
      if (msg.type === "log" && msg.line !== undefined) push([{ kind: "log", text: msg.line }]);
      if (msg.type === "error") push([{ kind: "err", text: msg.message ?? "Console error" }]);
    };
    return () => ws.close();
  }, [server.id]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = command.trim();
    if (!cmd) return;
    setSending(true);
    setHistory((h) => [cmd, ...h.filter((x) => x !== cmd)].slice(0, 50));
    setHistPos(-1);
    setCommand("");
    push([{ kind: "cmd", text: `> ${cmd}` }]);
    stick.current = true;
    try {
      const { output } = await api.rcon(server.id, cmd);
      push([{ kind: "out", text: output.trimEnd() || "(no output)" }]);
    } catch (err) {
      push([{ kind: "err", text: (err as Error).message }]);
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const p = Math.min(histPos + 1, history.length - 1);
      setHistPos(p);
      setCommand(history[p] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const p = histPos - 1;
      setHistPos(Math.max(p, -1));
      setCommand(p >= 0 ? (history[p] ?? "") : "");
    }
  };

  const running = server.status.state === "active";

  return (
    <>
      <div className="console" ref={box} onScroll={onScroll} role="log" aria-live="polite" aria-label="Server output">
        {!connected && lines.length === 0 && "Connecting to the server log…"}
        {lines.map((l, i) => (
          <div key={i} className={l.kind === "log" ? undefined : l.kind}>
            {l.kind === "log" ? formatLogLine(l.text) : l.text}
          </div>
        ))}
      </div>
      {can("rcon") ? (
        <form className="console-input" onSubmit={send}>
          <label className="visually-hidden" htmlFor="rcon-cmd">
            Console command
          </label>
          <input
            id="rcon-cmd"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKey}
            placeholder={running ? "Type a console command, e.g. status or changelevel de_nuke" : "Start the server to send commands"}
            disabled={!running}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn primary" disabled={!running || sending || !command.trim()}>
            Send
          </button>
        </form>
      ) : (
        <p className="hint">You can watch the log. Sending commands needs the Admin role.</p>
      )}
    </>
  );
}
