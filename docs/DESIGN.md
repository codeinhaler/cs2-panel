# cs2-panel — Design

Status: **draft for review** · Last updated: 2026-11-05

A self-hosted web panel for running and administering three CS2 community servers on a single Debian 13 machine, used by a team of admins over the local network.

---

## 1. Goals and non-goals

**Goals**

- Start, stop, restart and update the CS2 servers from a browser.
- Edit server and plugin config files in the browser, with history and rollback.
- Install, update and remove Metamod:Source, CounterStrikeSharp (CSSharp) and CSSharp plugins per server.
- See who is online and kick, ban and unban players, with bans shared across all servers.
- Multiple admins with different permission levels, and an audit log of every action.
- Survive CS2 updates without silently breaking plugins.

**Non-goals (for now)**

- Multiple hosts. Everything runs on one box.
- Public internet exposure of the panel. It is LAN-only.
- Hosting for third parties, billing, or quotas.
- Plugin frameworks other than Metamod + CSSharp.

---

## 2. Target environment

| | |
|---|---|
| OS | Debian 13, 64-bit |
| CPU | 4 vCPU |
| RAM | 16 GB |
| Disk | 320 GB |
| Servers | 3 CS2 instances |
| Panel access | Local network only |
| Player access | Game ports forwarded from the router |

**Capacity notes**

- A CS2 server's main loop is mostly bound to one core. Each instance is pinned to its own vCPU (0, 1, 2); the panel and OS get vCPU 3.
- Expect roughly 2–3 GB RAM per instance, which leaves comfortable headroom.
- The base CS2 install is about 60 GB. Using one shared base instead of three copies saves about 120 GB and turns three updates into one.

---

## 3. Architecture overview

```
 Admin browser (LAN)
        │ HTTP(S) + WebSocket (SignalR)
        ▼
 ┌─────────────────────────────── Debian host ───────────────────────────────┐
 │                                                                           │
 │  cs2-panel  (ASP.NET Core, user: cs2panel, vCPU 3)                        │
 │   ├─ REST API + SignalR hubs + static frontend                           │
 │   ├─ SQLite database                                                      │
 │   ├─ Server manager ──▶ cs2ctl (root helper, via sudo, fixed verbs)      │
 │   ├─ SteamCMD runner                                                      │
 │   ├─ RCON client      ──▶ TCP game port of each instance (localhost)     │
 │   └─ Bridge hub       ◀── WebSocket from the companion plugin            │
 │                                                                           │
 │  cs2@srv1.service ─┐                                                      │
 │  cs2@srv2.service ─┼─ CS2 dedicated server (user: cs2)                    │
 │  cs2@srv3.service ─┘    └─ Metamod → CSSharp → Cs2Panel.Bridge plugin     │
 │                                                                           │
 └───────────────────────────────────────────────────────────────────────────┘
        ▲
        │ UDP game traffic
   Players (internet)
```

There is no separate agent. The panel runs on the same host and manages the servers directly.

---

## 4. Users, permissions and privilege separation

**System users**

| User | Purpose |
|---|---|
| `cs2` | Runs the CS2 server processes. Owns the base install. |
| `cs2panel` | Runs the panel. Member of group `cs2`. |

Instance directories are owned by `cs2:cs2`, group-writable with the setgid bit, so the panel can edit configs and install plugins without root.

**Privileged operations** go through one small root-owned helper script, `/usr/local/lib/cs2-panel/cs2ctl`, allowed via a single sudoers line for `cs2panel`. It accepts only fixed verbs and validated instance names:

```
cs2ctl start|stop|restart|status <srvN>
cs2ctl mount|umount <srvN>
```

The panel never gets a general root shell, and it cannot pass arbitrary arguments through.

---

## 5. Directory layout

