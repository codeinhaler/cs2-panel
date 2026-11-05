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

Plugins (Metamod, CounterStrikeSharp) come in Phase 2; player kick/ban in Phase 3.

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

**5. Router:** for each server you create, forward its **UDP** game port (for example 27015) to the Debian machine. Don't forward TCP; RCON uses TCP on the same port and should stay on your network.

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
