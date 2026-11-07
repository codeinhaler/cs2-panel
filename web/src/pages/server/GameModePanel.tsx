import { useEffect, useId, useState } from "react";
import { api, GAME_MODE_NAMES, type Preset, type Server } from "../../api";
import { useAction, useApp } from "../../app-context";
import { mapLabel } from "../../components/MapPicker";

type ModeState = Awaited<ReturnType<typeof api.gameMode>>;

/** Switch a running server to another preset's game mode, now or for good. */
export function GameModePanel({ server, onKept }: { server: Server; onKept: () => void }) {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const mapsId = useId();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [maps, setMaps] = useState<string[]>([]);
  const [mode, setMode] = useState<ModeState | null>(null);
  const [presetId, setPresetId] = useState<number | null>(null);
  const [map, setMap] = useState("");
  const [keep, setKeep] = useState(false);
  const [applyConfigs, setApplyConfigs] = useState(false);

  const loadMode = () => api.gameMode(server.id).then(setMode, () => undefined);
  useEffect(() => {
    void api.presets().then((r) => setPresets(r.presets));
    void api.installedMaps().then((r) => setMaps(r.maps), () => undefined);
    void loadMode();
  }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const manage = can("server.manage");
  const preset = presets.find((p) => p.id === presetId) ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preset) return;
    const raw = map.trim();
    const id = /[?&]id=(\d+)/.exec(raw)?.[1] ?? (/^\d+$/.test(raw) ? raw : null);
    const chosenMap = raw ? (id ? `workshop:${id}` : raw) : undefined;
    const what = `${preset.name} on ${mapLabel(chosenMap ?? preset.defaultMap)}`;
    if (server.live && server.live.players - server.live.bots > 0 && !window.confirm(`Switch to ${what}? Everyone on the server moves to the new map.`)) return;
    const r = await run(() => api.switchGameMode(server.id, { presetId: preset.id, map: chosenMap, keep: keep && manage, applyConfigs: keep && applyConfigs }));
    if (r) {
      toast(`Switching to ${what}${keep ? "" : " until the next restart"}.${r.maxPlayersNote ? ` ${r.maxPlayersNote}` : ""}`, r.maxPlayersNote ? "warn" : "ok");
      setMap("");
      setApplyConfigs(false);
      await loadMode();
      if (keep) onKept();
    }
  };

  const savedName = mode ? (mode.saved.presetName ?? GAME_MODE_NAMES[`${mode.saved.gameType}/${mode.saved.gameMode}`] ?? "Custom") : "…";

  return (
    <form className="panel" onSubmit={submit}>
      <h2 style={{ marginBottom: 6 }}>Game mode</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        {mode?.live ? (
          <>
            Running now: <b>{mode.live.presetName}</b> until the next restart. Saved game mode: <b>{savedName}</b>.
          </>
        ) : (
          <>
            Game mode: <b>{savedName}</b>.
          </>
        )}{" "}
        Switching loads a map in the new mode, so everyone on the server moves with it.
      </p>
      <div className="form-grid" style={{ maxWidth: 720 }}>
        <label className="field">
          <span>Switch to</span>
          <select value={presetId ?? ""} onChange={(e) => setPresetId(e.target.value ? Number(e.target.value) : null)} required>
            <option value="">Pick a preset…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.builtin ? "" : " (yours)"}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Map</span>
          <input
            value={map}
            onChange={(e) => setMap(e.target.value)}
            list={mapsId}
            placeholder={preset ? `${mapLabel(preset.defaultMap)} (the preset's map)` : "The preset's map"}
            spellCheck={false}
          />
          <datalist id={mapsId}>
            {maps.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
      </div>

      <fieldset className="choice-list" style={{ marginTop: 12 }}>
        <legend className="visually-hidden">How long</legend>
        <label className="choice">
          <input type="radio" name="keep" checked={!keep} onChange={() => setKeep(false)} />
          <span>
            Until the next restart
            <small className="hint" style={{ display: "block" }}>
              Good for a quick round of something else. A restart goes back to {savedName}.
            </small>
          </span>
        </label>
        {manage && (
          <label className="choice">
            <input type="radio" name="keep" checked={keep} onChange={() => setKeep(true)} />
            <span>
              Keep it
              <small className="hint" style={{ display: "block" }}>
                Becomes the server's game mode in Settings, with the preset's map and max players{preset && preset.maxPlayers !== server.maxPlayers ? ` (${preset.maxPlayers}; applies after a restart)` : ""}.
              </small>
            </span>
          </label>
        )}
      </fieldset>
      {keep && manage && (
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={applyConfigs} onChange={(e) => setApplyConfigs(e.target.checked)} />
          <span>Also copy the preset's config files to the server (replaces files with the same name, like server.cfg; earlier versions stay in the history)</span>
        </label>
      )}
      <div className="row-actions" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={busy || !preset}>
          Switch game mode
        </button>
      </div>
    </form>
  );
}
