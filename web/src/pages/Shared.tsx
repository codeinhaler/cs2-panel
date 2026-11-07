import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type SharedConfig } from "../api";
import { useAction, useApp } from "../app-context";

/** Settings every server gets, unless it opts out; a server's own server.cfg overrides them. */
export function SharedPage() {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const [saved, setSaved] = useState<SharedConfig | null>(null);
  const [form, setForm] = useState<SharedConfig | null>(null);
  const [servers, setServers] = useState<{ id: number; name: string }[]>([]);

  const load = () =>
    api
      .shared()
      .then((r) => {
        setSaved(r.shared);
        setForm(r.shared);
        setServers(r.preview.map((p) => ({ id: p.id, name: p.name })));
      })
      .catch((e: Error) => toast(e.message, "error"));
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form || !saved) return null;
  const manage = can("server.manage");
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const set = <K extends keyof SharedConfig>(k: K, v: SharedConfig[K]) => setForm({ ...form, [k]: v });
  const toggle = (id: number, uses: boolean) => set("excluded", uses ? form.excluded.filter((x) => x !== id) : [...form.excluded, id]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.saveShared(form));
    if (r) {
      toast(
        r.liveOn.length
          ? `Saved and applied to ${r.liveOn.join(", ")} right away. Other servers pick it up when they start.`
          : "Saved. Servers pick it up when they start.",
        "ok",
      );
      setSaved(r.shared);
      setForm(r.shared);
    }
  };

  return (
    <form onSubmit={save}>
      <div className="page-head">
        <div>
          <h1>Shared settings</h1>
          <p>Set things once for all your servers. A server's own server.cfg can still change any of them.</p>
        </div>
      </div>

      <div className="panel">
        <div className="form-grid">
          <label className="field">
            <span>Hostname prefix</span>
            <input value={form.hostnamePrefix} onChange={(e) => set("hostnamePrefix", e.target.value)} maxLength={32} placeholder="[Sune] " disabled={!manage} />
            <small>Put in front of every server's name in the server browser. Include a space at the end if you want one.</small>
          </label>
          <label className="field">
            <span>Tags</span>
            <input value={form.tags} onChange={(e) => set("tags", e.target.value)} maxLength={128} placeholder="community, casual, danish" disabled={!manage} />
            <small>Words separated by commas. They help people find your servers in the browser.</small>
          </label>
          <label className="field wide">
            <span>Settings for every server</span>
            <textarea
              className="mono"
              rows={10}
              value={form.cvars}
              onChange={(e) => set("cvars", e.target.value)}
              spellCheck={false}
              placeholder={"// One setting per line, like in a cfg file\nsv_allow_votes 1\nmp_autokick 0\nsv_alltalk 0"}
              disabled={!manage}
            />
            <small>
              They run at the top of each server's server.cfg, so a line in a server's own server.cfg wins. Passwords, the hostname, game mode and map commands
              aren't allowed here; the panel sets those.
            </small>
          </label>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginBottom: 6 }}>Servers</h2>
        <p className="hint" style={{ marginTop: 0 }}>Untick a server to leave it out completely.</p>
        <div className="exec-list">
          {servers.map((s) => {
            const uses = !form.excluded.includes(s.id);
            return (
              <label key={s.id} className="check">
                <input type="checkbox" checked={uses} onChange={(e) => toggle(s.id, e.target.checked)} disabled={!manage} />
                <span>
                  <Link to={`/servers/${s.id}`}>{s.name}</Link>
                  <span className="hint"> · shows as </span>
                  <b>{uses && form.hostnamePrefix ? `${form.hostnamePrefix}${s.name}` : s.name}</b>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {manage && (
        <div className="row-actions">
          <button className="btn primary" disabled={busy || !dirty}>
            Save and apply
          </button>
          {dirty && (
            <button type="button" className="btn ghost" onClick={() => setForm(saved)}>
              Undo changes
            </button>
          )}
        </div>
      )}
    </form>
  );
}
