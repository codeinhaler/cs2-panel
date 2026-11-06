import { useEffect, useId, useState } from "react";
import { api } from "../api";

type Kind = "stock" | "workshop" | "collection";

/** Mirrors server/src/servers/map-spec.ts. */
function parse(value: string): { kind: Kind; map: string; id: string; startId: string } {
  const w = /^workshop:(\d+)$/.exec(value);
  if (w) return { kind: "workshop", map: "", id: w[1]!, startId: "" };
  const c = /^collection:(\d+)(?:\/(\d+))?$/.exec(value);
  if (c) return { kind: "collection", map: "", id: c[1]!, startId: c[2] ?? "" };
  return { kind: "stock", map: value, id: "", startId: "" };
}

/** Accepts a bare ID or a Workshop link (…/filedetails/?id=123). */
function workshopId(text: string): string {
  return /[?&]id=(\d+)/.exec(text)?.[1] ?? text.trim();
}

let installedCache: Promise<string[]> | null = null;

/**
 * Picks what a server starts on: a map from the CS2 install, one Workshop map,
 * or a Workshop collection. The value is the server's map field text.
 */
export function MapPicker({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const listId = useId();
  const [state, setState] = useState(() => parse(value));
  const [installed, setInstalled] = useState<string[]>([]);

  useEffect(() => {
    installedCache ??= api.installedMaps().then((r) => r.maps, () => []);
    void installedCache.then(setInstalled);
  }, []);

  // Follow outside changes (e.g. the form resetting after save).
  useEffect(() => {
    const p = parse(value);
    setState((cur) => (serialize(cur) === value ? cur : p));
  }, [value]);

  const update = (next: Partial<typeof state>) => {
    const s = { ...state, ...next };
    setState(s);
    onChange(serialize(s));
  };

  return (
    <div className="field wide">
      <span>Start map</span>
      <div className="segmented" role="radiogroup" aria-label="Where the map comes from">
        {(
          [
            ["stock", "Installed map"],
            ["workshop", "Workshop map"],
            ["collection", "Workshop collection"],
          ] as [Kind, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={state.kind === k} className={state.kind === k ? "on" : ""} onClick={() => update({ kind: k })}>
            {label}
          </button>
        ))}
      </div>

      {state.kind === "stock" && (
        <>
          <input
            value={state.map}
            onChange={(e) => update({ map: e.target.value })}
            list={listId}
            placeholder={placeholder ?? "de_dust2"}
            spellCheck={false}
            aria-label="Map name"
          />
          <datalist id={listId}>
            {installed.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </>
      )}

      {state.kind === "workshop" && (
        <>
          <input
            value={state.id}
            onChange={(e) => update({ id: workshopId(e.target.value) })}
            placeholder="Workshop ID or link"
            inputMode="numeric"
            spellCheck={false}
            aria-label="Workshop map ID"
            required
          />
          <small>The number at the end of the map's Workshop link. The server downloads it when it starts.</small>
        </>
      )}

      {state.kind === "collection" && (
        <>
          <div className="map-picker-pair">
            <input
              value={state.id}
              onChange={(e) => update({ id: workshopId(e.target.value) })}
              placeholder="Collection ID or link"
              inputMode="numeric"
              spellCheck={false}
              aria-label="Workshop collection ID"
              required
            />
            <input
              value={state.startId}
              onChange={(e) => update({ startId: workshopId(e.target.value) })}
              placeholder="First map (optional): ID or link"
              inputMode="numeric"
              spellCheck={false}
              aria-label="First map's Workshop ID"
            />
          </div>
          <small>All maps in the collection become the server's map rotation.</small>
        </>
      )}
      {state.kind !== "stock" && <small className="hint">Workshop downloads work best with a GSLT token set on the server.</small>}
    </div>
  );
}

function serialize(s: { kind: Kind; map: string; id: string; startId: string }): string {
  if (s.kind === "workshop") return s.id ? `workshop:${s.id}` : "";
  if (s.kind === "collection") return s.id ? `collection:${s.id}${s.startId ? `/${s.startId}` : ""}` : "";
  return s.map.trim();
}

/** "Workshop map 123" etc. for places that show a server's map. */
export function mapLabel(value: string): string {
  const p = parse(value);
  if (p.kind === "workshop") return `Workshop map ${p.id}`;
  if (p.kind === "collection") return `Workshop collection ${p.id}`;
  return value;
}
