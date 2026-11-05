import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, parseTime, type AuditEntry } from "../api";

/** Turns an audit entry into a sentence. */
function describe(e: AuditEntry): string {
  const d = e.details as Record<string, string | string[] | number | boolean | undefined>;
  const str = (k: string) => (d[k] === undefined ? "" : String(d[k]));
  switch (e.action) {
    case "auth.login":
      return "signed in";
    case "auth.denied":
      return `Steam account ${str("steamId")} tried to sign in without access`;
    case "user.add":
      return `added ${str("name") || str("steamId")} as ${str("role")}`;
    case "user.update":
      return `changed ${str("name") || str("steamId")}: ${[d.role ? `role → ${str("role")}` : "", d.disabled !== undefined ? (d.disabled ? "disabled" : "enabled") : ""].filter(Boolean).join(", ")}`;
    case "user.remove":
      return `removed ${str("name") || str("steamId")} from the team`;
    case "server.create":
      return `created the server on port ${str("port")} (${str("preset")}, ${str("map")})`;
    case "server.update": {
      const changed = Array.isArray(d.changed) ? d.changed : [];
      return `changed settings${changed.length ? `: ${changed.join(", ")}` : ""}${d.appliedPresetConfigs ? ", and applied the preset's config files" : ""}`;
    }
    case "server.duplicate":
      return `created this server as a copy of ${str("from")}`;
    case "server.delete":
      return `deleted ${str("name")} (port ${str("port")})`;
    case "server.start":
      return "started the server";
    case "server.stop":
      return "stopped the server";
    case "server.restart":
      return "restarted the server";
    case "server.kill":
      return "force-stopped the server";
    case "server.rcon":
      return `ran "${str("command")}"`;
    case "config.save":
      return `saved ${str("path")}${d.comment ? `: ${str("comment")}` : ""}`;
    case "config.revert":
      return `reverted ${str("path")} to stock`;
    case "config.delete":
      return `deleted ${str("path")}`;
    case "config.rollback":
      return `restored an earlier version of ${str("path")}`;
    case "game.update.start":
      return d.validate ? "started a CS2 update with file verification" : "started a CS2 update";
    case "game.update.finish":
      return d.result === "succeeded" ? "CS2 update finished" : `CS2 update failed: ${str("error")}`;
    default:
      return e.action;
  }
}

export function ActivityList({ serverId, limit = 50, compact = false }: { serverId?: number; limit?: number; compact?: boolean }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [more, setMore] = useState(true);

  useEffect(() => {
    void api.audit({ serverId, limit }).then((r) => {
      setEntries(r.entries);
      setMore(r.entries.length === limit);
    });
  }, [serverId, limit]);

  const loadMore = async () => {
    const last = entries?.[entries.length - 1];
    if (!last) return;
    const r = await api.audit({ serverId, limit, before: last.id });
    setEntries((e) => [...(e ?? []), ...r.entries]);
    setMore(r.entries.length === limit);
  };

  if (!entries) return null;
  if (entries.length === 0) return <p className="hint">Nothing has happened here yet.</p>;

  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td style={{ whiteSpace: "nowrap", color: "var(--ink-faint)", width: 1 }}>
                  <time dateTime={parseTime(e.createdAt).toISOString()}>{parseTime(e.createdAt).toLocaleString()}</time>
                </td>
                <td>
                  <b style={{ fontWeight: 600 }}>{e.userName ?? (e.userSteamId ? e.userSteamId : "System")}</b> {describe(e)}
                  {!compact && e.serverName && e.action !== "server.delete" && (
                    <>
                      {" "}
                      on {e.serverId ? <Link to={`/servers/${e.serverId}`}>{e.serverName}</Link> : e.serverName}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!compact && more && (
        <button className="btn" style={{ marginTop: 14 }} onClick={() => void loadMore()}>
          Show older
        </button>
      )}
    </>
  );
}

export function ActivityPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p>Everything done through the panel, newest first.</p>
        </div>
      </div>
      <div className="panel">
        <ActivityList />
      </div>
    </>
  );
}
