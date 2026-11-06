# cs2-panel — Design

Status: **draft for review** · Last updated: 2026-11-05

A self-hosted web panel for creating, running and administering CS2 community servers on a single Debian 13 machine, used by a team of about five admins over the local network. The initial plan is three servers, but servers are created and removed from the panel rather than being fixed.

---

## 1. Goals and non-goals

**Goals**

- Create and delete servers from the browser, including choosing their game mode.
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
- SourceTV and demo recording.
- Chat logging.
- IP bans. Bans are by SteamID only.
- HTTPS for the panel. It runs plain HTTP on the LAN.

---

## 2. Target environment

| | |
|---|---|
| OS | Debian 13, 64-bit |
| CPU | 4 vCPU |
| RAM | 16 GB |
| Disk | 320 GB |
| Servers | Created from the panel; 3 planned initially |
| Admins | About 5 |
| Panel access | Local network only, plain HTTP |
| Player access | Game ports forwarded from the router |

**Capacity notes**

- A CS2 server's main loop is mostly bound to one core. By default, servers are pinned round-robin to vCPU 0–2, and the panel and OS keep vCPU 3. With three servers, each gets its own core.
- Expect roughly 2–3 GB RAM per instance.
- The panel shows a capacity warning when more servers are running than there are dedicated cores (more than 3 on this box). It does not block it, since small or idle servers can share a core fine.
- The base CS2 install is about 60 GB. Every server shares it, so a new server costs only its own configs and plugins (well under 1 GB), and one update covers all servers.

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
 │   └─ Ban sync         ──▶ bans.json in each server + cs2panel_reload     │
 │                                                                           │
 │  cs2@<slug>.service  (one per server created in the panel)                │
 │    └─ CS2 dedicated server (user: cs2)                                    │
 │         └─ Metamod → CSSharp → CS2 Panel Bridge plugin                    │
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
cs2ctl start|stop|restart|status <slug>
cs2ctl mount|umount <slug>
cs2ctl enable|disable <slug>        (boot autostart)
```

Because servers are created dynamically, `cs2ctl` validates a slug by:

1. Matching `^[a-z0-9][a-z0-9-]{0,31}$` (no slashes, dots or spaces).
2. Requiring that `/srv/cs2/instances/<slug>/` and `/etc/cs2-panel/instances/<slug>.env` both exist.

The panel never gets a general root shell, and it cannot pass arbitrary arguments through. Creating and deleting a server's files needs no root, since `cs2panel` can write in `/srv/cs2/instances/` and `/etc/cs2-panel/instances/` through group `cs2`.

---

## 5. Directory layout

```
/srv/cs2/
  steamcmd/                     SteamCMD (Valve tarball)
  base/                         Shared CS2 install (app 730). Read-only to instances.
  instances/
    <slug>/                     One directory per server, created by the panel
      upper/                    Per-instance files (OverlayFS upperdir)
        game/csgo/cfg/          server.cfg, gamemode configs
        game/csgo/addons/       metamod/, counterstrikesharp/
        game/csgo/gameinfo.gi   Patched copy (regenerated after every update)
      work/                     OverlayFS workdir
      merged/                   OverlayFS mountpoint — the server runs from here
  backups/                      Nightly DB + per-instance upper/ snapshots
    deleted/                    Archived upper/ of deleted servers

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
   - Only allowlisted paths may live in `upper/`: `game/csgo/cfg/**`, `game/csgo/addons/**`, `game/csgo/gameinfo.gi`, logs.
   - After every update, the panel scans `upper/` for anything outside the allowlist that also exists in the base, and reports it (with an option to remove).
   - `gameinfo.gi` is **always deleted from `upper/` and regenerated** from the new base copy after an update, then re-patched for Metamod.

---

## 6. Process model

One systemd template unit runs every server:

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

