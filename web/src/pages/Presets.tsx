import { useEffect, useState } from "react";
import { api, GAME_MODE_NAMES, type Preset, type PresetInput } from "../api";
import { useAction, useApp } from "../app-context";
import { MapPicker, mapLabel } from "../components/MapPicker";

/** Files CS2 runs by itself, so they can't be picked as "configs to run". */
const AUTO_RUN = (name: string) => name === "server.cfg" || /^gamemode_.*_server\.cfg$/.test(name);

const blank: PresetInput = {
  name: "",
  description: "",
  gameType: 0,
  gameMode: 0,
  defaultMap: "de_dust2",
  maxPlayers: 10,
  configFiles: { "server.cfg": "" },
  execConfigs: [],
};

export function PresetsPage() {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const [presets, setPresets] = useState<Preset[] | null>(null);
  /** null = list; "new" = new preset; a preset = editing it. */
  const [editing, setEditing] = useState<{ id: number | null; input: PresetInput } | null>(null);

  const load = () =>
    api
      .presets()
      .then((r) => setPresets(r.presets))
      .catch((e: Error) => toast(e.message, "error"));
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const manage = can("preset.manage");
  const toInput = (p: Preset): PresetInput => ({
    name: p.name,
    description: p.description,
    gameType: p.gameType,
    gameMode: p.gameMode,
    defaultMap: p.defaultMap,
    maxPlayers: p.maxPlayers,
    configFiles: { ...p.configFiles },
    execConfigs: [...p.execConfigs],
  });

  const remove = async (p: Preset) => {
    if (!window.confirm(`Delete the preset "${p.name}"? Servers made from it keep their settings and files.`)) return;
    if (await run(() => api.deletePreset(p.id), `Deleted "${p.name}".`)) await load();
  };

  if (editing) {
    return (
      <PresetEditor
        initial={editing.input}
        isNew={editing.id === null}
        busy={busy}
        onCancel={() => setEditing(null)}
        onSave={async (input) => {
          const r = await run(
            () => (editing.id === null ? api.createPreset(input) : api.updatePreset(editing.id, input)),
            editing.id === null ? `Created "${input.name}".` : `Saved "${input.name}".`,
          );
          if (r) {
            setEditing(null);
            await load();
          }
        }}
      />
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Presets</h1>
          <p>Starting points for new servers: game mode, map, player count and config files.</p>
        </div>
        {manage && (
          <button className="btn primary" onClick={() => setEditing({ id: null, input: structuredClone(blank) })}>
            New preset
          </button>
        )}
      </div>
      {manage && (
        <p className="hint" style={{ marginTop: -8 }}>
          Tip: set up a server the way you like it, then use <b>Save as preset</b> on its Settings tab.
        </p>
      )}
      {presets && (
        <div className="panel" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Preset</th>
                  <th>Game mode</th>
                  <th>Start map</th>
                  <th>Players</th>
                  <th>Config files</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {presets.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.name}</b>
                      {p.builtin && <span className="hint"> · built in</span>}
                      {p.description && (
                        <small className="hint" style={{ display: "block" }}>
                          {p.description}
                        </small>
                      )}
                    </td>
                    <td>{GAME_MODE_NAMES[`${p.gameType}/${p.gameMode}`] ?? `${p.gameType}/${p.gameMode}`}</td>
                    <td className="mono">{mapLabel(p.defaultMap)}</td>
                    <td>{p.maxPlayers}</td>
                    <td>
                      {Object.keys(p.configFiles).length}
                      {p.execConfigs.length > 0 && <small className="hint"> · runs {p.execConfigs.join(", ")}</small>}
                    </td>
                    <td>
                      {manage && (
                        <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                          {p.builtin ? (
                            <button className="btn small" onClick={() => setEditing({ id: null, input: { ...toInput(p), name: `${p.name} (copy)` } })}>
                              Copy
                            </button>
                          ) : (
                            <>
                              <button className="btn small" onClick={() => setEditing({ id: p.id, input: toInput(p) })}>
                                Edit
                              </button>
                              <button className="btn small ghost" onClick={() => setEditing({ id: null, input: { ...toInput(p), name: `${p.name} (copy)` } })}>
                                Copy
                              </button>
                              <button className="btn small danger" disabled={busy} onClick={() => void remove(p)}>
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function PresetEditor({
  initial,
  isNew,
  busy,
  onCancel,
  onSave,
}: {
  initial: PresetInput;
  isNew: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (p: PresetInput) => Promise<void>;
}) {
  const [p, setP] = useState<PresetInput>(initial);
  const [newFile, setNewFile] = useState("");
  const files = Object.keys(p.configFiles).sort((a, b) => (a === "server.cfg" ? -1 : b === "server.cfg" ? 1 : a.localeCompare(b)));
  const set = <K extends keyof PresetInput>(k: K, v: PresetInput[K]) => setP((x) => ({ ...x, [k]: v }));
  const mode = `${p.gameType}/${p.gameMode}`;

  const addFile = (e: React.FormEvent) => {
    e.preventDefault();
    let name = newFile.trim().replace(/^cfg\//, "");
    if (!name) return;
    if (!name.endsWith(".cfg")) name += ".cfg";
    if (!p.configFiles[name]) set("configFiles", { ...p.configFiles, [name]: "" });
    setNewFile("");
  };
  const removeFile = (name: string) => {
    const { [name]: _gone, ...rest } = p.configFiles;
    setP((x) => ({ ...x, configFiles: rest, execConfigs: x.execConfigs.filter((c) => c !== name) }));
  };
  const toggleExec = (name: string, on: boolean) =>
    set("execConfigs", on ? [...p.execConfigs, name] : p.execConfigs.filter((c) => c !== name));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(p);
      }}
    >
      <div className="page-head">
        <div>
          <h1>{isNew ? "New preset" : `Edit ${initial.name}`}</h1>
          <p>Changes apply to servers you create from now on. Existing servers keep their files.</p>
        </div>
      </div>

      <div className="panel">
        <div className="form-grid">
          <label className="field">
            <span>Name</span>
            <input value={p.name} onChange={(e) => set("name", e.target.value)} maxLength={40} required autoFocus />
          </label>
          <label className="field">
            <span>Game mode</span>
            <select
              value={mode}
              onChange={(e) => {
                const [t, m] = e.target.value.split("/").map(Number);
                setP((x) => ({ ...x, gameType: t!, gameMode: m! }));
              }}
            >
              {Object.entries(GAME_MODE_NAMES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
              {!GAME_MODE_NAMES[mode] && <option value={mode}>Type {p.gameType} / mode {p.gameMode}</option>}
            </select>
          </label>
          <label className="field wide">
            <span>Description</span>
            <input value={p.description} onChange={(e) => set("description", e.target.value)} maxLength={200} placeholder="Optional" />
          </label>
          <MapPicker value={p.defaultMap} onChange={(v) => set("defaultMap", v)} />
          <label className="field">
            <span>Max players</span>
            <input type="number" min={2} max={64} value={p.maxPlayers} onChange={(e) => set("maxPlayers", Number(e.target.value))} required />
          </label>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginBottom: 6 }}>Config files</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Copied into each new server's <code>cfg</code> folder. <code>server.cfg</code> runs by itself on every map start; tick "Run on every map start" for any other file
          that should too.
        </p>
        {files.map((name) => (
          <div key={name} className="preset-file">
            <div className="preset-file-head">
              <span className="mono">{name}</span>
              <span className="row-actions">
                {!AUTO_RUN(name) && (
                  <label className="check">
                    <input type="checkbox" checked={p.execConfigs.includes(name)} onChange={(e) => toggleExec(name, e.target.checked)} />
                    <span>Run on every map start</span>
                  </label>
                )}
                <button type="button" className="btn ghost small" onClick={() => removeFile(name)} aria-label={`Remove ${name}`}>
                  Remove
                </button>
              </span>
            </div>
            <textarea
              className="mono"
              rows={Math.min(16, Math.max(4, p.configFiles[name]!.split("\n").length + 1))}
              value={p.configFiles[name]}
              onChange={(e) => set("configFiles", { ...p.configFiles, [name]: e.target.value })}
              spellCheck={false}
              aria-label={`Contents of ${name}`}
            />
          </div>
        ))}
        <div className="row-actions" style={{ marginTop: 12 }}>
          <input
            value={newFile}
            onChange={(e) => setNewFile(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addFile(e);
            }}
            placeholder="practice.cfg"
            spellCheck={false}
            style={{ maxWidth: 240 }}
            aria-label="New file name"
          />
          <button type="button" className="btn small" onClick={addFile} disabled={!newFile.trim()}>
            Add file
          </button>
        </div>
      </div>

      <div className="row-actions">
        <button className="btn primary" disabled={busy}>
          {isNew ? "Create preset" : "Save preset"}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
