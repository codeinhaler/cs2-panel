import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Server } from "../../api";
import { useAction, useApp } from "../../app-context";

/** Files CS2 runs by itself on every map start. */
const AUTO_RUN = (name: string) => name === "server.cfg" || /^gamemode_.*_server\.cfg$/.test(name) || name === "cs2panel_generated.cfg";

/** Pick extra cfg files the server runs on every map start. */
export function ConfigsToRunPanel({ server, current, onSaved }: { server: Server; current: string[]; onSaved: () => void }) {
  const { can } = useApp();
  const { busy, run } = useAction();
  /** cfg files (relative to cfg/), split into the server's own and CS2's stock ones. */
  const [files, setFiles] = useState<{ own: string[]; stock: string[] } | null>(null);
  const [picked, setPicked] = useState<string[]>(current);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    void api.configs(server.id).then((r) => {
      const cfgs = r.files.filter((f) => f.path.startsWith("cfg/") && f.path.endsWith(".cfg") && !AUTO_RUN(f.path.slice(4)));
      setFiles({
        own: cfgs.filter((f) => f.source !== "stock").map((f) => f.path.slice(4)),
        stock: cfgs.filter((f) => f.source === "stock").map((f) => f.path.slice(4)),
      });
    });
  }, [server.id]);
  useEffect(() => setPicked(current), [current.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!can("config.edit")) return null;
  const dirty = picked.join("|") !== current.join("|");
  const save = async () => {
    const r = await run(() => api.setExecConfigs(server.id, picked), picked.length ? "Configs to run saved. They apply from the next map." : "No extra configs run anymore.");
    if (r) onSaved();
  };
  const toggle = (name: string, on: boolean) => setPicked((p) => (on ? [...p, name] : p.filter((x) => x !== name)));
  const custom = files?.own ?? [];
  const others = files?.stock ?? [];

  return (
    <div className="panel">
      <h2 style={{ marginBottom: 6 }}>Configs to run</h2>
      <p className="hint" style={{ marginTop: 0, maxWidth: "70ch" }}>
        Extra config files to run on every map start, after <code>server.cfg</code> and the game mode's own settings, so they win. In this order:
      </p>
      {files === null && <p className="hint">Loading…</p>}
      {files && custom.length === 0 && others.length === 0 && (
        <p className="hint">
          No config files to pick yet. Create one, like <code>practice.cfg</code>, on the <Link to={`/servers/${server.id}/configs`}>Config files</Link> tab.
        </p>
      )}
      {files && (
        <div className="exec-list">
          {[...picked.filter((p) => !custom.includes(p) && !others.includes(p)), ...custom, ...(showAll ? others : others.filter((o) => picked.includes(o)))].map((name) => (
            <label key={name} className="check">
              <input type="checkbox" checked={picked.includes(name)} onChange={(e) => toggle(name, e.target.checked)} />
              <span className="mono">{name}</span>
              {picked.includes(name) && picked.length > 1 && <small className="hint">#{picked.indexOf(name) + 1}</small>}
            </label>
          ))}
        </div>
      )}
      <div className="row-actions" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => void save()} disabled={busy || !dirty}>
          Save configs to run
        </button>
        {others.length > 0 && (
          <button type="button" className="btn ghost small" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Hide CS2's own configs" : `Show CS2's own configs too (${others.length})`}
          </button>
        )}
      </div>
    </div>
  );
}

/** Turns this server's setup into a preset for new servers. */
export function SaveAsPresetPanel({ server }: { server: Server }) {
  const { can } = useApp();
  const { busy, run } = useAction();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  if (!can("preset.manage")) return null;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.saveAsPreset(server.id, name, description), `Saved as the preset "${name}".`);
    if (r) navigate("/presets");
  };

  return (
    <div className="panel">
      <h2 style={{ marginBottom: 6 }}>Save as preset</h2>
      <p className="hint" style={{ marginTop: 0, maxWidth: "70ch" }}>
        Makes a preset from this server: its game mode, start map, max players, the config files you've edited or added, and its configs to run. New servers
        can then start from it.
      </p>
      {!open ? (
        <button className="btn" onClick={() => setOpen(true)}>
          Save as preset…
        </button>
      ) : (
        <form className="form-grid" style={{ maxWidth: 640 }} onSubmit={save}>
          <label className="field">
            <span>Preset name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus placeholder={`${server.name} setup`} />
          </label>
          <label className="field">
            <span>Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="Optional" />
          </label>
          <div className="wide row-actions">
            <button className="btn primary" disabled={busy || !name.trim()}>
              Save preset
            </button>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
