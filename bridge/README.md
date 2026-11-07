# CS2 Panel Bridge

A small CounterStrikeSharp plugin that ships with cs2-panel. The panel installs it automatically together with CounterStrikeSharp.

- Keeps banned players out. The panel writes the ban list to `configs/plugins/Cs2PanelBridge/bans.json` and runs `cs2panel_reload`; banned players are kicked on connect, and online ones right away.
- Reports players with SteamIDs (`cs2panel_players`), which CS2's own `status` doesn't show.
- Locks a server for a matchmaking match. The panel writes the match's players and teams to `configs/plugins/Cs2PanelBridge/match.json` and runs `cs2panel_match_reload`. While a match is on, only those players can join, each is put on their team (and can't switch), warmup lasts until everyone is in, then ends after a 10-second countdown. `cs2panel_match_status` reports the phase, how many are in, and the score. Writing `{"active": false}` and reloading opens the server again.
- Never makes network connections. If the panel is down, the last ban list keeps being enforced.

Built by GitHub Actions (`bridge/package.sh`); needs the .NET 10 SDK to build locally.
