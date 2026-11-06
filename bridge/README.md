# CS2 Panel Bridge

A small CounterStrikeSharp plugin that ships with cs2-panel. The panel installs it automatically together with CounterStrikeSharp.

- Keeps banned players out. The panel writes the ban list to `configs/plugins/Cs2PanelBridge/bans.json` and runs `cs2panel_reload`; banned players are kicked on connect, and online ones right away.
- Reports players with SteamIDs (`cs2panel_players`), which CS2's own `status` doesn't show.
- Never makes network connections. If the panel is down, the last ban list keeps being enforced.

Built by GitHub Actions (`bridge/package.sh`); needs the .NET 10 SDK to build locally.
