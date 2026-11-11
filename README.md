# cs2-panel

A web panel for running CS2 community servers on one Debian machine: create servers, start and stop them, edit their configs, watch the console and update CS2, with a small admin team signing in through Steam.

The design is in [docs/DESIGN.md](docs/DESIGN.md).

The Matchmaking page has tabs: **Overview** (site status, lobbies, matches now, history), **Lobbies**, **Discord** (channel links and the bot), **Casual** and **Site** (name, port, look, HTTPS, Leetify); one Save covers the settings on all tabs and stays in view while there are changes.

The menu: **Monitor** (the home page), **Game servers** (Servers, Game update, Presets, Shared settings), **Matchmaking**, and **CS2 Panel** (Team, Backups, Notifications, Activity, Settings). The two groups fold open when clicked, and on their own when you're on one of their pages. The server list is at `/servers`; old `/monitor` links go to the home page.

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
- **Map cycle** (server Settings, servers in Casual): a list of installed and Workshop maps, in order or random (never the same map twice in a row). At the end of each match, after 10 seconds of scoreboard, the CS2 Panel Bridge loads the next map; CS2's own end-of-match map change is switched off, so the panel is in charge. The Settings page shows the next map. Needs 2 maps or more and CounterStrikeSharp with bridge 1.6.0; servers in other modes, and match servers during a match, don't cycle.
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

## Discord bot (optional)

On the Matchmaking page, under **Discord bot**. Players who link their Discord account on the matchmaking site and switch on "Move me to my match's voice channel" are moved from the waiting room into their match's channel when the match goes live, and back after it. Everyone else keeps the **Join Discord channel** button. Matchmaking never waits for Discord: if the bot is off, misconfigured or Discord is down, matches start and run as normal.

