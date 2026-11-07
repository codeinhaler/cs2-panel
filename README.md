# cs2-panel

A web panel for running CS2 community servers on one Debian machine: create servers, start and stop them, edit their configs, watch the console and update CS2, with a small admin team signing in through Steam.

The design is in [docs/DESIGN.md](docs/DESIGN.md).

## What's in Phase 1

- Sign in with Steam. One Owner, who adds Admins and Moderators in the panel.
- Create, edit, duplicate and delete servers. Game mode presets for Casual, Competitive, Wingman, Arms Race and Deathmatch. Ports are chosen by hand and checked for conflicts.
- Start, stop and restart, with live status and player counts.
- Live console with RCON commands.
- Config editor with history, compare, restore and "revert to stock".
- Install and update CS2 through SteamCMD. Every server shares one install; Metamod's `gameinfo.gi` entry is re-applied after each update.
- Activity log of everything done through the panel.

## What's in Phase 2

- A **Plugins** tab per server with a catalog: Metamod:Source, CounterStrikeSharp and CS2-SimpleAdmin (plus the libraries it needs). Every plugin is optional; installing one installs what it needs first.
- Pinned versions, one-click update, pick any version, roll back to the previous one. Plugin config files are kept on updates.
- The Owner can upload a plugin archive that isn't in the catalog.
- A health check that asks the running server whether Metamod and CounterStrikeSharp loaded. It also runs automatically after each CS2 update.
- The New server form can install the plugins right away.

## What's in Phase 3

- A **Players** tab per server: who's online right now (name, SteamID, connected time, ping), with kick and ban.
- **Bans owned by the panel**: one list for all your servers. Ban an online player, a recent player, or anyone by SteamID or profile link. Unban works any time, even while servers are stopped. Banned players are kicked as soon as they join.
- Bans are enforced by **CS2 Panel Bridge**, a small CounterStrikeSharp plugin that ships with the panel and is installed automatically together with CounterStrikeSharp. It also tells the panel players' SteamIDs. It has no network access of its own: the panel writes the ban list into the server's files and tells it to reload over RCON. Source is in `bridge/`.
- **Recent players**: everyone seen on a server in the last 90 days, so you can ban someone after they left.
- **Plugin tabs**: some plugins bring their own tab on the server page while installed. CS2-SimpleAdmin gets a *SimpleAdmin* tab with its own bans, its in-game admins (Owner only), and the maps in its in-game change-map menu (regular and Workshop maps; pick from the maps in your CS2 install). Without SimpleAdmin, the tab simply isn't there.
- Every kick, ban, unban and admin change is in the Activity log with who did it.

## What's in Phase 4 (so far)

- **Automatic CS2 updates** (Game update page). The panel asks Steam (through SteamCMD) for the newest CS2 build every few minutes and compares it with what's installed. Choose what happens when there's a new one: update when the servers are empty (with a longest wait), update right away (with a warning to players), only tell me, or don't check at all. A failed update isn't retried for 30 minutes.
- **Scheduled restarts** (server Settings tab). Restart a server every day at a set time. If players are on, either wait for them to leave (up to a limit, then warn and restart) or warn them and restart.
- **Workshop maps and collections**. A server can start on a Steam Workshop map or collection instead of an installed map; paste the ID or the Workshop link. A collection's maps become the server's map rotation, optionally starting on a chosen map. Works best with a GSLT token.
- **Game mode switch** on the Commands tab: pick any preset and the running server loads a map in that mode right away, either until the next restart or kept (saved as the server's game mode, with the preset's map, max players and optionally its config files).
- **Commands tab** per server: change map (installed or Workshop), restart game, start/end warmup, pause/resume, swap/scramble teams, add/kick bots, bot count, and a message to all players. Only these fixed commands are sent, with checked values. Moderators can send messages; the rest needs Admin or Owner.
- **Custom presets** (Presets page): your own game mode presets with start map (Workshop too), max players, config files and configs to run. Built-in presets can be copied. **Save as preset** on a server's Settings turns a server you've set up into a preset.
- **Configs to run** (server Settings): extra cfg files that run on every map start, after server.cfg and the game mode's defaults. The panel keeps the `exec` lines in a marked block at the end of the game mode's `gamemode_<mode>_server.cfg`.
- **Workshop check**: before a Workshop map or collection is saved or loaded, the panel asks Steam about it and refuses removed, missing, private or non-CS2 items. The map picker shows the item's name and size and warns when there's no GSLT.
- **Honest status**: a server whose process runs but whose game doesn't answer shows "Starting" for 90 seconds, then "Not answering", with the likely cause.
- The GSLT stays in its field (hidden, with Show) for Admins and the Owner; the restart time picker follows the 12h/24h preference.
- **Monitor** page: CPU (per server, as % of its core), memory, players, and the machine's CPU, memory, disk and network over time (1 hour to 90 days). Each server's Overview has its own charts. Sampled every minute from systemd and /proc; nothing extra to install. 7 days in one-minute detail, 90 days as hourly averages.
- **Warnings**: a server using its whole core for 10 minutes, a server that runs but hasn't answered for 5 minutes, a server that crashed (or stopped after crashing), machine CPU above 95% or memory above 90%, and a disk more than 90% full. Shown on the Monitor page and the server's Overview, and logged in Activity.
- **Discord notifications** (Notifications page): paste a channel webhook and pick what to send: problems, CS2 updates, scheduled restarts, kicks/bans, and servers started or stopped by someone. The webhook is stored encrypted. There's a test button.
- **Backups** (Backups page): each server's own files (configs, plugins and their data, added maps; not the Workshop download cache) plus what the panel knows about it (plugin list, configs to run), and a consistent copy of the panel's database (team, bans, presets, settings, history). Made by hand or nightly at a set time, keeping the last N nights; stored on this machine under `/srv/cs2/backups/servers/` and `/var/lib/cs2-panel/backups/`. Download, delete, or restore a server (it stops, its files go back, it starts again; the state before is backed up first). The panel's database is restored on the server with `sudo /opt/cs2-panel/deploy/restore-db.sh <file>`.
- **Shared settings** (Shared settings page): a hostname prefix, server-browser tags and any cvars for every server. The panel writes them into `cfg/cs2panel_shared.cfg` in each server and runs it at the top of `server.cfg`, so a server's own `server.cfg` can override any shared value; a server can also opt out completely. Saving applies to running servers right away. Passwords, hostname, game mode and map commands are refused there because the panel sets them.
- Automatic actions show up in Activity as "System", with the reason.

