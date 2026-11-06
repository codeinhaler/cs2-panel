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
- Automatic actions show up in Activity as "System", with the reason.

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
