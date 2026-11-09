import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type MapCycle, type Server } from "../../api";
import { WorkshopNote, mapLabel, useWorkshopInfo } from "../../components/MapPicker";
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
    const r = await run(
      () => api.setExecConfigs(server.id, picked),
      picked.length ? "Configs to run saved. They apply from the next map." : "No extra configs run anymore.",
    );
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
          {[
            ...picked.filter((p) => !custom.includes(p) && !others.includes(p)),
            ...custom,
            ...(showAll ? others : others.filter((o) => picked.includes(o))),
          ].map((name) => (
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

/** Casual servers: maps the CS2 Panel Bridge moves through at the end of each match. */
export function MapCyclePanel({ server }: { server: Server }) {
  const { can } = useApp();
  const { busy, run } = useAction();
  const [info, setInfo] = useState<{ mapCycle: MapCycle; bridge: boolean; next: string | null } | null>(null);
  const [form, setForm] = useState<MapCycle>({ maps: [], random: false });
  const [installed, setInstalled] = useState<string[]>([]);
  const [addStock, setAddStock] = useState("");
  const [workshop, setWorkshop] = useState("");
  const workshopId = /(\d{3,20})/.exec(workshop)?.[1] ?? "";
  const wsInfo = useWorkshopInfo(workshopId, "map");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const casual = server.gameType === 0 && server.gameMode === 0;

  const load = () =>
    api.mapCycle(server.id).then((r) => {
      setInfo(r);
      setForm(r.mapCycle);
    });
  useEffect(() => {
    if (!casual) return;
    void load();
    void api.installedMaps().then((r) => setInstalled(r.maps.filter((m) => /^(de|cs|ar|aim)_/.test(m))));
  }, [server.id, casual]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!casual) return null;
  const edit = can("config.edit");
  const dirty = !!info && JSON.stringify(form) !== JSON.stringify(info.mapCycle);
  const label = (m: string) => titles[m] ?? mapLabel(m);
  const move = (i: number, by: number) =>
    setForm((f) => {
      const maps = [...f.maps];
      const j = i + by;
      if (j < 0 || j >= maps.length) return f;
      [maps[i], maps[j]] = [maps[j]!, maps[i]!];
      return { ...f, maps };
    });
  const add = (m: string) => setForm((f) => (f.maps.includes(m) ? f : { ...f, maps: [...f.maps, m] }));
  const canAddWorkshop = !!workshopId && wsInfo !== null && wsInfo !== "loading" && (wsInfo.status === "ok" || wsInfo.status === "unknown");
  const save = async () => {
    const r = await run(
      () => api.setMapCycle(server.id, form),
      form.maps.length >= 2 ? "Map cycle saved. It takes over at the end of the current match." : "Map cycle saved (it needs 2 maps or more to run).",
    );
    if (r) void load();
  };

  return (
    <div className="panel">
      <h2 style={{ marginBottom: 6 }}>Map cycle</h2>
      <p className="hint" style={{ marginTop: 0, maxWidth: "70ch" }}>
        At the end of each match, after 10 seconds of scoreboard, the server loads the next map from this list. Installed and Workshop maps both work. Needs 2
        maps or more; with fewer, CS2 does what it normally does.
      </p>
      {info && !info.bridge && (
        <p className="notice warn">
          This server needs CounterStrikeSharp (with the CS2 Panel Bridge, 1.6.0 or newer) for the map cycle. Install it on the Plugins tab.
        </p>
      )}
      {info?.next && (
        <p className="hint">
          Next map: <b>{label(info.next)}</b>
        </p>
      )}
      {info === null && <p className="hint">Loading…</p>}
      {info && (
        <>
          {form.maps.length === 0 && <p className="hint">No maps in the cycle yet.</p>}
          <ol className="map-cycle-list">
            {form.maps.map((m, i) => (
              <li key={m}>
                <span>{label(m)}</span>
                {edit && (
                  <span className="row-actions">
                    <button type="button" className="btn ghost small" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${label(m)} up`}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => move(i, 1)}
                      disabled={i === form.maps.length - 1}
                      aria-label={`Move ${label(m)} down`}
                    >
                      ↓
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => setForm((f) => ({ ...f, maps: f.maps.filter((x) => x !== m) }))}>
                      Remove
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>
          {edit && (
            <>
              <div className="row-actions" style={{ marginTop: 10, flexWrap: "wrap" }}>
                <select value={addStock} onChange={(e) => setAddStock(e.target.value)} aria-label="Installed map to add" style={{ maxWidth: 220 }}>
                  <option value="">Installed map…</option>
                  {installed
                    .filter((m) => !form.maps.includes(m))
                    .map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="btn small"
                  disabled={!addStock}
                  onClick={() => {
                    add(addStock);
                    setAddStock("");
                  }}
                >
                  Add map
                </button>
                <input
                  value={workshop}
                  onChange={(e) => setWorkshop(e.target.value)}
                  placeholder="Workshop map ID or link"
                  style={{ maxWidth: 220 }}
                  aria-label="Workshop map to add"
                />
                <button
                  type="button"
                  className="btn small"
                  disabled={!canAddWorkshop}
                  onClick={() => {
                    const m = `workshop:${workshopId}`;
                    if (wsInfo && wsInfo !== "loading" && wsInfo.title) setTitles((t) => ({ ...t, [m]: wsInfo.title! }));
                    add(m);
                    setWorkshop("");
                  }}
                >
                  Add Workshop map
                </button>
              </div>
              <WorkshopNote info={wsInfo} />
              <label className="check" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={form.random} onChange={(e) => setForm((f) => ({ ...f, random: e.target.checked }))} />
                <span>Random order (never the same map twice in a row)</span>
              </label>
              <div className="row-actions" style={{ marginTop: 12 }}>
                <button className="btn primary" onClick={() => void save()} disabled={busy || !dirty}>
                  Save map cycle
                </button>
                {dirty && (
                  <button type="button" className="btn ghost" onClick={() => setForm(info.mapCycle)}>
                    Undo changes
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
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
        Makes a preset from this server: its game mode, start map, max players, the config files you've edited or added, and its configs to run. New servers can
        then start from it.
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
