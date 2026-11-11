import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fullTime, parseTime, type AuditEntry } from "../api";

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
      return d.trigger ? `restarted the server (${str("trigger")})` : "restarted the server";
    case "server.restart.failed":
      return `couldn't restart the server (${str("trigger")}): ${str("error")}`;
    case "server.gamemode":
      return `switched the game mode to ${str("preset")} on ${str("map")}${d.keep ? (d.applyConfigs ? ", kept with the preset's config files" : ", kept") : " until the next restart"}`;
    case "server.command": {
      const names: Record<string, string> = {
        "restart-game": "restarted the game",
        "warmup-start": "started warmup",
        "warmup-end": "ended warmup",
        pause: "paused the match",
        unpause: "resumed the match",
        "swap-teams": "swapped teams",
        "scramble-teams": "scrambled teams",
        "bot-kick": "kicked all bots",
      };
      if (d.action === "changemap") return `changed the map to ${str("map")}`;
      if (d.action === "say") return `sent a message: "${str("text")}"`;
      if (d.action === "bot-add") return `added a bot${d.team === "any" ? "" : ` to ${str("team").toUpperCase()}`}`;
      if (d.action === "bot-quota") return `set the bot count to ${str("count")}`;
      return names[str("action")] ?? `sent ${str("action")}`;
    }
    case "shared.update":
      return "changed the shared settings for all servers";
    case "backup.create": {
      const why = d.trigger === "nightly" ? " (nightly)" : d.trigger === "before-restore" ? " before restoring" : "";
      return e.serverId ? `backed up the server${why}` : `backed up the panel's database${why}`;
    }
    case "backup.restore":
      return `restored the server from the backup ${str("file")}`;
    case "backup.delete":
      return `deleted the backup ${str("file")}`;
    case "backup.settings":
      return d.enabled ? `set nightly backups at ${str("time")}, keeping ${str("keep")}` : "turned off nightly backups";
    case "backup.failed":
      return `couldn't back up ${str("what")}: ${str("error")}`;
    case "matchmaking.settings":
      return d.enabled ? `changed the matchmaking settings (site open on port ${str("port")})` : "changed the matchmaking settings (site closed)";
    case "matchmaking.rating":
      return d.rating === null
        ? `cleared the matchmaking rating of ${str("name") || str("steamId")}`
        : `set the matchmaking rating of ${str("name") || str("steamId")} to ${str("rating")}`;
    case "matchmaking.kick":
      return `removed ${str("name") || str("steamId")} from the matchmaking lobby`;
    case "matchmaking.cleanup_failed":
      return `couldn't empty the server after a match (tried ${String(d.attempts)}×: ${String(d.error ?? "")}), retrying`;
    case "matchmaking.cleanup_done":
      return `emptied the server after a match (after ${String(d.attempts)} tries)`;
    case "matchmaking.cleanup_retry":
      return "retried emptying a match server";
    case "matchmaking.cleanup_skipped":
      return "freed a match server by hand, without the cleanup";
    case "matchmaking.cancel":
      return `cancelled matchmaking match ${str("match")}`;
    case "matchmaking.match":
      return `reserved the server for matchmaking match ${str("match")} (${[str("mode"), `${str("players")} players`, d.bot ? "with a bot" : ""].filter(Boolean).join(", ")})`;
    case "matchmaking.joined":
      return `${str("name") || str("steamId")} joined matchmaking match ${str("match")} mid-match${d.replacedBot ? " in place of the bot" : ""}`;
    case "matchmaking.image":
      return d.removed ? `removed the matchmaking site's ${str("kind")}` : `uploaded a new ${str("kind")} for the matchmaking site`;
    case "tls.settings":
      return `changed the HTTPS settings${d.enabled ? ` (on, ${str("domain")})` : " (off)"}`;
    case "tls.renewed":
      return `got a new HTTPS certificate for ${str("domain")} (${str("why")})`;
    case "tls.renew-failed":
      return `couldn't renew the HTTPS certificate for ${str("domain")}: ${str("reason")}`;
    case "tls.firewall":
      return `changed the Palo Alto settings (${str("host")}, certificate "${str("certName")}")`;
    case "tls.firewall.connect":
      return `connected the panel to the Palo Alto ${str("hostname") || str("host")} as ${str("admin")}`;
    case "tls.firewall.forget":
      return "disconnected the panel from the Palo Alto";
    case "tls.pushed":
      return `sent the HTTPS certificate to the Palo Alto ${str("host")}${d.committed ? " and committed" : ""}`;
    case "tls.push-failed":
      return `couldn't send the HTTPS certificate to the Palo Alto: ${str("reason")}`;
    case "matchmaking.finished":
      return `finished matchmaking match ${str("match")} on ${str("map")}${d.score ? ` (${str("score")})` : ""}`;
    case "matchmaking.cancelled":
    case "matchmaking.abandoned":
      return `ended matchmaking match ${str("match")}: ${str("reason")}`;
    case "notifications.update":
      return d.webhookSet ? "changed the Discord notification settings" : "turned off Discord notifications";
    case "alert.raised":
      return `warned: ${str("message")}`;
    case "alert.cleared":
      return `cleared the warning: ${str("message")}`;
    case "server.crashed":
      return `noticed the server crashed; systemd restarted it`;
    case "preset.create":
      return d.fromServer ? `saved ${str("fromServer")} as the preset "${str("name")}"` : `created the preset "${str("name")}"`;
    case "preset.update":
      return `edited the preset "${str("name")}"`;
    case "preset.delete":
      return `deleted the preset "${str("name")}"`;
    case "server.exec_configs": {
      const list = Array.isArray(d.configs) ? (d.configs as string[]) : [];
      return list.length ? `set configs to run on every map start: ${list.join(", ")}` : "stopped running extra configs on map start";
    }
    case "discord.bot":
      return `${d.enabled ? "switched on" : "saved (off)"} the Discord bot (teams: ${str("teamMode")}, 1v1: ${str("duelMode")})`;
    case "discord.link":
      return `linked Steam ${str("steamId")} to Discord ${str("discordUser")}`;
    case "discord.unlink":
      return `unlinked Discord from Steam ${str("steamId")}`;
    case "server.cpu":
      return `changed the CPUs from ${str("from")} to ${str("to")} (${d.mode === "auto" ? "automatic" : "manual"})`;
    case "cpu.policy":
      return `set the CPU allocation policy to ${str("mode")} (reserved: ${str("reserved")})`;
    case "server.map_cycle":
      return Number(d.maps) >= 2 ? `set a map cycle of ${String(d.maps)} maps${d.random ? ", in random order" : ""}` : "turned off the map cycle";
    case "server.schedule":
      return d.restartAt
        ? `set a daily restart at ${str("restartAt")}${d.ifPlayers === "wait" ? `, waiting up to ${str("maxWaitMinutes")} min for players to leave` : ""}`
        : "turned off the daily restart";
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
    case "player.kick":
      return `kicked ${str("name")}${d.reason ? `: ${str("reason")}` : ""}`;
    case "player.ban": {
      const len = Number(d.minutes) === 0 ? "permanently" : `for ${Number(d.minutes) >= 1440 ? `${Number(d.minutes) / 1440} days` : `${str("minutes")} min`}`;
      return `banned ${str("name") || str("steamId")} ${len}: ${str("reason")}`;
    }
    case "player.unban":
      return `unbanned ${str("steamId")}${d.reason ? `: ${str("reason")}` : ""}`;
    case "gameadmin.add":
      return `made ${str("name")} (${str("steamId")}) an in-game admin with ${str("flags")}`;
    case "gameadmin.remove":
      return `removed in-game admin ${str("steamId")}`;
    case "plugin.install": {
      const extra = Array.isArray(d.alsoInstalled) && d.alsoInstalled.length ? `, plus ${(d.alsoInstalled as string[]).join(", ")}` : "";
      return `installed ${str("plugin")} ${str("version")}${extra}`;
    }
    case "plugin.update":
      return d.automatic
        ? `updated ${str("plugin")} from ${str("from")} to ${str("version")} automatically (nobody was on the server)`
        : `updated ${str("plugin")} to ${str("version")}`;
    case "plugin.rollback":
      return `rolled ${str("plugin")} back from ${str("from")} to ${str("to")}`;
    case "plugin.remove":
      return `removed ${str("plugin")} ${str("version")}`;
    case "plugin.upload":
      return `uploaded and installed ${str("plugin")} (${str("file")})`;
    case "game.update.start":
      if (d.trigger) return `started a CS2 update automatically (${str("trigger")})`;
      return d.validate ? "started a CS2 update with file verification" : "started a CS2 update";
    case "game.update.available":
      return `found a CS2 update: build ${str("latest")} (installed: ${str("installed")})`;
    case "game.update.settings": {
      const p: Record<string, string> = { off: "off", notify: "only notify", "when-empty": "update when empty", now: "update right away" };
      return `set automatic CS2 updates to "${p[str("policy")] ?? str("policy")}"`;
    }
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
                  <time dateTime={parseTime(e.createdAt).toISOString()}>{fullTime(e.createdAt)}</time>
                </td>
                <td>
                  <b style={{ fontWeight: 600 }}>{e.userName ?? (e.userSteamId ? e.userSteamId : "System")}</b> {describe(e)}
                  {!compact && e.serverName && e.action !== "server.delete" && (
                    <> on {e.serverId ? <Link to={`/servers/${e.serverId}`}>{e.serverName}</Link> : e.serverName}</>
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
