import { useCallback, useEffect, useRef, useState } from "react";
import { api, fullTime, timeAgo, type PluginHealth, type PluginStatus, type Server } from "../../api";
import { useAction, useApp } from "../../app-context";
import { formatDate } from "../../format";

export function PluginsTab({ server }: { server: Server }) {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const [plugins, setPlugins] = useState<PluginStatus[] | null>(null);
  const [dbReady, setDbReady] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [health, setHealth] = useState<PluginHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [versionsFor, setVersionsFor] = useState<PluginStatus | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (refresh = false) => {
      const r = await api.plugins(server.id, refresh);
      setPlugins(r.plugins);
      setDbReady(r.databaseConfigured);
    },
    [server.id],
  );

  useEffect(() => {
    void load().catch((e: Error) => toast(e.message, "error"));
  }, [load, toast]);

  const running = server.status.state === "active" || server.status.state === "activating";
  const manage = can("plugins.manage");
  const byId = new Map(plugins?.map((p) => [p.id, p]));
  const missingDeps = (p: PluginStatus): string[] => {
    const out: string[] = [];
    const visit = (id: string) => {
      const dep = byId.get(id);
      if (!dep || dep.installed || out.includes(dep.name)) return;
      dep.requires.forEach(visit);
      out.push(dep.name);
    };
    p.requires.forEach(visit);
    return out;
  };

  const confirmRestart = (what: string) =>
    !running || window.confirm(`${server.name} is running. It will restart to ${what}, and players are disconnected. Continue?`);

  const doInstall = async (p: PluginStatus, version?: string) => {
    if (!confirmRestart(p.installed ? "update the plugin" : "install the plugin")) return;
    setWorking(p.id);
    const r = await run(() => api.installPlugin(server.id, p.id, version));
    setWorking(null);
    if (!r) return;
    const main = r.installed.at(-1);
    const extra = r.installed.length > 1 ? ` (and ${r.installed.length - 1} required plugin${r.installed.length > 2 ? "s" : ""})` : "";
    const verb = version ? "Switched" : p.installed ? "Updated" : "Installed";
    toast(`${verb} ${p.name} ${version ? "to " : ""}${main?.version ?? ""}${extra}.${r.restarted ? " The server restarted." : ""}`);
    setVersionsFor(null);
    await load();
  };

  const doRollback = async (p: PluginStatus) => {
    if (!p.previousVersion || !window.confirm(`Go back from ${p.name} ${p.installed?.version} to ${p.previousVersion}?`)) return;
    if (!confirmRestart("switch versions")) return;
    setWorking(p.id);
    const r = await run(() => api.rollbackPlugin(server.id, p.id));
    setWorking(null);
    if (r) {
      toast(`${p.name} is back on ${r.version}.${r.restarted ? " The server restarted." : ""}`);
      await load();
    }
  };

  const doRemove = async (p: PluginStatus) => {
    if (!window.confirm(`Remove ${p.name}? Its config files are kept, so reinstalling later picks them up again.`)) return;
    if (!confirmRestart("remove the plugin")) return;
    setWorking(p.id);
    const r = await run(() => api.removePlugin(server.id, p.id));
    setWorking(null);
    if (r) {
      toast(`Removed ${p.name}.${r.restarted ? " The server restarted." : ""}`);
      await load();
    }
  };

  const doUpload = async (file: File) => {
    if (!window.confirm(`Install ${file.name} on ${server.name}? A plugin runs with full access to the game server, so only upload files you trust.`)) return;
    if (!confirmRestart("install the plugin")) return;
    setWorking("upload");
    const r = await run(() => api.uploadPlugin(server.id, file));
    setWorking(null);
    if (r) {
      toast(`Installed ${r.name}.${r.restarted ? " The server restarted." : ""}`);
      await load();
    }
  };

  const check = async () => {
    setChecking(true);
    try {
      setHealth(await api.pluginHealth(server.id));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Plugins</h2>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              Installing a plugin also installs what it needs. Config files are kept on updates.
              {running && " The server restarts for every change."}
            </p>
          </div>
          <div className="row-actions">
            <button className="btn small ghost" onClick={() => void load(true)} disabled={busy}>
              Check for updates
            </button>
            {can("plugins.upload") && (
              <>
                <button className="btn small" onClick={() => fileInput.current?.click()} disabled={busy}>
                  {working === "upload" ? "Uploading…" : "Upload plugin"}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".zip,.tar.gz,.tgz"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void doUpload(f);
                  }}
                />
              </>
            )}
          </div>
        </div>

        {!plugins && <p className="hint">Loading…</p>}
        <div className="plugin-list">
          {plugins?.map((p) => {
            const deps = missingDeps(p);
            const updateAvailable = !!p.installed && !!p.latest && p.latest !== p.installed.version;
            const isWorking = working === p.id;
            return (
              <div key={p.id} className="plugin" data-installed={!!p.installed}>
                <div className="plugin-main">
                  <div className="plugin-name">
                    {p.homepage ? (
                      <a href={p.homepage} target="_blank" rel="noreferrer">
                        {p.name}
                      </a>
                    ) : (
                      p.name
                    )}
                    {p.custom && <span className="tag">uploaded</span>}
                  </div>
                  <div className="hint">{p.description}</div>
                  {p.dependents.length > 0 && <div className="hint">Needed by {p.dependents.join(", ")}</div>}
                  {p.databaseBenefit && !dbReady && (
                    <div className="plugin-db-note">
                      {p.installed ? "Keeps its data on this server only." : "Works on its own."} With the shared database,{" "}
                      {p.databaseBenefit}: run <code>sudo /opt/cs2-panel/deploy/setup-mariadb.sh</code> once
                      {p.installed ? ", then reinstall it here" : " before installing"}.
                    </div>
                  )}
                </div>
                <div className="plugin-version">
                  {p.installed ? (
                    <>
                      <b>{p.installed.version}</b>
                      <div className="hint">
                        installed <span title={fullTime(p.installed.installedAt)}>{timeAgo(p.installed.installedAt)}</span>
                        {p.installed.installedBy ? ` by ${p.installed.installedBy}` : ""}
                      </div>
                      {updateAvailable && <div className="plugin-update">{p.latest} available</div>}
                    </>
                  ) : (
                    <>
                      <span className="hint">Not installed</span>
                      {p.latest && <div className="hint">Latest {p.latest}</div>}
                    </>
                  )}
                  {p.latestError && !p.custom && <div className="hint" title={p.latestError}>Couldn't check for updates</div>}
                </div>
                {manage && (
                  <div className="plugin-actions">
                    {isWorking ? (
                      <span className="hint">Working… downloads can take a minute</span>
                    ) : p.installed ? (
                      <>
                        {updateAvailable && (
                          <button className="btn small primary" disabled={busy} onClick={() => void doInstall(p)}>
                            Update
                          </button>
                        )}
                        {!p.custom && (
                          <button className="btn small ghost" disabled={busy} onClick={() => setVersionsFor(p)}>
                            Versions
                          </button>
                        )}
                        {p.previousVersion && (
                          <button className="btn small ghost" disabled={busy} onClick={() => void doRollback(p)}>
                            Roll back
                          </button>
                        )}
                        <button
                          className="btn small ghost danger"
                          disabled={busy || p.dependents.length > 0}
                          title={p.dependents.length ? `Needed by ${p.dependents.join(", ")}` : undefined}
                          onClick={() => void doRemove(p)}
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn small"
                        disabled={busy}
                        title={deps.length ? `Also installs ${deps.join(", ")}` : undefined}
                        onClick={() => void doInstall(p)}
                      >
                        Install{deps.length ? ` (+${deps.length})` : ""}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Loaded plugins</h2>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              Asks the running server whether Metamod and CounterStrikeSharp actually loaded. After a CS2 update this is the first thing to
              check.
            </p>
          </div>
          <button className="btn small" onClick={check} disabled={checking || server.status.state !== "active"}>
            {checking ? "Checking…" : "Check now"}
          </button>
        </div>
        {server.status.state !== "active" && !health && <p className="hint">Start the server to check.</p>}
        {health && (
          <>
            {!health.reachable ? (
              <div className="notice error">Couldn't reach the server: {health.error}</div>
            ) : (
              <ul className="health">
                <li data-ok={health.metamodLoaded}>{health.metamodLoaded ? "Metamod is loaded" : "Metamod is not loaded"}</li>
                <li data-ok={health.cssharpLoaded}>{health.cssharpLoaded ? "CounterStrikeSharp is loaded" : "CounterStrikeSharp is not loaded"}</li>
              </ul>
            )}
            {(health.metamodOutput || health.cssharpOutput) && (
              <details>
                <summary className="hint">Server output</summary>
                <pre className="log" style={{ marginTop: 8 }}>
                  {[health.metamodOutput, health.cssharpOutput].filter(Boolean).join("\n\n")}
                </pre>
              </details>
            )}
          </>
        )}
      </div>

      {versionsFor && <VersionsDialog plugin={versionsFor} busy={busy} onClose={() => setVersionsFor(null)} onPick={(v) => void doInstall(versionsFor, v)} />}
    </>
  );
}

function VersionsDialog({ plugin, busy, onClose, onPick }: { plugin: PluginStatus; busy: boolean; onClose: () => void; onPick: (v: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<{ version: string; publishedAt: string | null; prerelease: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState("");

  useEffect(() => {
    ref.current?.showModal();
    api
      .pluginVersions(plugin.id)
      .then((r) => {
        setVersions(r.versions);
        setPick(r.versions.find((v) => v.version !== plugin.installed?.version)?.version ?? "");
      })
      .catch((e: Error) => setError(e.message));
  }, [plugin]);

  return (
    <dialog ref={ref} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pick) onPick(pick);
        }}
      >
        <h2>{plugin.name} versions</h2>
        <p className="hint">Installed: {plugin.installed?.version}. Picking another version replaces it; config files are kept.</p>
        {error && <div className="notice error">{error}</div>}
        {!versions && !error && <p className="hint">Loading…</p>}
        {versions && (
          <label className="field">
            <span>Version</span>
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              {versions.map((v) => (
                <option key={v.version} value={v.version} disabled={v.version === plugin.installed?.version}>
                  {v.version}
                  {v.prerelease ? " (pre-release)" : ""}
                  {v.publishedAt ? `, ${formatDate(new Date(v.publishedAt))}` : ""}
                  {v.version === plugin.installed?.version ? " (installed)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !pick}>
            Install this version
          </button>
        </div>
      </form>
    </dialog>
  );
}
