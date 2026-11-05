import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type HostInfo, type Preset } from "../api";
import { useAction, useApp } from "../app-context";
import { PortField } from "../components/PortField";

const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "") || "server";

export function NewServerPage() {
  const { can } = useApp();
  const navigate = useNavigate();
  const { busy, run } = useAction();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [host, setHost] = useState<HostInfo | null>(null);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [presetId, setPresetId] = useState<number | null>(null);
  const [map, setMap] = useState("");
  const [maxPlayers, setMaxPlayers] = useState("");
  const [port, setPort] = useState("");
  const [cpu, setCpu] = useState("");
  const [gslt, setGslt] = useState("");
  const [password, setPassword] = useState("");
  const [autostart, setAutostart] = useState(true);
  const [startNow, setStartNow] = useState(true);
  const [extraArgs, setExtraArgs] = useState("");

  useEffect(() => {
    void api.presets().then((r) => {
      setPresets(r.presets);
      setPresetId((p) => p ?? r.presets[0]?.id ?? null);
    });
    void api.host().then((h) => {
      setHost(h);
      setCpu(String(h.suggestedCpu));
      if (!h.cs2.installed) setStartNow(false);
    });
  }, []);

  const preset = useMemo(() => presets.find((p) => p.id === presetId) ?? null, [presets, presetId]);
  const effectiveSlug = slugEdited ? slug : slugify(name);

  if (!can("server.manage")) return <div className="notice error">You don't have permission to create servers.</div>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preset) return;
    const r = await run(
      () =>
        api.createServer({
          name,
          slug: effectiveSlug,
          presetId: preset.id,
          map: map.trim() || undefined,
          maxPlayers: maxPlayers ? Number(maxPlayers) : undefined,
          port: Number(port),
          cpu: Number(cpu),
          gsltToken: gslt.trim(),
          password,
          autostart,
          startNow,
          extraArgs: extraArgs.trim(),
        }),
      `Created ${name}.`,
    );
    if (r) navigate(`/servers/${r.server.id}`);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New server</h1>
          <p>Every server shares the one CS2 install and gets its own configs and plugins.</p>
        </div>
      </div>

      <form onSubmit={submit}>
        <div className="panel">
          <h2 style={{ marginBottom: 14 }}>Basics</h2>
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Retakes #1" required maxLength={64} autoFocus />
              <small>Shown in the server browser.</small>
            </label>
            <label className="field">
              <span>Short name</span>
              <input
                value={effectiveSlug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                pattern="[a-z0-9][a-z0-9\-]{0,31}"
                required
              />
              <small>Used for folders and the system service. Lowercase letters, numbers and dashes.</small>
            </label>
            <label className="field wide">
              <span>Game mode</span>
              <select value={presetId ?? ""} onChange={(e) => setPresetId(Number(e.target.value))}>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {preset && <small>{preset.description}</small>}
            </label>
            <label className="field">
              <span>Start map</span>
              <input value={map} onChange={(e) => setMap(e.target.value)} placeholder={preset?.defaultMap ?? "de_dust2"} />
            </label>
            <label className="field">
              <span>Max players</span>
              <input
                inputMode="numeric"
                value={maxPlayers}
                onChange={(e) => setMaxPlayers(e.target.value)}
                placeholder={String(preset?.maxPlayers ?? 10)}
              />
            </label>
          </div>
        </div>

        <div className="panel">
          <h2 style={{ marginBottom: 14 }}>Network and access</h2>
          <div className="form-grid">
            <PortField value={port} onChange={setPort} host={host} />
            <label className="field">
              <span>CPU core</span>
              <select value={cpu} onChange={(e) => setCpu(e.target.value)}>
                {Array.from({ length: host?.cpuCount ?? 1 }, (_, i) => (
                  <option key={i} value={i}>
                    Core {i}
                    {i === (host?.cpuCount ?? 1) - 1 ? " (shared with the panel)" : ""}
                    {i === host?.suggestedCpu ? " (suggested)" : ""}
                  </option>
                ))}
              </select>
              <small>Each server runs best on its own core.</small>
            </label>
            <label className="field">
              <span>Steam game server token (GSLT)</span>
              <input value={gslt} onChange={(e) => setGslt(e.target.value)} placeholder="Optional" autoComplete="off" spellCheck={false} />
              <small>
                Needed to appear in the public server list. Create one per server at{" "}
                <a href="https://steamcommunity.com/dev/managegameservers" target="_blank" rel="noreferrer">
                  Steam's game server page
                </a>{" "}
                with app ID 730.
              </small>
            </label>
            <label className="field">
              <span>Join password</span>
              <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave empty for a public server" autoComplete="off" />
            </label>
            {can("server.rawargs") && (
              <label className="field wide">
                <span>Extra launch arguments</span>
                <input value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} placeholder="Optional, e.g. +sv_visiblemaxplayers 12" spellCheck={false} />
              </label>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="form-grid">
            <label className="check">
              <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
              <span>Start automatically when the machine boots</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={startNow} disabled={!host?.cs2.installed} onChange={(e) => setStartNow(e.target.checked)} />
              <span>
                Start it now
                {host && !host.cs2.installed && <small className="hint"> (install CS2 first)</small>}
              </span>
            </label>
          </div>
        </div>

        <div className="row-actions" style={{ marginTop: 20 }}>
          <button className="btn primary" disabled={busy || !preset || !name || !port}>
            {busy ? "Creating…" : "Create server"}
          </button>
          <Link to="/" className="btn ghost">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