```
/srv/cs2/
  steamcmd/                     SteamCMD (Valve tarball)
  base/                         Shared CS2 install (app 730). Read-only to instances.
  instances/
    srv1/
      upper/                    Per-instance files (OverlayFS upperdir)
        game/csgo/cfg/          server.cfg, gamemode configs
        game/csgo/addons/       metamod/, counterstrikesharp/
        game/csgo/gameinfo.gi   Patched copy (regenerated after every update)
      work/                     OverlayFS workdir
      merged/                   OverlayFS mountpoint — the server runs from here
    srv2/ …
    srv3/ …
  backups/                      Nightly DB + per-instance upper/ snapshots

/opt/cs2-panel/                 Panel binaries (from GitHub release)
/var/lib/cs2-panel/
  panel.db                      SQLite database
  downloads/                    Cached plugin archives
/etc/cs2-panel/
  appsettings.json              Panel config (ports, paths, secrets)
```

### Why OverlayFS

Each instance sees the full CS2 install at `merged/`, but anything it writes or that we change lands in its own `upper/`. The base stays pristine and shared.

**Rules that keep this safe:**

1. **The base is only changed while every overlay is unmounted.** Changing a lower dir under a live overlay is undefined behaviour.
2. **Files in `upper/` shadow the base.** If a base file gets copied up and Valve later updates it, the instance keeps the stale copy. To prevent that:
   - Only allowlisted paths may live in `upper/`: `game/csgo/cfg/**`, `game/csgo/addons/**`, `game/csgo/gameinfo.gi`, logs, demos.
   - After every update, the panel scans `upper/` for anything outside the allowlist that also exists in the base, and reports it (with an option to remove).
   - `gameinfo.gi` is **always deleted from `upper/` and regenerated** from the new base copy after an update, then re-patched for Metamod.

---

## 6. Process model

One systemd template unit runs all three instances:

```ini
# /etc/systemd/system/cs2@.service  (sketch)
[Unit]
Description=CS2 server %i
After=network-online.target cs2-mount@%i.service
Requires=cs2-mount@%i.service

[Service]
User=cs2
Group=cs2
WorkingDirectory=/srv/cs2/instances/%i/merged/game
EnvironmentFile=/etc/cs2-panel/instances/%i.env
ExecStart=/srv/cs2/instances/%i/merged/game/cs2.sh -dedicated $CS2_ARGS
CPUAffinity=${CPU}
Restart=on-failure
RestartSec=10
```

- **Launch arguments** (port, map, game type/mode, max players, GSLT token, RCON password, `-usercon`) are generated by the panel into `/etc/cs2-panel/instances/srvN.env`. They are not hand-edited.
- **Mounts** are handled by a companion unit `cs2-mount@.service` so the overlay is always up before the server starts and down after it stops.
- **Logs:** stdout goes to journald. The panel streams `journalctl -u cs2@srvN -f` to the browser console view.
- **Commands** go over RCON from the panel on localhost.

### Ports

Spaced by 10 to avoid collisions with auxiliary ports:

| Instance | Game (UDP) | RCON (TCP, same port) | SourceTV (optional) |
|---|---|---|---|
| srv1 | 27015 | 27015 | 27020 |
| srv2 | 27025 | 27025 | 27030 |
| srv3 | 27035 | 27035 | 27040 |

**Router: forward UDP only.** Players need UDP. RCON is TCP on the game port, so not forwarding TCP keeps RCON off the internet. Each instance also gets a long random RCON password generated by the panel.

---

## 7. Update flow

Triggered manually or automatically when Valve releases a new build.

**Detection:** read the installed `PatchVersion` from `base/game/csgo/steam.inf` and compare against Steam's `ISteamApps/UpToDateCheck` for app 730. Poll every few minutes.

**Flow:**