## Matchmaking site

For CS evenings: players open one web page, sign in with Steam, and get put in even teams.

- **Settings** are on the panel's **Matchmaking** page: switch the site on, pick its port (default 8090), the servers matches may use, and the map pool. The site is a separate web server with only the matchmaking page on it, so you can forward its port on your router while the panel itself stays on your network. Forward the port as **TCP**.
- **Ratings**: each player's Premier rating comes from [Leetify](https://leetify.com) when Leetify knows them; otherwise they type in their own. You can set anyone's rating on the panel. A Leetify API key (optional, from leetify.com/app/developer) gives higher limits. Leetify's data isn't stored, as their rules ask.
- **Lobbies**: players pick **Competitive** (up to 5v5), **Wingman** (2v2) or **1v1** when they come to the page, and can switch while they're not in a match. Each lobby has its own map pool; you choose which lobbies are open.
- **Teams**: players in a lobby tick Ready. Anyone can press **Make teams**: the ready players (up to 10, 4 or 2) are split the most even way. With an odd number, a bot joins the smaller team so nobody sits out (bot difficulty is a setting, and it counts as a matching rating when balancing). Only when more are ready than fit does anyone wait, and they go first next time. The players on those teams can ask for other teams, cancel, or go.
- **Map veto like FACEIT**: the best-rated player on each team is captain. Captains take turns banning maps until one is left; a random map is banned if time runs out. The team that didn't ban last picks CT or T.
- **The server**: a free server from the ones you picked is started if needed, loads the map in the lobby's game mode (1v1 runs in Wingman mode) with a one-off password, and only lets the match's players in, each on their own team. Players get a **Join the server** button. Warmup lasts until everyone is in (or someone presses "Start without waiting"). When the match ends, the server is opened again with its own password.
- Servers used for matches need CounterStrikeSharp installed (the CS2 Panel Bridge comes with it). After updating the panel, update the bridge on those servers from their Plugins tab so they have the match support.

## Installing on the server

You need Debian 13 (x86_64), root access, and about 70 GB free disk space.

**1. Make a release.** On your own machine, tag a version and push the tag. GitHub Actions builds the release.

```sh
git tag v0.1.0
git push origin v0.1.0
```

**2. Create a read-only GitHub token** so the server can download releases from this private repository. Go to <https://github.com/settings/personal-access-tokens>, create a fine-grained token with access to only `codeinhaler/cs2-panel` and **Contents: Read-only**.

**3. Get the installer onto the server and run it.**

```sh
sudo apt install -y git
git clone https://github.com/codeinhaler/cs2-panel.git   # username: your GitHub name, password: the token
cd cs2-panel/deploy
sudo ./install.sh
```

The installer asks for the token, your SteamID64 (you become the Owner) and the panel port. It then downloads CS2, which is about 60 GB and takes a while. Add `--skip-cs2` to skip that and install CS2 later from the panel's Game update page.

**4. Open the panel** at `http://<server-ip>:8080` and sign in with Steam.

**5. Optional: shared database for plugins.** Some plugins can keep their data in a database shared by all servers; CS2-SimpleAdmin, for example, then applies a ban on every server. This installs MariaDB, listening on 127.0.0.1 only:

```sh
sudo /opt/cs2-panel/deploy/setup-mariadb.sh
```

**6. Router:** for each server you create, forward its **UDP** game port (for example 27015) to the Debian machine. Don't forward TCP; RCON uses TCP on the same port and should stay on your network.

## Updating the panel

```sh
sudo /opt/cs2-panel/deploy/update.sh            # latest release
sudo /opt/cs2-panel/deploy/update.sh v0.2.0     # a specific one
sudo /opt/cs2-panel/deploy/update.sh --rollback # back to the previous version
```

Game servers keep running while the panel updates.

## Where things live on the server

| Path | What |
|---|---|
| `/opt/cs2-panel` | Panel program |
| `/etc/cs2-panel/panel.json` | Panel settings (port, Owner SteamID, encryption key) |
| `/var/lib/cs2-panel/panel.db` | Panel database |
| `/srv/cs2/base` | The shared CS2 install |
| `/srv/cs2/instances/<name>/upper` | One server's own configs and plugins |
| `/srv/cs2/backups/deleted` | Files of deleted servers |

Logs: `journalctl -u cs2-panel` for the panel, `journalctl -u cs2@<name>` for a game server.

## Development

Needs Node.js 22.13 or newer.

```sh
npm install
npm test                      # backend tests
npm run build                 # frontend + backend bundle

# Run the panel with simulated servers (no systemd, no CS2 needed):
CS2PANEL_DEV=1 CS2PANEL_DEV_FAKE_BASE=1 npm run dev:server
npm run dev:web               # http://localhost:5173, then visit /api/auth/dev to sign in
```

In development mode, `/api/auth/dev` signs you in without Steam, and all server actions are simulated.
