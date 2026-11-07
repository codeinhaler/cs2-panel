import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type CatalogPlugin, type HostInfo, type Preset } from "../api";
import { useAction, useApp } from "../app-context";
import { MapPicker } from "../components/MapPicker";
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
  const { can, toast } = useApp();
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
  const [catalog, setCatalog] = useState<CatalogPlugin[]>([]);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    void api.presets().then((r) => {
      setPresets(r.presets);
      setPresetId((p) => p ?? r.presets[0]?.id ?? null);
    });
    void api.catalog().then((r) => setCatalog(r.plugins)).catch(() => undefined);
    void api.host().then((h) => {
      setHost(h);
      setCpu(String(h.suggestedCpu));
      if (!h.cs2.installed) setStartNow(false);
    });
  }, []);

  /** True if plugin `id` needs `dep`, directly or through other plugins. */
  const needs = (id: string, dep: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const reqs = catalog.find((c) => c.id === id)?.requires ?? [];
    return reqs.includes(dep) || reqs.some((r) => needs(r, dep, seen));
  };

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
    if (!r) return;
    if (picked.length && can("plugins.manage")) {
      toast(`Created ${name}. Installing plugins…`, "info");
      try {
        // Each install also installs what that plugin needs, so order doesn't matter.
        for (const id of picked) await api.installPlugin(r.server.id, id);
        toast(`Created ${name} with plugins installed.`);
      } catch (e) {
        toast(`Created ${name}, but installing plugins failed: ${(e as Error).message}`, "error");
      }
      navigate(`/servers/${r.server.id}/plugins`);
      return;
    }
    navigate(`/servers/${r.server.id}`);
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
            <MapPicker value={map} onChange={setMap} placeholder={preset?.defaultMap ?? "de_dust2"} gsltSet={!!gslt.trim()} />
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
            {can("plugins.manage") && catalog.length > 0 && (
              <fieldset className="field choice wide">
                <legend>Plugins</legend>
                <div className="plugin-picks">
                  {catalog
                    .filter((p) => !p.library)
                    .map((p) => {
                      const neededBy = catalog.filter((o) => picked.includes(o.id) && o.id !== p.id && needs(o.id, p.id)).map((o) => o.name);
                      // A companion (the panel's bridge) comes along whenever its host plugin is installed.
                      const host = p.companionOf ? catalog.find((o) => o.id === p.companionOf) : undefined;
                      const hostOn = !!host && (picked.includes(host.id) || picked.some((x) => needs(x, host.id)));
                      const on = picked.includes(p.id) || neededBy.length > 0 || hostOn;
                      const locked = neededBy.length > 0 || (hostOn && !picked.includes(p.id));
                      return (
                        <label key={p.id} className="check">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={locked}
                            onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))}
                          />
                          <span>
                            {p.name}
                            <small className="hint">
                              {" — "}
                              {neededBy.length ? `needed by ${neededBy.join(", ")}` : hostOn && !picked.includes(p.id) ? `comes with ${host!.name}` : p.description}
                            </small>
                          </span>
                        </label>
                      );
                    })}
                </div>
                <small className="hint">Optional. Installed right after the server is created, along with anything they need. You can also add them later on the Plugins tab.</small>
              </fieldset>
            )}
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
