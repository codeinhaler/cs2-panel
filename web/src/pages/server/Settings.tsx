import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type HostInfo, type Preset, type Server } from "../../api";
import { useAction, useApp } from "../../app-context";
import { PortField } from "../../components/PortField";

export function SettingsTab({ server: s, onSaved }: { server: Server; onSaved: () => void }) {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [host, setHost] = useState<HostInfo | null>(null);

  const [name, setName] = useState(s.name);
  const [presetId, setPresetId] = useState(s.presetId ?? 0);
  const [applyConfigs, setApplyConfigs] = useState(false);
  const [map, setMap] = useState(s.map);
  const [maxPlayers, setMaxPlayers] = useState(String(s.maxPlayers));
  const [port, setPort] = useState(String(s.port));
  const [cpu, setCpu] = useState(String(s.cpu));
  const [gslt, setGslt] = useState("");
  const [clearGslt, setClearGslt] = useState(false);
  const [password, setPassword] = useState(s.password);
  const [autostart, setAutostart] = useState(s.autostart);
  const [extraArgs, setExtraArgs] = useState(s.extraArgs);

  useEffect(() => {
    void api.presets().then((r) => setPresets(r.presets));
    void api.host().then(setHost);
  }, []);

  if (!can("server.manage")) return <p className="hint">Only Admins and the Owner can change server settings.</p>;

  const running = s.status.state === "active" || s.status.state === "activating";
  const presetChanged = presetId !== (s.presetId ?? 0);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const changes: Record<string, unknown> = {};
    if (name !== s.name) changes.name = name;
    if (presetChanged) changes.presetId = presetId;
    if (applyConfigs) changes.applyPresetConfigs = true;
    if (map !== s.map) changes.map = map;
    if (Number(maxPlayers) !== s.maxPlayers) changes.maxPlayers = Number(maxPlayers);
    if (Number(port) !== s.port) changes.port = Number(port);
    if (Number(cpu) !== s.cpu) changes.cpu = Number(cpu);
    if (gslt.trim()) changes.gsltToken = gslt.trim();
    else if (clearGslt) changes.gsltToken = "";
    if (password !== s.password) changes.password = password;
    if (autostart !== s.autostart) changes.autostart = autostart;
    if (extraArgs !== s.extraArgs) changes.extraArgs = extraArgs;
    if (Object.keys(changes).length === 0) {
      toast("Nothing to save.", "info");
      return;
    }
    const r = await run(() => api.updateServer(s.id, changes));
    if (r) {
      toast(r.restartRequired ? "Settings saved. Restart the server to apply them." : "Settings saved.", r.restartRequired ? "warn" : "ok");
      setGslt("");
      setClearGslt(false);
      setApplyConfigs(false);
      onSaved();
    }
  };

  return (
    <>
      <form onSubmit={save}>
        <div className="panel">
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
            </label>
            <label className="field">
              <span>Game mode</span>
              <select value={presetId} onChange={(e) => setPresetId(Number(e.target.value))}>
                {s.presetId === null && <option value={0}>Custom</option>}
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {(presetChanged || s.presetId !== null) && (
              <label className="check wide">
                <input type="checkbox" checked={applyConfigs} onChange={(e) => setApplyConfigs(e.target.checked)} />
                <span>
                  Also replace this server's config files with the {presetChanged ? "new" : "current"} preset's
                  <small className="hint"> — earlier versions stay in the config history.</small>
                </span>
              </label>
            )}
            <label className="field">
              <span>Start map</span>
              <input value={map} onChange={(e) => setMap(e.target.value)} required />
            </label>
            <label className="field">
              <span>Max players</span>
              <input inputMode="numeric" value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)} required />
            </label>
            <PortField
              value={port}
              onChange={setPort}
              host={host}
              serverId={s.id}
              disabled={running}
              disabledHint="Stop the server to change its port."
            />
            <label className="field">
              <span>CPU core</span>
              <select value={cpu} onChange={(e) => setCpu(e.target.value)}>
                {Array.from({ length: host?.cpuCount ?? s.cpu + 1 }, (_, i) => (
                  <option key={i} value={i}>
                    Core {i}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Steam game server token (GSLT)</span>
              <input
                value={gslt}
                onChange={(e) => setGslt(e.target.value)}
                placeholder={s.gsltSet ? `Set (${s.gsltHint}). Type to replace.` : "Not set"}
                autoComplete="off"
                spellCheck={false}
              />
              {s.gsltSet && (
                <label className="check" style={{ marginTop: 4 }}>
                  <input type="checkbox" checked={clearGslt} onChange={(e) => setClearGslt(e.target.checked)} />
                  <small>Remove the token</small>
                </label>
              )}
            </label>
            <label className="field">
              <span>Join password</span>
              <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="None" autoComplete="off" />
            </label>
            {can("server.rawargs") && (
              <label className="field wide">
                <span>Extra launch arguments</span>
                <input value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} spellCheck={false} />
              </label>
            )}
            <label className="check wide">
              <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
              <span>Start automatically when the machine boots</span>
            </label>
          </div>
          <div className="row-actions" style={{ marginTop: 20 }}>
            <button className="btn primary" disabled={busy}>
              {busy ? "Saving…" : "Save settings"}
            </button>
            {running && <span className="hint">Changes take effect after a restart.</span>}
          </div>
        </div>
      </form>

      <DuplicatePanel server={s} host={host} />
      {can("server.delete") && <DeletePanel server={s} />}
    </>
  );
}

function DuplicatePanel({ server: s, host }: { server: Server; host: HostInfo | null }) {
  const navigate = useNavigate();
  const { busy, run } = useAction();
  const [name, setName] = useState(`${s.name} (copy)`);
  const [port, setPort] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.duplicateServer(s.id, { name, port: Number(port) }), `Created ${name}.`);
    if (r) navigate(`/servers/${r.server.id}`);
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2 style={{ marginBottom: 6 }}>Duplicate</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Creates a new server with this one's settings and config files. It gets its own port, passwords and no GSLT token.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
        </label>
        <PortField value={port} onChange={setPort} host={host} />
      </div>
      <div className="row-actions" style={{ marginTop: 16 }}>
        <button className="btn" disabled={busy || !port}>
          Duplicate server
        </button>
      </div>
    </form>
  );
}

function DeletePanel({ server: s }: { server: Server }) {
  const navigate = useNavigate();
  const { busy, run } = useAction();
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirm, setConfirm] = useState("");

  const remove = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.deleteServer(s.id, confirm), `Deleted ${s.name}.`);
    if (r) navigate("/");
  };

  return (
    <div className="panel">
      <h2 style={{ marginBottom: 6 }}>Delete server</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Stops the server and removes it from the panel. Its config files and plugins are archived on the machine for 30 days. Remember to
        remove the port forward for UDP {s.port}.
      </p>
      <button className="btn danger" onClick={() => dialog.current?.showModal()}>
        Delete {s.name}
      </button>
      <dialog ref={dialog} onClose={() => setConfirm("")}>
        <form onSubmit={remove}>
          <h2>Delete {s.name}?</h2>
          <p>
            Type <code>{s.slug}</code> to confirm.
          </p>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus aria-label="Short name" />
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button className="btn danger solid" disabled={busy || confirm !== s.slug}>
              Delete server
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