- **Launch arguments** (port, map, game type/mode, max players, GSLT token, RCON password, `-usercon`) are generated by the panel into `/etc/cs2-panel/instances/<slug>.env`. They are not hand-edited.
- **Mounts** are handled by a companion unit `cs2-mount@.service` so the overlay is always up before the server starts and down after it stops.
- **Logs:** stdout goes to journald. The panel streams `journalctl -u cs2@<slug> -f` to the browser console view.
- **Commands** go over RCON from the panel on localhost.

### Ports

Ports are **set manually** when a server is created. The panel validates the chosen port before saving:

- It must be in the range 1024–65535.
- It must not be used by another server in the database (including a ±5 margin, since a CS2 server may open auxiliary ports next to its game port).
- It must not be bound by any process on the host.

The form lists the ports already in use, so picking a free one is easy. A port can be changed later while the server is stopped. The conventional layout is 27015, 27025, 27035, …

Suggested layout for the three planned servers:

| Server | Game (UDP) | RCON (TCP, same port) |
|---|---|---|
| 1st | 27015 | 27015 |
| 2nd | 27025 | 27025 |
| 3rd | 27035 | 27035 |

**Router: forward UDP only.** Players need UDP. RCON is TCP on the game port, so not forwarding TCP keeps RCON off the internet. Each server also gets a long random RCON password generated by the panel.

When a new server is created, the panel shows the exact UDP port to forward on the router, since that step can't be automated.

---

## 6a. Server lifecycle and game modes

### Creating a server

A "New server" wizard (Owner and Admin):

1. **Name** — display name and hostname; the slug (e.g. `retakes-1`) is derived from it and can be edited.
2. **Game mode preset** — see below.
3. **Map** — start map, or a map group for the preset.
4. **Max players** — defaulted from the preset.
5. **GSLT token** — Steam Game Server Login Token. Needed for the server to be listed publicly; one token per server, created at Steam's game server account management page. Can be left empty for a LAN/private server.
6. **Port** — entered manually and validated (see Ports above).
7. **Plugins** — Metamod, CSSharp and the Bridge plugin are preselected. Optional catalog plugins can be added.
8. **Password** — optional `sv_password` for private servers.

What the panel then does:

1. Create `/srv/cs2/instances/<slug>/{upper,work,merged}` with the right ownership.
2. Write the preset's config files into `upper/game/csgo/cfg/`.
3. Generate secrets (RCON password, Bridge token) and the `<slug>.env` launch file.
4. Mount the overlay via `cs2ctl`, generate and patch `gameinfo.gi`, install the selected plugins.
5. Enable autostart and start the server if requested.
6. Record it in the audit log.

If any step fails, the panel rolls back what it created so no half-made server is left behind.

### Editing a server

Name, map, game mode, max players, password and GSLT token can be changed later. Changes that affect launch arguments rewrite `<slug>.env` and require a restart; the UI says so.

Changing the **game mode preset** of an existing server only changes launch arguments by default. Overwriting its config files with the new preset's files is a separate, explicit option, since admins may have customized them. The config history (section 8) keeps the old versions either way.

### Cloning a server

"Duplicate" creates a new server with a copy of another's configs and plugin set, a new slug and new secrets. A new port must be entered. Handy for running two of the same kind.

### Deleting a server

Owner only, with a confirm dialog that requires typing the slug.

1. Stop and disable the service, unmount the overlay.
2. Move `upper/` to `/srv/cs2/backups/deleted/<slug>-<date>/` (kept 30 days), remove `work/` and `merged/`.
3. Remove `<slug>.env`.
4. Mark the server as deleted in the database. Config history, sessions and audit entries are kept.
5. Remind the admin to remove the router port forward.

### Game mode presets

A preset is a named bundle of:

- `game_type` and `game_mode` launch values,
- a default map or map group and max players,
- a set of config files (e.g. `gamemode_competitive_server.cfg`, `server.cfg` additions),
- optionally a list of required catalog plugins.