1. Announce in-game on each server (via RCON `say`), with a configurable grace period. Optionally wait until servers are empty.
2. Stop `cs2@srv1..3`.
3. Unmount all overlays.
4. Run `steamcmd +force_install_dir /srv/cs2/base +login anonymous +app_update 730 validate +quit`.
5. For each instance: delete `upper/.../gameinfo.gi`, copy the new base version, re-apply the Metamod patch (insert `Game csgo/addons/metamod` into `SearchPaths`).
6. Run the upper-dir hygiene scan (section 5).
7. Remount and start the servers.
8. Verify: Metamod loaded, CSSharp loaded, Bridge plugin connected back to the panel. Flag any server where that fails.
9. Record everything in the audit log.

**Update policy per host:**

- `auto` — update as soon as a build is detected.
- `notify` — show a banner; an admin clicks Update.
- `hold` — don't update, e.g. while waiting for a Metamod or CSSharp fix after a breaking CS2 patch. (Note: Valve may refuse connections from outdated servers, so a hold is short-term only.)

---

## 8. Configuration editing

**Editable files** are restricted to an allowlist inside each instance's `upper/`:

- `game/csgo/cfg/**`
- `game/csgo/addons/counterstrikesharp/configs/**`

All paths are resolved and checked to stay inside that allowlist, preventing path traversal.

**Features**

- Monaco editor in the browser, with syntax highlighting for `.cfg`, `.json` and `.toml`.
- **Every save is a revision** stored in the database: content, hash, author, timestamp and an optional comment. The UI shows diffs between revisions and can roll back with one click.
- **Shared configs:** a "global" config layer (e.g. common bans list, chat filters, admin settings) applied to all three servers, with per-server files for overrides.
- **Templates:** named presets (e.g. "Competitive 5v5", "Retakes", "Deathmatch") that write a set of files onto a server.
- Apply options: "save only", "save + `exec` via RCON", or "save + restart".

---

## 9. Plugin management

### Layers

1. **Metamod:Source** (CS2 branch)
2. **CounterStrikeSharp** (the build that bundles the .NET runtime)
3. **CSSharp plugins**, including our own `Cs2Panel.Bridge`

Each instance has its own copy under `upper/game/csgo/addons/`, so servers can run different plugin sets and versions.

### Catalog

A catalog file in this repo, `catalog/plugins.json`, describes each installable plugin:

```json
{
  "id": "cs2-simpleadmin",
  "name": "CS2-SimpleAdmin",
  "kind": "cssharp",
  "source": { "type": "github-release", "repo": "owner/repo", "asset": "*.zip" },
  "installTo": "game/csgo/addons/counterstrikesharp/plugins/",
  "requires": ["metamod", "counterstrikesharp"]
}
```

- The panel lists available versions from the source's GitHub releases.
- Install, update and remove per server, with the exact version recorded in the database.
- **Version pinning** is the default; updates are explicit.
- Custom plugin upload (zip) is allowed for the Owner role only, since a plugin is arbitrary code running on the server.
- Before replacing plugin files, the panel snapshots the plugin's directory so an update can be rolled back.
- Plugin config files under `configs/` are preserved across updates.

### After a CS2 update

The verification step (section 7, step 8) checks that Metamod and CSSharp loaded. If a plugin breaks, the panel marks it with a warning and the server stays up. Admins can then hold updates, roll back a plugin or wait for an upstream fix.

---

## 10. Player management

### Companion plugin: `Cs2Panel.Bridge`

A CSSharp plugin we write and ship with the panel. It opens a WebSocket from each server to the panel on localhost, authenticated with a per-instance token.

**Server → panel events**

| Event | Payload |
|---|---|
| `hello` | instance id, plugin version, map |
| `player_connect` | SteamID64, name, IP |
| `player_disconnect` | SteamID64, reason |
| `snapshot` (every ~10 s) | full player list: SteamID64, name, team, ping, score, connected-since |
| `map_change` | map name |
| `chat` (optional) | SteamID64, message, team-only flag |

**Panel → server commands**

