import { useMemo, useState } from "react";

/**
 * Help: every page and option of the panel, in plain words. Static text; the search box filters
 * sections and lines. Keep it in step with the pages when features change.
 */

interface Item {
  term: string;
  text: string;
}
interface Section {
  id: string;
  title: string;
  /** Where to find it in the menu. */
  where: string;
  intro: string;
  items: Item[];
}

const SECTIONS: Section[] = [
  {
    id: "start",
    title: "Getting started",
    where: "Overview",
    intro:
      "CS2 Panel runs several CS2 servers on one machine. All servers share one copy of the game (the base); each server keeps only its own files (configs, plugins, maps it downloaded) on top. Updating CS2 therefore updates every server at once.",
    items: [
      {
        term: "First steps",
        text: "1) Game servers → Game update: install CS2 once. 2) Game servers → Servers → New server. 3) Start it from its page. 4) Optional: set up Matchmaking for events.",
      },
      {
        term: "Roles",
        text: "Owner: everything, including the team and secrets. Admin: everything except managing the Owner. Moderator: day-to-day server work (start/stop, players, commands) but not settings that change the machine.",
      },
      { term: "Preferences", text: "The gear icon at the top: your password, 12/24-hour clock and display options. Only affects you." },
      { term: "Update notice", text: "When a new panel version is installed (update.sh), open tabs show a notice to reload the page." },
    ],
  },
  {
    id: "monitor",
    title: "Monitor (home page)",
    where: "Monitor",
    intro: "How hard the machine and each server work. Sampled every minute; 7 days in detail and 90 days as hourly averages.",
    items: [
      {
        term: "Warnings",
        text: "Problems that need attention: a server that crashed and that systemd gave up restarting, high CPU or memory, a full disk. They clear by themselves when the problem is gone; Earlier warnings keeps the history.",
      },
      { term: "Charts", text: "CPU and memory for the whole machine and per server, network traffic and players per server. Pick the time range at the top." },
    ],
  },
  {
    id: "servers",
    title: "Servers",
    where: "Game servers → Servers",
    intro: "Every CS2 server with its state, map, players and port. Click one to open its page.",
    items: [
      {
        term: "New server",
        text: "Name, port (each server needs its own; the panel checks it's free), a preset (game mode and configs to start from), the GSLT token (Steam game server login token, needed to show in the public server browser), RCON and join password, max players, CPUs, and whether it starts with the machine.",
      },
      { term: "States", text: "Running, Starting (the game is loading), Not answering (running but doesn't reply to queries), Stopped, Crashed." },
      {
        term: "Start / Stop / Restart / Force stop",
        text: "At the top of a server's page. Force stop kills the process at once (use it when Stop hangs). A running server keeps its CPU choice and some settings until it's restarted (it says Restart required).",
      },
    ],
  },
  {
    id: "server-tabs",
    title: "A server's page",
    where: "Game servers → Servers → (a server)",
    intro: "Tabs for everything about one server.",
    items: [
      { term: "Overview", text: "State, map, players, version, uptime, recent activity, and its CPU and memory." },
      {
        term: "Players",
        text: "Who's online (kick, ban, see their Steam profile), recent players, and bans. Bans can be for a time or permanent, and apply to this server.",
      },
      { term: "Console", text: "The server's live log and an input line to send console commands (works while running)." },
      {
        term: "Commands",
        text: "Buttons for common things: change map (installed or Workshop), game mode switch, restart the match, warmup, pause, team and bot commands, and a message to all players. Server reply shows the answer.",
      },
      {
        term: "Config files",
        text: "Edit the server's cfg files (server.cfg, gamemode configs, your own). New config file creates one. Files that are the same as CS2's stock copy are tidied away on updates.",
      },
      {
        term: "Plugins",
        text: "Install and update Metamod, CounterStrikeSharp and plugins such as CS2-SimpleAdmin and the CS2 Panel Bridge. Loaded plugins shows what actually loaded. The bridge updates itself; others are updated by hand here. In-game admins and the change-map menu come from SimpleAdmin.",
      },
      {
        term: "Settings",
        text: "Name, port, passwords, GSLT, max players, start with the machine, CPUs, Scheduled restart (a daily time), Configs to run on every map start, Map cycle (for Casual servers: the maps it rotates through, in order or random; the bridge changes the map 10 s after a match ends), Save as preset, Duplicate and Delete (deleted servers' files are kept in backups/deleted).",
      },
    ],
  },
  {
    id: "game-update",
    title: "Game update",
    where: "Game servers → Game update",
    intro:
      "Installs and updates CS2 for all servers. An update warns players, stops every server, updates the shared game files, checks each server's files and starts the servers that were running.",
    items: [
      { term: "Update now / Validate", text: "Update now runs SteamCMD. Validate also checks every file (slower; use it if files seem broken)." },
      {
        term: "Automatic updates",
        text: "Off, Only tell me (notify), Install when no players are online (with a longest wait, after which it updates anyway), or Install right away. It checks Steam for a new build on a schedule.",
      },
      {
        term: "Result",
        text: "Finished: CS2 is updated and every server that was running is back up and answering (the game replies to a server query, not just running in systemd). CS2 updated, N servers down: the files are updated but a server didn't come back (hover to see why; usually a plugin such as CounterStrikeSharp needs an update for the new CS2 version: update it on the server's Plugins tab, then start the server). Failed: SteamCMD failed, or a server couldn't be stopped (then nothing was updated and the stopped servers are started again).",
      },
      {
        term: "After a big CS2 update",
        text: "Metamod and CounterStrikeSharp often need their own update before servers start again. The update log and the Monitor warnings show which servers are down.",
      },
    ],
  },
  {
    id: "presets",
    title: "Presets",
    where: "Game servers → Presets",
    intro: "Starting points for new servers: game mode and config files. Built-in presets cover Casual, Competitive, Wingman and more; you can make your own.",
    items: [
      { term: "Custom presets", text: "Create one here, or use Save as preset on a server's Settings tab to copy its configs." },
      { term: "Config files", text: "The cfg files a new server gets from the preset. Changing a preset doesn't change servers already made from it." },
    ],
  },
  {
    id: "shared",
    title: "Shared settings",
    where: "Game servers → Shared settings",
    intro:
      "Settings for every server at once: a hostname prefix, server tags and cvars. Written to cs2panel_shared.cfg, which runs at the top of each server's server.cfg.",
    items: [{ term: "Servers", text: "Untick a server to leave it out. Changes apply live to running servers." }],
  },
  {
    id: "mm",
    title: "Matchmaking",
    where: "Matchmaking",
    intro:
      "A public website (its own port, e.g. https://en.fredagsspiller.dk) where players sign in with Steam, join a lobby, get fair teams, ban maps and join a password-locked match server. Casual servers are listed there too. The CS2 Panel Bridge plugin must be on every match and casual server.",
    items: [
      {
        term: "Overview tab",
        text: "On/off switch, matches running now (cancel, see status), earlier matches with their scoreboard, and players: ratings and admin overrides.",
      },
      {
        term: "Ratings",
        text: "From Leetify (Premier, and FACEIT level/Elo when Leetify has it), or the number a player types in, or an admin override (wins over everything). FACEIT Elo: choose average with Premier, FACEIT first, only when there's no Premier, or off. The FACEIT Elo → Premier table is an estimate used only for balancing; players see their rating in its own format.",
      },
      { term: "Bot difficulty", text: "How good the bots are that fill empty spots." },
      {
        term: "Lobbies tab",
        text: "Competitive (up to 5v5, balanced), Wingman (2v2), 1v1 (aim duels, in Wingman mode), Fixed teams 5v5 and 2v2 (players pick their own team). For each: open/closed, map pool (installed or Workshop maps; × removes a Workshop map and deletes its files from the servers unless something still uses it), rules config run after every map load, Keep bought weapons (respawn with the guns you bought; on for 1v1), and which servers it may use (a server can serve several lobbies; matches take a free one).",
      },
      {
        term: "How a match runs",
        text: "Ready players → Make teams (most even split by rating) → captains ban maps → side pick → a free server is started and locked with a password; players get a Join button when it's ready. Warmup lasts until everyone is in (or Start without waiting). 15 s after the match ends everyone is kicked and the server is cleaned and freed.",
      },
      {
        term: "Bots",
        text: "In every lobby but 1v1, bots fill every empty spot: short teams at the start, and the spot of anyone who disconnects (the bot leaves when they're back or someone joins). On by default; off only when both captains untick it.",
      },
      {
        term: "Late joining",
        text: "Players can join a running match from the front page. They go to the team with fewer players (or the losing team, then the lower rating). Closed two rounds from the end, or when both captains untick it.",
      },
      {
        term: "Fixed teams",
        text: "Players pick Team 1 or Team 2. Full teams: anyone can start. Not full: both captains (best rating per team, ★) vote to start.",
      },
      {
        term: "Captains",
        text: "Only the two captains can cancel a match or start it without waiting for everyone (either captain). Admins can always cancel from the Overview tab.",
      },
      {
        term: "Scoreboards",
        text: "K, D, A, K/D and ADR per player, live on the match card and saved when the match ends. The site shows the last 20 matches to everyone, and each signed-in player can see all of their own matches.",
      },
      {
        term: "Cleanup",
        text: "A match server is only reused after a checked cleanup (everyone gone, bridge dropped the match, own password back). A failed cleanup shows on the Overview with Try again now / It's clean: free it.",
      },
    ],
  },
  {
    id: "mm-discord",
    title: "Matchmaking: Discord",
    where: "Matchmaking → Discord tab",
    intro: "Voice channels for matches, and an optional bot that moves players.",
    items: [
      {
        term: "Channel links",
        text: "An invite link; for Competitive/Wingman a Team 1 and Team 2 voice channel per server; one shared channel for 1v1 and one for casual (each can have its own per server). Players get a Join Discord channel button that opens the Discord app (with an Open in browser link).",
      },
      {
        term: "Discord bot",
        text: "Optional. Players link their Discord once on the site; when their match goes live the bot moves them from a waiting room into their team's channel (configured, or a private temporary one per team), and back afterwards. Needs your Discord application: Application ID, bot token, client secret, the redirect URL shown in the setup guide, and a waiting room channel. Check permissions and Test: move me help find problems.",
      },
      {
        term: "Move from any voice channel",
        text: "Off by default. When on, players are moved from any voice channel, not only the waiting room, unless they switched that off on the site. They're moved back to the channel they came from.",
      },
      { term: "Players' choices", text: "Move me to my match's voice channel (on by default for new links), and Move me back after the match." },
    ],
  },
  {
    id: "mm-casual",
    title: "Matchmaking: Casual",
    where: "Matchmaking → Casual tab",
    intro: "Casual servers are listed on the site for everyone, no sign-in needed: map, players, Join button and password. They're never used for matches.",
    items: [{ term: "Name", text: "What the casual card is called on the site (default Casual)." }],
  },
  {
    id: "mm-site",
    title: "Matchmaking: Site",
    where: "Matchmaking → Site tab",
    intro: "How the public site looks and how it's reached.",
    items: [
      {
        term: "Map images",
        text: "Thumbnails on the map veto, match cards and recent matches, plus the T and CT icons. Built-in maps' pictures come from the game files (read again after every CS2 update, or with Read images from the game files again), Workshop maps' from Steam. Upload your own for any map or side; remove the upload to go back to the automatic one. Without a picture the site shows a tile with the map's name, and coloured T/CT badges.",
      },
      { term: "Layout", text: "Classic (lobby cards) or Status board (a Ready to play? checklist next to a table of all lobbies)." },
      {
        term: "Language",
        text: "English or Dansk: what the site shows first. Visitors can switch at the top of the site; their choice is remembered on their device.",
      },
      {
        term: "Colours",
        text: "Themes (Default, Light, Night, Purple, Forest, Amber) and your own colour overrides with a live preview; icon and banner uploads; the site's title.",
      },
      {
        term: "HTTPS",
        text: "A free Let's Encrypt certificate via Cloudflare DNS (needs a Cloudflare token), renewed automatically. Optionally pushed to a Palo Alto firewall over its XML API.",
      },
    ],
  },
  {
    id: "team",
    title: "Team",
    where: "CS2 Panel → Team",
    intro: "Who can sign in to the panel, and their role (Owner, Admin, Moderator).",
    items: [{ term: "Add someone", text: "Give them a username and a temporary password; they choose their own on first sign-in." }],
  },
  {
    id: "backups",
    title: "Backups",
    where: "CS2 Panel → Backups",
    intro: "Server files and the panel's database.",
    items: [
      {
        term: "Make a backup",
        text: "By hand, for one server or the panel database. Server backups leave out Workshop downloads (they come back by themselves), logs and crash dumps. Two backups in the same second get their own names (…-2.tar.gz).",
      },
      { term: "Nightly backups", text: "Every night at a set time, keeping the last N." },
      { term: "All backups", text: "Download, restore or delete. Restoring a server replaces its own files (not the shared CS2 base)." },
      {
        term: "Restoring the panel's database",
        text: "Done on the machine with deploy/restore-db.sh, so the panel isn't running while its database is replaced.",
      },
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    where: "CS2 Panel → Notifications",
    intro: "Messages to a Discord channel (webhook) when things happen.",
    items: [
      {
        term: "Groups",
        text: "Pick what to hear about: problems (crashes, failed updates, servers down after an update), updates, restarts and more. Send a test message to check the webhook.",
      },
    ],
  },
  {
    id: "activity",
    title: "Activity",
    where: "CS2 Panel → Activity",
    intro: "Everything that happened, who did it (or System), and on which server: starts, stops, updates, bans, matchmaking, backups. Filter by server.",
    items: [],
  },
  {
    id: "settings",
    title: "Settings: CPU Management",
    where: "CS2 Panel → Settings",
    intro: "Which CPU cores each server runs on. Matters on machines with fast and slow cores, or many servers.",
    items: [
      { term: "Overview", text: "The machine's cores (on a virtual machine: its vCPUs), live usage, and which servers use which." },
      {
        term: "Allocation policy",
        text: "Legacy (the least-used CPU, as before), Automatic (a free core by the policy, avoiding reserved CPUs) or Manual. Reserved CPUs are never handed out automatically (e.g. a slow E-core).",
      },
      {
        term: "Servers",
        text: "What each server is set to and what it actually runs on; Restart required when they differ, conflicts when two servers share a CPU. The same picker is on a server's Settings tab.",
      },
    ],
  },
];

export function HelpPage() {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return SECTIONS;
    return SECTIONS.map((s) => {
      const hit = `${s.title} ${s.where} ${s.intro}`.toLowerCase().includes(t);
      const items = s.items.filter((i) => hit || `${i.term} ${i.text}`.toLowerCase().includes(t));
      return hit || items.length ? { ...s, items } : null;
    }).filter((s): s is Section => s !== null);
  }, [q]);

  return (
    <div className="page help-page">
      <div className="page-head">
        <div>
          <h1>Help</h1>
          <p className="hint">Every page and option in CS2 Panel, in plain words.</p>
        </div>
      </div>
      <label className="field" style={{ maxWidth: 420, marginBottom: 16 }}>
        <span>Search the help</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. bots, backup, Discord" />
      </label>
      <div className="help-layout">
        <nav className="panel help-toc" aria-label="Help sections">
          <ul>
            {shown.map((s) => (
              <li key={s.id}>
                <a href={`#help-${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="help-body">
          {shown.length === 0 && <p className="hint">Nothing matches “{q}”.</p>}
          {shown.map((s) => (
            <section key={s.id} id={`help-${s.id}`} className="panel">
              <h2 style={{ marginBottom: 2 }}>{s.title}</h2>
              <p className="hint" style={{ marginTop: 0 }}>
                {s.where}
              </p>
              <p>{s.intro}</p>
              {s.items.length > 0 && (
                <dl className="help-list">
                  {s.items.map((i) => (
                    <div key={i.term}>
                      <dt>{i.term}</dt>
                      <dd>{i.text}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