Built-in presets for the stock modes:

| Preset | game_type | game_mode | Typical max players |
|---|---|---|---|
| Casual | 0 | 0 | 20 |
| Competitive | 0 | 1 | 10 |
| Wingman | 0 | 2 | 4 |
| Arms Race | 1 | 0 | 10 |
| Deathmatch | 1 | 2 | 16 |

Community modes like retakes, surf or 1v1 arenas are built on a stock mode plus plugins and configs. These become **custom presets**: Owners and Admins can create one by hand or by "save this server as a preset", which captures its launch values, config files and plugin list.

Presets are stored in the database. The built-in ones are seeded at install and can't be deleted, but can be duplicated and edited.

**Workshop maps (Phase 4):** a preset or server can use a Workshop map or collection by ID instead of a stock map. The panel passes the matching launch parameter (`+host_workshop_map` or `+host_workshop_collection`). Exact handling to be verified against the current CS2 build during implementation.

---

## 7. Update flow

Triggered manually or automatically when Valve releases a new build.

**Detection:** read the installed `PatchVersion` from `base/game/csgo/steam.inf` and compare against Steam's `ISteamApps/UpToDateCheck` for app 730. Poll every few minutes.

**Flow:**

1. Announce in-game on each server (via RCON `say`), with a configurable grace period. Optionally wait until servers are empty.
2. Stop all running `cs2@<slug>` services.
3. Unmount all overlays.
4. Run `steamcmd +force_install_dir /srv/cs2/base +login anonymous +app_update 730 validate +quit`.
5. For each instance: delete `upper/.../gameinfo.gi`, copy the new base version, re-apply the Metamod patch (insert `Game csgo/addons/metamod` into `SearchPaths`).
6. Run the upper-dir hygiene scan (section 5).
7. Remount and start the servers.
8. Verify: Metamod loaded, CSSharp loaded. Flag any server where that fails.
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
- **Shared configs:** a "global" config layer (e.g. common bans list, chat filters, admin settings) applied to all servers, with per-server files for overrides.
- **Presets:** game mode presets (section 6a) carry config files too, so applying a preset to a server is the template mechanism.
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

### Companion plugin: CS2 Panel Bridge (`bridge/`)

A small CSSharp plugin we write and ship inside every panel release (`bridge/cs2panel-bridge.zip`, built by CI). It's in the plugin catalog as a *bundled* source and is installed automatically whenever CounterStrikeSharp is (`companionOf`).

It deliberately has **no networking**: no sockets, no tokens. Everything goes through files and RCON, which the panel already has.

| Console command | Effect |
|---|---|
| `cs2panel_reload` | Re-reads `configs/plugins/Cs2PanelBridge/bans.json` and kicks anyone on it who is online |
| `cs2panel_players` | Prints `CS2PANEL_PLAYERS <json>` with userId, SteamID64 and name for each human player |
| `cs2panel_version` | Prints the plugin version |

On `OnClientAuthorized` the plugin checks its in-memory ban list and kicks a banned player with the reason. Because the list is a file on the server, bans are enforced even while the panel is down.

### Bans

Bans are **owned by the panel database** and apply to every server that runs the bridge.

- Ban fields: SteamID64, name, reason, created by, created at, the server it was made on, expires at (null = permanent), revoked by/at/reason.
- Unbanning sets the revocation fields rather than deleting, so history is kept. Expired bans stay in the list as "expired".
- On every ban or unban the panel writes the active list to each bridge server's `bans.json` (through `merged/` when mounted) and sends `cs2panel_reload` to the running ones. Each server also gets a fresh file just before it starts and right after the bridge is installed.
- Banning by SteamID works for players who are offline, e.g. from Recent players. Unbanning needs no running server.
- **Fallback:** kick works on every server via RCON (`kickid`). A server without the bridge shows no SteamIDs and doesn't enforce panel bans; the Players tab says so and names the servers that aren't covered.

