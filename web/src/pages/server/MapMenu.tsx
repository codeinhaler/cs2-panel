import { useEffect, useState } from "react";
import { api, type MapMenu, type Server } from "../../api";
import { useAction, useApp } from "../../app-context";

/** Edits the maps a moderation plugin offers in its in-game change-map menu. */
export function MapMenuPanel({ server, provider }: { server: Server; provider: string }) {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [installed, setInstalled] = useState<string[]>([]);
  const [saved, setSaved] = useState<MapMenu>({ maps: [], workshop: [] });
  const [menu, setMenu] = useState<MapMenu>({ maps: [], workshop: [] });
  const [mapInput, setMapInput] = useState("");
  const [wsName, setWsName] = useState("");
  const [wsId, setWsId] = useState("");

  useEffect(() => {
    api
      .mapMenu(server.id)
      .then((r) => {
        setInstalled(r.installed);
        setMissing(!r.menu);
        const m = r.menu ? { maps: r.menu.maps, workshop: r.menu.workshop } : { maps: [], workshop: [] };
        setSaved(m);
        setMenu(m);
        setLoaded(true);
      })
      .catch((e: Error) => toast(e.message, "error"));
  }, [server.id, toast]);

  const edit = can("config.edit");
  const dirty = JSON.stringify(menu) !== JSON.stringify(saved);
  const notAdded = installed.filter((m) => !menu.maps.includes(m));

  const addMaps = (names: string[]) => {
    const clean = names.map((n) => n.trim()).filter(Boolean);
    setMenu((m) => ({ ...m, maps: [...m.maps, ...clean.filter((n) => !m.maps.includes(n))] }));
  };
  const removeMap = (name: string) => setMenu((m) => ({ ...m, maps: m.maps.filter((x) => x !== name) }));
  const move = (i: number, d: -1 | 1) =>
    setMenu((m) => {
      const maps = [...m.maps];
      const j = i + d;
      if (j < 0 || j >= maps.length) return m;
      [maps[i], maps[j]] = [maps[j]!, maps[i]!];
      return { ...m, maps };
    });

  const addWorkshop = (e: React.FormEvent) => {
    e.preventDefault();
    // Accept a full Workshop URL as well as the bare ID.
    const id = /id=(\d+)/.exec(wsId)?.[1] ?? wsId.trim();
    if (!wsName.trim() || !/^\d+$/.test(id)) {
      toast("Enter the map name and its Workshop ID (or the Workshop link).", "error");
      return;
    }
    setMenu((m) => ({ ...m, workshop: [...m.workshop.filter((w) => w.name !== wsName.trim()), { name: wsName.trim(), id }] }));
    setWsName("");
    setWsId("");
  };

  const save = async () => {
    const r = await run(() => api.saveMapMenu(server.id, menu), "Map list saved. Restart the server for it to show in game.");
    if (r) {
      const m = { maps: r.menu.maps, workshop: r.menu.workshop };
      setSaved(m);
      setMenu(m);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Change-map menu</h2>
          <p className="hint" style={{ margin: "4px 0 0" }}>
            The maps admins can pick from {provider}'s in-game menu (!admin → change map). {provider} reads this list when it starts, so restart the server after
            saving.
          </p>
        </div>
        {edit && loaded && !missing && (
          <div className="row-actions">
            {dirty && (
              <button className="btn ghost small" onClick={() => setMenu(saved)} disabled={busy}>
                Undo changes
              </button>
            )}
            <button className="btn solid small" onClick={() => void save()} disabled={busy || !dirty}>
              Save
            </button>
          </div>
        )}
      </div>

      {!loaded && <p className="hint">Loading…</p>}
      {loaded && missing && (
        <div className="notice info">{provider} creates its config file on its first start. Start the server once, then come back here.</div>
      )}

      {loaded && !missing && (
        <>
          <h3 className="subhead">Maps</h3>
          {menu.maps.length === 0 && <p className="hint">No maps yet, so the in-game menu is empty.</p>}
          {menu.maps.length > 0 && (
            <ul className="map-list">
              {menu.maps.map((m, i) => (
                <li key={m}>
                  <span className="mono">{m}</span>
                  {edit && (
                    <span className="row-actions">
                      <button className="btn ghost small" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${m} up`}>
                        ↑
                      </button>
                      <button className="btn ghost small" onClick={() => move(i, 1)} disabled={i === menu.maps.length - 1} aria-label={`Move ${m} down`}>
                        ↓
                      </button>
                      <button className="btn ghost small" onClick={() => removeMap(m)} aria-label={`Remove ${m}`}>
                        Remove
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {edit && (
            <form
              className="row-actions"
              style={{ marginTop: 12, flexWrap: "wrap" }}
              onSubmit={(e) => {
                e.preventDefault();
                addMaps([mapInput]);
                setMapInput("");
              }}
            >
              <input
                value={mapInput}
                onChange={(e) => setMapInput(e.target.value)}
                list="installed-maps"
                placeholder="Map name, like de_mirage"
                spellCheck={false}
                pattern="[A-Za-z0-9_\-]+"
                title="Letters, digits, _ and - only"
                style={{ maxWidth: 260 }}
              />
              <datalist id="installed-maps">
                {notAdded.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <button className="btn small" disabled={!mapInput.trim()}>
                Add map
              </button>
              {notAdded.length > 0 && (
                <button type="button" className="btn ghost small" onClick={() => addMaps(notAdded)}>
                  Add all {notAdded.length} installed maps
                </button>
              )}
            </form>
          )}

          <h3 className="subhead" style={{ marginTop: 24 }}>
            Workshop maps
          </h3>
          <p className="hint" style={{ marginTop: 0 }}>
            Shown in the menu with "(WS)". The server downloads them when picked, so they don't need to be installed.
          </p>
          {menu.workshop.length > 0 && (
            <ul className="map-list">
              {menu.workshop.map((w) => (
                <li key={w.name}>
                  <span>
                    <span className="mono">{w.name}</span>{" "}
                    <a className="hint" href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${w.id}`} target="_blank" rel="noreferrer">
                      {w.id}
                    </a>
                  </span>
                  {edit && (
                    <button className="btn ghost small" onClick={() => setMenu((m) => ({ ...m, workshop: m.workshop.filter((x) => x.name !== w.name) }))}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {edit && (
            <form className="row-actions" style={{ marginTop: 12, flexWrap: "wrap" }} onSubmit={addWorkshop}>
              <input value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="Name in the menu, like awp_lego_2" spellCheck={false} style={{ maxWidth: 260 }} />
              <input value={wsId} onChange={(e) => setWsId(e.target.value)} placeholder="Workshop ID or link" spellCheck={false} style={{ maxWidth: 260 }} />
              <button className="btn small" disabled={!wsName.trim() || !wsId.trim()}>
                Add workshop map
              </button>
            </form>
          )}
          {dirty && <p className="hint" style={{ marginTop: 16 }}>You have unsaved changes.</p>}
        </>
      )}
    </div>
  );
}