- **Runs inside the panel**: no extra service, port or library. It uses Discord's REST API (moving members, reading a member's voice state, creating and deleting channels need no Gateway connection), with a queue that waits out Discord's rate limits. Discord shows the bot as offline in the member list; the panel shows its real status (Ready, Error, Not set up, Off, last success, last problem).
- **Channels**: Competitive and Wingman use the Team 1/Team 2 channels from the Discord section, or temporary channels per team ("Match #42 · Team 1"). 1v1 uses the shared 1v1 channel (or a server's own), or a temporary channel per match ("1v1 #101"). Temporary channels go in a category you choose, are private to that team's linked players by default, and are removed once the panel's players have left after the match. Configured channels are never deleted.
- **Rules**: only players in a waiting-room channel are moved (never out of other conversations); each player is moved at most once per match, so someone who leaves isn't pulled back; after the match only players still in the match's channel are moved back, to the waiting room they came from. One Discord user on several Steam accounts: the match that moved them first keeps their voice. A late joiner is let into the private channel and moved.
- **Restarts**: sessions and channels are stored in the database. At start and every 10 minutes the panel closes those of matches that aren't running, and (if allowed) removes panel-named channels left in the category by a crash (older than 10 minutes, matches not running).
- **Linking**: Discord OAuth2 with only the `identify` scope; the state is tied to the player's Steam session; the access token is used once to read the user ID and thrown away. Several Steam accounts can link to one Discord user (each signs in with Discord itself); the choices belong to the Discord user.

**Setup (once)**:
1. In the [Discord Developer Portal](https://discord.com/developers/applications) create an application. Copy the **Application ID**.
2. **Bot** tab: reset and copy the token. No privileged gateway intents are needed.
3. **OAuth2** tab: copy the **Client Secret**, and add the redirect `https://<your matchmaking site>/api/discord/callback` (the Discord bot panel shows the exact address once HTTPS is on).
4. Paste the three into the Discord bot panel, add the waiting-room voice channel link(s) and, for temporary channels, the category's link. Save.
5. Invite the bot with the link the panel shows. It asks for View Channels, Connect, Move Members and Manage Channels (only needed for temporary channels), not Administrator. If you use private temporary channels, the bot's role needs these permissions on the category too.
6. Press **Check permissions**, then **Test: move me** (link your own Steam account on the matchmaking site first and sit in any voice channel).

The token and client secret are stored encrypted in the panel's database and never shown again or logged.

## CPU Management

Under **CS2 Panel → Settings**. Each server runs on a set of CPUs (`taskset -c` in its systemd service), shown and changed here or on the server's Settings tab (same data, same save).

- **What the machine has**: read from `/sys` and `/proc`: logical CPUs, cores and their SMT threads, sockets, NUMA nodes, shared caches (e.g. AMD CCDs), Intel P- and E-cores, and the CPUs the panel may use (container or cgroup limits). In a virtual machine (VMware, KVM/Proxmox, Hyper-V, cloud) the CPUs are shown as vCPUs, never as physical cores: a VM without SMT is a plain list of vCPUs, and a VM that shows cores/threads is labelled as the VM's own layout. If nothing can be read, plain CPUs are used; detection never stops a server from starting.
- **Overview**: one block per core (or vCPU) with the servers on it, its CPU IDs and live usage (from `/proc/stat`; a core's threads are counted once). Blocks are marked Free, In use, Shared, Conflict, Reserved, Restart required or Mismatch, with words as well as colours, and grouped by P/E cores, socket, NUMA node or cache when that applies. Click a block for its details and to change the assignment of a server on it. "Free" means no game server is set to it, not that the OS doesn't use it. Inside a VM, usage is the VM's view.
- **Servers table**: every server with its status, Automatic/Manual, configured and actual CPUs (read from the running CS2 process's `/proc/<pid>/status`), conflicts, missing CPUs and "Restart required".
- **Allocation policy** (for new servers and servers set to Automatic): **Legacy** (default; one CPU per server, the least used, as before), **Automatic** (topology-aware: each server its own core, never a thread of a core another server uses, P-cores first, never reserved CPUs; shares the least-used core with a warning when none is free) or **Manual** (you pick; a free core is suggested). Options: use the core layout, give a server all threads of its core, prefer P-cores, allow sharing (Shared instead of Conflict), and reserved CPUs (e.g. an E-core vCPU you pinned in ESXi).
- **Safe by design**: existing servers keep their CPU and count as Manual; nothing is moved in the background. Saving a change on a running server doesn't restart it; it shows Restart required and applies at the next restart. If a server's CPUs are gone (fewer vCPUs after a VM change) it starts on the ones that are left (or all of them) and is flagged. Only Admins and the Owner can change CPUs or the policy; lists are validated and normalised before they reach the launch file.

## Matchmaking site

For CS evenings: players open one web page, sign in with Steam, and get put in even teams.

- **Settings** are on the panel's **Matchmaking** page: switch the site on, pick its port (default 8090), the servers matches may use, and the map pool. The site is a separate web server with only the matchmaking page on it, so you can forward its port on your router while the panel itself stays on your network. Forward the port as **TCP**.
- **Ratings**: each player's Premier rating comes from [Leetify](https://leetify.com) when Leetify knows them; otherwise they type in their own. You can set anyone's rating on the panel. A Leetify API key (optional, from leetify.com/app/developer) gives higher limits. Leetify's data isn't stored, as their rules ask.
- **Lobbies**: players pick **Competitive** (up to 5v5), **Wingman** (2v2) or **1v1** when they come to the page, and can switch while they're not in a match. Each lobby has its own map pool and its own servers (tick them under the lobby on the Matchmaking page; a server can serve more than one lobby), and you choose which lobbies are open. A match uses a free server from its own lobby's list, so a busy 1v1 server never blocks Competitive. Settings from before keep working: every lobby starts with the servers that were ticked for matches.
- **Teams**: players in a lobby tick Ready. Anyone can press **Make teams**: the ready players (up to 10, 4 or 2) are split the most even way. With an odd number, a bot joins the smaller team so nobody sits out (bot difficulty is a setting, and it counts as a matching rating when balancing); with an even number there are no bots, so 2 players in Wingman play 1v1. Each captain has a "Fill the short team with a bot" tick box (on by default, shown only when there's a bot); the bot leaves only when both untick it, and comes back if either ticks it again, also mid-match. Only when more are ready than fit does anyone wait, and they go first next time. The players on those teams can ask for other teams, cancel, or go.
- **Map veto like FACEIT**: the best-rated player on each team is captain. Captains take turns banning maps until one is left; a random map is banned if time runs out. The team that didn't ban last picks CT or T.
- **The server**: a free server from the ones you picked is started if needed, loads the map in the lobby's game mode (1v1 runs in Wingman mode) with a one-off password, and only lets the match's players in, each on their own team. Players get a **Join the server** button only once the server has loaded the match (the bridge reports it), so nobody gets "bad password" from a server that's still changing over. The bridge re-applies the match's password and bot settings after every map load, because the game mode configs would otherwise reset them. Warmup lasts until everyone is in (or someone presses "Start without waiting"), and players in warmup play rather than watch. When the match ends, everyone sees the scoreboard for 15 seconds and is then kicked with "Match over, thanks for playing! Back to the site for the next match."; a cancelled or ended match kicks at once. Then the server gets its own password back. A server that was just emptied is used last.
- **Rules per lobby**: each lobby on the Matchmaking page has a "Rules config" box. The bridge runs it on the match server after every map load, then puts the match password and bot settings back on top. When the match is over the server goes back to its own game mode and map, which drops the lobby's rules. Lines that would fight the match are skipped (warmup and restart commands, map changes, `sv_password`, `bot_` commands, `exec`). 1v1 comes with an aim-duel config: first to 16, 90-second rounds, no halftime or overtime, $16,000 and armour every round, buy anywhere. A "Keep bought weapons" tick box per lobby (on for 1v1) gives players the gun and pistol they last bought back when they respawn after dying (bridge 1.7.0). A 1v1 player who reconnects in the middle of a round is respawned straight away instead of waiting for the next round (bridge 1.8.1). If the config sets `mp_maxrounds`, late joining closes two rounds before that ends.
- **Matches on the site**: running matches are listed for everyone, so people in that lobby can join them. A finished, cancelled or ended match stays for 30 minutes, but only for its own players; the full history is on the Matchmaking page.
- **Cleanup after a match**: a server only goes back into the pool once its cleanup has been done and checked through the bridge: everyone kicked and gone, the match dropped (no player list, team lock or match password), and the server's own password back. Removing bots and loading the server's own mode and map are best effort. A stopped server only needs its match.json cleared. If a step fails (RCON timeout, server not answering, bridge problem), the server stays out of the pool and the cleanup is retried after 5 s, 10 s, 20 s … up to every 5 minutes, also after a panel restart. The Matchmaking page shows the error, with **Try again now** and **It's clean: free it** (for a server you've sorted out by hand). Needs bridge 1.8.0 for the people and password checks; older bridges skip those two checks.
- **Several matches at once**: a running match never locks its lobby. Others in the same lobby can make teams and get the next free server. The site and the Matchmaking page show why a server isn't free (running a match, being emptied, people on it, no bridge); when none is, players see "All match servers are busy; teams can be made when one is free."
- **Discord**: on the Matchmaking page (right-click a voice channel → Copy Link). **1v1**: one shared channel that every 1v1 server uses, including servers added later, with an optional own channel per server. **Competitive and Wingman**: a Team 1 and Team 2 channel per server (listed once even if it's in both lobbies). **Casual**: a shared channel plus an optional own channel per casual server. Plus an invite link. The lists follow the lobby and casual ticks by server ID; links of deleted servers are dropped on save. The channel is chosen by the match's lobby, so a server used for both Wingman and 1v1 gets the right one. Players get one **Join Discord channel** button (it opens the app, with "Open in browser instead" under it) and "Not on our Discord? Join here".
- **Joining a running match**: when a team in a live match has room (fewer people than the lobby's team size, or a bot filling a spot), players in that lobby get a **Join this match** button. A team playing with the bot gets them first, in the bot's place; otherwise they go to the losing team if it has room, otherwise the team with room; on a tie, the team with the lower total rating. When a joiner leaves the other team one player short (e.g. 2v1), a bot joins that team, and the next joiner takes its place. Joining closes when a team is two rounds from winning. Each captain has a "Let people join mid-match" tick box; the match closes to new players only when both untick it.
- **Casual servers**: tick servers under "Casual servers" on the Matchmaking page and give the card a name ("Casual" by default). People who aren't signed in see them on the front page; signed-in players see the casual card next to the lobbies (hidden while they're in a lobby or match), each with the map, head count and a Join button (the server's password is shown). No ratings, teams or veto: newcomers are put on the smaller team and can switch afterwards (needs bridge 1.3.0; without it CS2's own auto-balance decides). Casual servers are never used for matches. People who aren't signed in see a note that matches need a Steam sign-in.
- **Look**: pick a theme on the Matchmaking page (Default, Light, Night, Purple, Forest), change its colours with colour pickers (with a live preview), and upload an icon (PNG/JPG/WebP, 512 KB) and a banner (3 MB). Players see it from the first paint.
- **HTTPS**: on the Matchmaking page, switch on HTTPS, enter the domain (e.g. `en.fredagsspiller.dk`), an email and a Cloudflare API token ("Edit zone DNS" template, limited to the zone). The panel gets a Let's Encrypt certificate by adding a TXT record at Cloudflare (so nothing needs to reach the server for that), serves the site on port 443 and redirects port 80 to it. It renews by itself when fewer than 30 days are left, without restarting the site. Point the domain's A record at your public IP and forward TCP 443 and 80. While HTTPS is on, the site's own port (8090) isn't used.
- **Palo Alto (inbound SSL inspection)**: enter the firewall's management address and a certificate name, check the certificate the firewall shows against its own, and log in once with an admin that may use the XML API (import and commit); only the API key is kept. After every new certificate the panel imports the certificate and key under that name (replacing the old one) and does a partial commit of that admin's changes. Use that certificate name in the inbound decryption rule.
- Servers used for matches need CounterStrikeSharp installed (the CS2 Panel Bridge comes with it). After a panel update the bridge updates itself on every server that has it, once nobody is on the server and it isn't in a match (checked every 5 minutes; installing restarts a running server). Activity shows each automatic update. Other plugins are only updated by hand.

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