### Plugin tabs

A catalog entry can declare `page: { label, kind }`. While that plugin is installed on a server, the server page shows an extra tab after the panel's own ones. The only kind today is `moderation`: CS2-SimpleAdmin's tab lists its own bans (from its database) and in-game admins, and changes them through its console commands (`/api/servers/:id/moderation/...`). These are separate from the panel's bans.

### Player history

Every connect and disconnect is recorded, enabling "seen on which servers, when, under which names". This also makes it possible to ban someone after they've left.

---

## 11. Panel users and roles

**Login:** Sign in through Steam (OpenID). Only SteamIDs listed in the panel's user table can log in. There is a single Owner, set during install.

**Adding admins:** the Owner adds admins in the web interface by pasting a SteamID64 or a Steam profile URL and choosing a role. The panel resolves the profile name and avatar for display. The Owner can also change roles, disable accounts (which ends their sessions immediately) and remove admins. All of this is audit-logged.

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
| Create, edit and duplicate servers | ✓ | ✓ | |
| Create and edit game mode presets | ✓ | ✓ | |
| Delete servers | ✓ | | |
| Manage panel users and roles | ✓ | | |
| Manage in-game admins (moderation plugin) | ✓ | | |
| Edit raw launch args | ✓ | | |

**Audit log:** every state-changing action records who, what, which server, when, plus before/after details where relevant (e.g. config diffs). It's viewable in the UI and append-only from the panel's point of view.

**Sessions:** HTTP-only cookies, idle timeout, logout everywhere. The panel runs plain HTTP on the LAN. That means session cookies travel unencrypted on the local network, which is an accepted trade-off for a trusted LAN. HTTPS can be added later with a reverse proxy without changing the panel.

---

## 12. Data model (first cut)

```
Server        id, slug, name, preset_id, port, cpu, map, workshop_id?, game_type,
              game_mode, max_players, sv_password*, gslt_token*, rcon_password*,
              bridge_token*, extra_args, autostart, created_at, deleted_at?
Preset        id, name, builtin, game_type, game_mode, default_map, max_players,
              config_files_json, required_plugins_json
User          id, steam_id64, display_name, role, created_at, disabled
Ban           id, steam_id64, reason, created_by, created_at, expires_at?,
              revoked_by?, revoked_at?
Player        steam_id64, last_name, first_seen, last_seen
PlayerSession id, steam_id64, server_id, name, connected_at, disconnected_at
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
| Backend | Node.js + TypeScript, Fastify | One language for backend and frontend; easy process and file handling on Linux |
| Real-time | WebSockets | Live console and update logs |
| Database | SQLite via Node's built-in `node:sqlite` | No DB server and no native modules to compile |
| Frontend | React + TypeScript + Vite | Large ecosystem, good Monaco integration |
| Editor | Monaco | Same editor as VS Code; has a built-in diff view |
| Companion plugin | C# CSSharp plugin (Phase 3) | Required by CounterStrikeSharp; talks JSON to the panel |
| Packaging | Release tarball with a bundled Node.js binary | No runtime to install on the server |

(Originally planned as ASP.NET Core. Switched to TypeScript on 2026-11-05 so every change can be compiled and tested in the development environment before it is pushed.)

### Repository layout

```
cs2-panel/
  docs/DESIGN.md
  server/                  Fastify backend (TypeScript)
    src/
    test/
  web/                     React frontend (built into the release as static files)
  bridge/                  CSSharp companion plugin (Phase 3)
  deploy/
    install.sh             First-time host setup
    update.sh              Panel self-update
    cs2ctl                 Root helper
    systemd/               cs2@.service, cs2-mount@.service, cs2-panel.service
    sudoers.d/cs2-panel
  catalog/plugins.json     (Phase 2)
  .github/workflows/       CI and release builds
