import { useCallback, useEffect, useState } from "react";
import { api, fullTime, timeAgo, type BackupInfo, type BackupSettings, type Server } from "../api";
import { useAction, useApp } from "../app-context";
import { fmtBytes } from "../components/LineChart";
import { TimeSelect } from "../components/TimeSelect";

const WHY: Record<BackupInfo["trigger"], string> = {
  manual: "Made by hand",
  nightly: "Nightly",
  "before-restore": "Before a restore",
};

export function BackupsPage() {
  const { can, toast } = useApp();
  const { busy, run } = useAction();
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [total, setTotal] = useState(0);
  const [saved, setSaved] = useState<BackupSettings | null>(null);
  const [form, setForm] = useState<BackupSettings | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([api.backups(), api.servers()]);
      setBackups(b.backups);
      setTotal(b.totalBytes);
      setSaved(b.settings);
      setForm((f) => f ?? b.settings);
      setServers(s.servers);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const manage = can("server.manage");
  const owner = can("users.manage");

  const backupServer = async (s: Server) => {
    setWorking(`server-${s.id}`);
    const r = await run(() => api.backupServer(s.id), `Backed up ${s.name}.`);
    setWorking(null);
    if (r) await load();
  };
  const backupPanel = async () => {
    setWorking("panel");
    const r = await run(() => api.backupPanel(), "Backed up the panel's database.");
    setWorking(null);
    if (r) await load();
  };
  const remove = async (b: BackupInfo) => {
    if (!window.confirm(`Delete this backup of ${b.serverName ?? "the panel's database"} from ${fullTime(b.createdAt)}? It can't be undone.`)) return;
    if (await run(() => api.deleteBackup(b.id), "Backup deleted.")) await load();
  };
  const restore = async (b: BackupInfo) => {
    const ok = window.confirm(
      `Restore ${b.serverName} to how it was on ${fullTime(b.createdAt)}?\n\n` +
        "Its files (configs, plugins and their data, added maps), its plugin list and its configs to run go back to that point. " +
        "Settings like port and name stay as they are now.\n\n" +
        "The server stops for the restore and starts again if it was running. The current state is backed up first.",
    );
    if (!ok) return;
    setWorking(b.id);
    const r = await run(() => api.restoreBackup(b.id));
    setWorking(null);
    if (r) {
      toast(`Restored ${b.serverName}${r.restarted ? " and started it again" : ""}. The state before the restore is kept as a backup.`, "ok");
      await load();
    }
  };
  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const r = await run(() => api.saveBackupSettings(form), form.enabled ? `Nightly backups at ${form.time}, keeping ${form.keep}.` : "Nightly backups turned off.");
    if (r) {
      setSaved(r.settings);
      setForm(r.settings);
    }
  };

  const lastFor = (serverId: number | null, kind: "server" | "panel") => backups?.find((b) => b.kind === kind && (kind === "panel" || b.serverId === serverId));
  const countFor = (serverId: number | null, kind: "server" | "panel") => backups?.filter((b) => b.kind === kind && (kind === "panel" || b.serverId === serverId)).length ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Backups</h1>
          <p>
            Copies of each server's files and of the panel's own database, kept on this machine.
            {backups && ` ${backups.length} backup${backups.length === 1 ? "" : "s"}, ${fmtBytes(total)} in total.`}
          </p>
        </div>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>What</th>
                <th>Latest backup</th>
                <th>Backups</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const last = lastFor(s.id, "server");
                return (
                  <tr key={s.id}>
                    <td>
                      <b>{s.name}</b>
                      <small className="hint" style={{ display: "block" }}>
                        Configs, plugins and their data, added maps
                      </small>
                    </td>
                    <td>{last ? <span title={fullTime(last.createdAt)}>{timeAgo(last.createdAt)}</span> : <span className="hint">Never</span>}</td>
                    <td>{countFor(s.id, "server")}</td>
                    <td style={{ textAlign: "right" }}>
                      {manage && (
                        <button className="btn small" disabled={busy} onClick={() => void backupServer(s)}>
                          {working === `server-${s.id}` ? "Backing up…" : "Back up now"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td>
                  <b>Panel database</b>
                  <small className="hint" style={{ display: "block" }}>
                    Team, bans, presets, settings and history
                  </small>
                </td>
                <td>{lastFor(null, "panel") ? <span title={fullTime(lastFor(null, "panel")!.createdAt)}>{timeAgo(lastFor(null, "panel")!.createdAt)}</span> : <span className="hint">Never</span>}</td>
                <td>{countFor(null, "panel")}</td>
                <td style={{ textAlign: "right" }}>
                  {owner && (
                    <button className="btn small" disabled={busy} onClick={() => void backupPanel()}>
                      {working === "panel" ? "Backing up…" : "Back up now"}
                    </button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {manage && form && saved && (
        <form className="panel" onSubmit={saveSettings}>
          <h2 style={{ marginBottom: 6 }}>Nightly backups</h2>
          <p className="hint" style={{ marginTop: 0, maxWidth: "75ch" }}>
            Every server and the panel's database, once a night. Backups you make by hand are kept until you delete them.
          </p>
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            <span>Make nightly backups</span>
          </label>
          {form.enabled && (
            <div className="form-grid" style={{ maxWidth: 640, marginTop: 12 }}>
              <div className="field">
                <span>At</span>
                <TimeSelect value={form.time} onChange={(time) => setForm({ ...form, time })} label="Backup time" />
                <small className="hint">The machine's time. Pick a quiet hour.</small>
              </div>
              <label className="field">
                <span>Keep</span>
                <select value={form.keep} onChange={(e) => setForm({ ...form, keep: Number(e.target.value) })}>
                  {[3, 5, 7, 14, 30].map((n) => (
                    <option key={n} value={n}>
                      The last {n} nights
                    </option>
                  ))}
                </select>
                <small className="hint">Per server, and of the database.</small>
              </label>
            </div>
          )}
          <div className="row-actions" style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={busy || JSON.stringify(form) === JSON.stringify(saved)}>
              Save
            </button>
          </div>
        </form>
      )}

      <div className="panel" style={{ padding: 0 }}>
        <h2 style={{ padding: "18px 20px 0", marginBottom: 8 }}>All backups</h2>
        {backups && backups.length === 0 && <p className="hint" style={{ padding: "0 20px 18px" }}>No backups yet.</p>}
        {backups && backups.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Of</th>
                  <th>Made</th>
                  <th>Why</th>
                  <th>Size</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => {
                  const mayTouch = b.kind === "panel" ? owner : manage;
                  return (
                    <tr key={b.id}>
                      <td>{b.kind === "panel" ? "Panel database" : (b.serverName ?? b.file)}</td>
                      <td title={timeAgo(b.createdAt)}>{fullTime(b.createdAt)}</td>
                      <td>
                        {WHY[b.trigger]}
                        {b.createdBy && b.trigger !== "nightly" && <small className="hint"> · {b.createdBy}</small>}
                      </td>
                      <td>{fmtBytes(b.sizeBytes)}</td>
                      <td>
                        {mayTouch && (
                          <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                            <a className="btn small ghost" href={api.backupDownloadUrl(b.id)} download>
                              Download
                            </a>
                            {b.kind === "server" && (
                              <button className="btn small" disabled={busy} onClick={() => void restore(b)}>
                                {working === b.id ? "Restoring…" : "Restore"}
                              </button>
                            )}
                            <button className="btn small danger" disabled={busy} onClick={() => void remove(b)}>
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {owner && (
        <div className="panel">
          <h2 style={{ marginBottom: 6 }}>Restoring the panel's database</h2>
          <p className="hint" style={{ marginTop: 0, maxWidth: "75ch" }}>
            The panel can't replace its own database while it's running, so this one is done on the server. The panel stops for a moment, and the current
            database is kept next to it.
          </p>
          <pre className="mono" style={{ margin: 0 }}>
            sudo /opt/cs2-panel/deploy/restore-db.sh{"\n"}sudo /opt/cs2-panel/deploy/restore-db.sh panel-YYYYMMDD-HHMMSS.db
          </pre>
          <p className="hint" style={{ marginBottom: 0 }}>The first line lists the backups; the second restores one.</p>
        </div>
      )}
    </>
  );
}