| Command | Effect |
|---|---|
| `kick` | Kick a player with a reason |
| `ban` | Kick immediately; the ban itself is stored by the panel |
| `message` | Say to all, or to one player |
| `reload_bans` | Refresh the plugin's local ban cache |

### Bans

Bans are **owned by the panel database** and apply to all three servers.

- On `player_connect`, the plugin checks the ban. It keeps a **local cache of active bans**, refreshed from the panel, so bans are still enforced if the panel is restarting.
- Ban fields: SteamID64, optional IP, reason, created by, created at, expires at (null = permanent), revoked by/at.
- Unbanning sets the revocation fields rather than deleting, so history is kept.
- Banning by SteamID works for players who are offline, e.g. from the player history page.
- **Fallback:** if the Bridge plugin isn't loaded, kick still works via RCON (`kickid`). Ban enforcement depends on the plugin, and the UI shows a clear warning when it isn't connected.

### Player history

Every connect and disconnect is recorded, enabling "seen on which servers, when, under which names". This also makes it possible to ban someone after they've left.

---

## 11. Panel users and roles

**Login:** Sign in through Steam (OpenID). Only SteamIDs listed in the panel's user table can log in. The first Owner is set during install.

| Permission | Owner | Admin | Moderator |
|---|:-:|:-:|:-:|
| View dashboard, players, logs | ✓ | ✓ | ✓ |
| Kick, ban, unban | ✓ | ✓ | ✓ |
| Send RCON commands | ✓ | ✓ | |
| Start / stop / restart | ✓ | ✓ | |
| Edit configs | ✓ | ✓ | |
| Install / update plugins from catalog | ✓ | ✓ | |
| Run CS2 updates, change update policy | ✓ | ✓ | |
| Upload custom plugins | ✓ | | |
| Manage panel users and roles | ✓ | | |
| Change ports, GSLT tokens, launch args | ✓ | | |

**Audit log:** every state-changing action records who, what, which server, when, plus before/after details where relevant (e.g. config diffs). It's viewable in the UI and append-only from the panel's point of view.

**Sessions:** HTTP-only cookies, idle timeout, logout everywhere. Since the panel runs on the LAN, plain HTTP is acceptable, but HTTPS with a self-signed certificate is available as an option for encrypting login sessions.

---

## 12. Data model (first cut)

```
Server        id, slug (srv1), name, port, tv_port, cpu, map, game_type, game_mode,
              max_players, gslt_token*, rcon_password*, bridge_token*, extra_args,
              update_policy
User          id, steam_id64, display_name, role, created_at, disabled
Ban           id, steam_id64, ip?, reason, created_by, created_at, expires_at?,
              revoked_by?, revoked_at?
Player        steam_id64, last_name, first_seen, last_seen
PlayerSession id, steam_id64, server_id, name, ip, connected_at, disconnected_at
ConfigFile    id, server_id (null = global), path
ConfigRev     id, config_file_id, content, sha256, author_id, created_at, comment
PluginInstall id, server_id, plugin_id, version, installed_at, installed_by
AuditEntry    id, user_id, action, server_id?, details_json, created_at
Setting       key, value          (host-level: update policy, Steam poll interval, …)

* stored encrypted at rest with a key from /etc/cs2-panel
```

---

## 13. Tech stack

| Part | Choice | Why |
|---|---|---|
| Backend | ASP.NET Core on .NET 10 | Same language as CSSharp plugins; good for process control on Linux |
| Real-time | SignalR | Live console, player list and status updates |
| Database | SQLite via EF Core | No DB server to run; enough for 3 servers and a small team |
| Frontend | React + TypeScript + Vite | Large ecosystem, good Monaco integration |
| Editor | Monaco | Same editor as VS Code |
| Companion plugin | C# CSSharp plugin | Shares contracts with the backend |
| Packaging | Self-contained linux-x64 build | No .NET runtime needed on the server |

### Repository layout