```

---

## 14. Installation and deployment

### Building releases

GitHub Actions on every tag `v*`:

1. Build the frontend.
2. Bundle the backend into a single JavaScript file.
3. Add the official Node.js linux-x64 binary.
4. Attach `cs2-panel-linux-x64.tar.gz` to the GitHub release. The bridge plugin is built into the same tarball under `bridge/`.

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

- Nightly: SQLite online backup of `panel.db`, plus a tarball of each instance's `upper/` (excluding logs).
- Keep the last 14 days in `/srv/cs2/backups/`.
- Restore is manual and documented.

---

## 16. Phases

**Phase 1 — Foundation (MVP)**
- `install.sh`, OverlayFS layout, systemd units, `cs2ctl`.
- Panel with Steam login, roles and audit log.
- Create, edit, duplicate and delete servers, with built-in game mode presets and manual port selection.
- Server list with status, start/stop/restart.
- Live console (journald) and RCON command input.
- CS2 install and update via SteamCMD, with `gameinfo.gi` re-patching.
- Config editor with revisions and rollback.

**Phase 2 — Plugins** (done)
- Metamod and CSSharp install per server (also offered in the create-server wizard).
- Plugin catalog with CS2-SimpleAdmin and its dependencies, pinned versions, update, pick a version, rollback, Owner uploads.
- Post-update verification over RCON.

**Phase 3 — Players** (done)
- Live player list and kick work on every server, with or without plugins.
- Panel-owned bans on all servers, enforced by the bundled CS2 Panel Bridge plugin.
- Plugin tabs: CS2-SimpleAdmin's own bans and in-game admins on a tab that appears only when it's installed.
- Player history.

**Phase 4 — Polish**
- Custom presets, including "save this server as a preset".
- Workshop maps and collections.
- Update auto-detection and policies.
- Global config layer.
- Scheduled restarts, restart-when-empty.
- Resource graphs, backups UI.
- Optional Discord webhooks.

---

## 17. Decisions log

| Date | Decision |
|---|---|
| 2026-11-05 | Servers are created and deleted from the panel, not fixed at three. Game modes are chosen per server via presets. |
| 2026-11-05 | No SourceTV or demo recording. |
| 2026-11-05 | No chat logging. |
| 2026-11-05 | Bans are by SteamID only; no IP bans, and player IPs are not stored. |
| 2026-11-05 | Panel runs plain HTTP on the LAN. |
| 2026-11-05 | Team of about 5 admins. One Owner; the Owner adds admins in the web interface. |
| 2026-11-05 | Server ports are set manually; the panel validates them. |
| 2026-11-05 | Workshop maps are a later nice-to-have (Phase 4). |
| 2026-11-05 | Backend switched from ASP.NET Core to TypeScript/Node.js so code can be built and tested before pushing. |
| 2026-11-05 | CS2-SimpleAdmin and its dependencies are in the plugin catalog. Like every plugin, it's optional. |
| 2026-11-06 | Player list comes from CS2's `status` (no SteamIDs). A catalog entry can declare a moderation integration (CS2-SimpleAdmin): it adds SteamIDs, and bans/admins are read from its database and changed through its console commands. No separate Bridge plugin is needed. |
| 2026-11-06 | Bans are native again: the panel owns them, and the bundled CS2 Panel Bridge plugin (files + RCON, no networking) enforces them and supplies SteamIDs. SimpleAdmin is fully optional and gets its own tab for its bans and in-game admins. Supersedes the entry above about not needing a Bridge plugin. |
| 2026-11-06 | Nothing outside the catalog knows about specific plugins. A catalog entry can declare a database integration (config file + how to fill it in); the panel applies it to any such plugin when the optional shared MariaDB (127.0.0.1 only, `setup-mariadb.sh`) is set up. |
| 2026-11-05 | While a server's overlay is mounted, the panel writes through merged/ and never deletes there; changes that remove or replace files happen with the overlay unmounted. |

## 18. Open questions

None at the moment.