```
cs2-panel/
  docs/DESIGN.md
  src/
    Cs2Panel.Server/       ASP.NET Core app (API, hubs, managers)
    Cs2Panel.Contracts/    Shared DTOs for panel ↔ Bridge messages
    Cs2Panel.Bridge/       CSSharp companion plugin
    web/                   React frontend (built into the server's wwwroot)
  deploy/
    install.sh             First-time host setup
    update.sh              Panel self-update
    systemd/               cs2@.service, cs2-mount@.service, cs2-panel.service
    cs2ctl                 Root helper
    sudoers.d/cs2-panel
  catalog/plugins.json
  .github/workflows/       CI and release builds
```

---

## 14. Installation and deployment

### Building releases

GitHub Actions on every tag `v*`:

1. Build the frontend.
2. Publish the panel as a self-contained linux-x64 build with the frontend embedded.
3. Build the Bridge plugin.
4. Attach `cs2-panel-linux-x64.tar.gz` and `cs2panel-bridge.zip` to the GitHub release.

### Access from the server

The repo is private, so the server needs a credential. A **fine-grained personal access token** limited to this one repository with **Contents: read-only** covers both cloning the repo and downloading release assets. It is stored in `/etc/cs2-panel/github-token`, readable by root only.

(A deploy key would only cover `git clone`, not release downloads, which is why the token is preferred.)

### `install.sh` (run once as root)

1. Install packages: `lib32gcc-s1`, `lib32stdc++6` (for SteamCMD), `curl`, `ca-certificates`, `tar`, `unzip`.
2. Create users `cs2` and `cs2panel` and group `cs2`.
3. Create the `/srv/cs2` layout and download SteamCMD.
4. Install CS2 into `base/`. This takes a while.
5. Install `cs2ctl`, the sudoers entry and the systemd units.
6. Download and unpack the latest panel release into `/opt/cs2-panel`.
7. Ask for the Owner's SteamID64 and generate secrets.
8. Enable and start `cs2-panel.service`, then print the LAN URL.

Instance setup (ports, GSLT tokens, Metamod and CSSharp install) then happens in the panel UI.

### `update.sh`

Downloads the latest (or a specified) panel release, swaps it in, runs database migrations and restarts the panel. Game servers keep running during a panel update.

---

## 15. Backups

- Nightly: SQLite online backup of `panel.db`, plus a tarball of each instance's `upper/` (excluding demos and logs).
- Keep the last 14 days in `/srv/cs2/backups/`.
- Restore is manual and documented.

---

## 16. Phases

**Phase 1 — Foundation (MVP)**
- `install.sh`, OverlayFS layout, systemd units, `cs2ctl`.
- Panel with Steam login, roles and audit log.
- Server list with status, start/stop/restart.
- Live console (journald) and RCON command input.
- CS2 install and update via SteamCMD, with `gameinfo.gi` re-patching.
- Config editor with revisions and rollback.

**Phase 2 — Plugins**
- Metamod and CSSharp install per server.
- Plugin catalog, pinned versions, update and rollback.
- Post-update verification.

**Phase 3 — Players**
- `Cs2Panel.Bridge` plugin.
- Live player list, kick, central bans, unban.
- Player history.

**Phase 4 — Polish**
- Update auto-detection and policies.
- Config templates and global config layer.
- Scheduled restarts, restart-when-empty.
- Resource graphs, backups UI.
- Optional Discord webhooks.

---

## 17. Open questions

1. **Game modes:** what will each of the three servers run (competitive, retakes, deathmatch, surf, …)? This shapes the default templates.
2. **SourceTV / demos:** record demos on any server?
3. **Chat logging:** store in-game chat in the panel? Useful for moderation, but it's personal data, so it would need a retention period.
4. **IP bans:** SteamID bans only, or also IP bans?
5. **Panel HTTPS:** plain HTTP on the LAN, or a self-signed certificate?
6. **Number of admins:** roughly how many people, and who besides you should be Owner?
