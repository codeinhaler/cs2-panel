using System.Text.Json;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Entities;
using CounterStrikeSharp.API.Modules.Memory;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace Cs2PanelBridge;

/// <summary>
/// Companion plugin for cs2-panel.
///
/// It never talks to the network. The panel writes the ban list to
/// configs/plugins/Cs2PanelBridge/bans.json and runs `cs2panel_reload` over
/// RCON; the plugin keeps players on that list out. The panel reads player
/// SteamIDs with `cs2panel_players`, since CS2's own `status` doesn't show them.
///
/// For the matchmaking site, the panel writes the players of a match and their
/// teams to configs/plugins/Cs2PanelBridge/match.json and runs
/// `cs2panel_match_reload`. While a match is on, only those players may join,
/// each is put on their team, warmup lasts until everyone is in, and
/// `cs2panel_match_status` reports how far the match is.
/// </summary>
public class Cs2PanelBridge : BasePlugin
{
    public override string ModuleName => "CS2 Panel Bridge";
    public override string ModuleVersion => "1.8.1";
    public override string ModuleAuthor => "cs2-panel";
    public override string ModuleDescription => "Enforces cs2-panel bans, locks matchmaking matches and reports players to the panel.";

    /// <summary>Marks the JSON line in RCON output so the panel can find it among other console text.</summary>
    private const string PlayersMarker = "CS2PANEL_PLAYERS ";
    private const string MatchMarker = "CS2PANEL_MATCH ";
    private const string CycleMarker = "CS2PANEL_MAPCYCLE ";
    /// <summary>Seconds of scoreboard before the cycle loads the next map; CS2's own end-of-match action is pushed later.</summary>
    private const float CycleDelay = 10.0f;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private Dictionary<ulong, BanEntry> _bans = new();

    private string BansFile => Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "configs", "plugins", "Cs2PanelBridge", "bans.json"));
    private string CycleFilePath => Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "configs", "plugins", "Cs2PanelBridge", "mapcycle.json"));

    /// <summary>The panel's map cycle for a Casual server, or null.</summary>
    private MapCycleFile? _cycle;
    /// <summary>Where in the cycle the current map is (-1: not one of its maps).</summary>
    private int _cycleIndex = -1;
    /// <summary>The map the cycle loads at the end of this match.</summary>
    private int _cycleNext = -1;
    /// <summary>The cycle entry being loaded right now, so a Workshop map is recognised after the load.</summary>
    private int _cycleLoading = -1;

    private string MatchFilePath => Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "configs", "plugins", "Cs2PanelBridge", "match.json"));

    /// <summary>The match being played, or null when the server is open to everyone.</summary>
    private MatchFile? _match;
    private Dictionary<ulong, MatchPlayer> _matchPlayers = new();
    private bool _matchOver;
    private bool _countdown;
    /// <summary>A casual server: no match, but each newcomer goes on the smaller team.</summary>
    private bool _casual;
    /// <summary>Counts map loads, so the panel can tell when its map change has happened.</summary>
    private int _mapLoads;
    /// <summary>Server.CurrentTime when the match ended, so the panel can time the kick from the real end.</summary>
    private float _matchOverAt;

    public override void Load(bool hotReload)
    {
        LoadBans();
        LoadMatch();
        LoadCycle();
        RegisterListener<Listeners.OnClientAuthorized>(OnClientAuthorized);
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _mapLoads++;
            _warmupSlain.Clear();
            // Loading a map runs the game mode's config and server.cfg, which reset the password
            // and bots. Put the match's own settings back once those have run.
            AddTimer(2.0f, () =>
            {
                // The lobby's own config (e.g. 1v1 rules) first, then the match's settings on top.
                ExecMatchConfig();
                HoldWarmup();
                ApplyCasual();
                ApplyMatchSettings();
                CycleOnMapStart();
            });
        });
        // And keep them, in case a config or an admin changes them during the match.
        AddTimer(5.0f, ApplyMatchSettings, TimerFlags.REPEAT);
        RegisterEventHandler<EventPlayerConnectFull>(OnPlayerConnectFull);
        RegisterEventHandler<EventPlayerTeam>(OnPlayerTeam);
        RegisterEventHandler<EventCsWinPanelMatch>(OnMatchOver);
        RegisterEventHandler<EventItemPurchase>(OnItemPurchase);
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        RegisterEventHandler<EventPlayerSpawn>(OnPlayerSpawn);
        RegisterEventHandler<EventPlayerDisconnect>(OnPlayerDisconnect);
        RegisterEventHandler<EventRoundStart>((_, _) => { _roundOver = false; return HookResult.Continue; });
        RegisterEventHandler<EventRoundEnd>((_, _) => { _roundOver = true; return HookResult.Continue; });
        AddCommandListener("jointeam", OnJoinTeam);
        // Tell people in warmup who the match is still waiting for.
        AddTimer(30.0f, AnnounceMissing, TimerFlags.REPEAT);
        if (hotReload)
        {
            Server.NextFrame(() =>
            {
                KickBannedPlayers();
                ApplyMatch();
            });
        }
    }

    private void OnClientAuthorized(int playerSlot, SteamID steamId)
    {
        // Bots have no SteamID; a match may have one filling in for a missing player.
        if (steamId.SteamId64 == 0) return;
        var ban = ActiveBan(steamId.SteamId64);
        var outsider = ban == null && _match != null && !_matchPlayers.ContainsKey(steamId.SteamId64);
        if (ban == null && !outsider) return;
        // Kick on the next frame; the player isn't fully set up inside this callback.
        Server.NextFrame(() =>
        {
            var player = Utilities.GetPlayerFromSlot(playerSlot);
            if (player is not { IsValid: true } || player.IsBot) return;
            if (ban != null) Kick(player, ban);
            else KickOutsider(player);
        });
    }

    [ConsoleCommand("cs2panel_reload", "Reloads the cs2-panel ban list and kicks banned players")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnReload(CCSPlayerController? caller, CommandInfo command)
    {
        var count = LoadBans();
        KickBannedPlayers();
        command.ReplyToCommand($"cs2panel: {count} active bans loaded");
    }

    [ConsoleCommand("cs2panel_players", "Lists players with SteamIDs for cs2-panel")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnPlayers(CCSPlayerController? caller, CommandInfo command)
    {
        var players = Utilities.GetPlayers()
            .Where(p => p is { IsValid: true, IsBot: false, IsHLTV: false } && p.UserId.HasValue)
            .Select(p => new PlayerInfo(p.UserId!.Value, p.SteamID.ToString(), p.PlayerName))
            .ToList();
        command.ReplyToCommand(PlayersMarker + JsonSerializer.Serialize(players, Json));
    }

    [ConsoleCommand("cs2panel_version", "Shows the cs2-panel bridge version")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnVersion(CCSPlayerController? caller, CommandInfo command)
    {
        command.ReplyToCommand($"cs2panel bridge {ModuleVersion}, {_bans.Count} bans");
    }

    // ------------------------------------------------------------- matchmaking

    [ConsoleCommand("cs2panel_match_reload", "Reloads the cs2-panel match (players and teams)")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnMatchReload(CCSPlayerController? caller, CommandInfo command)
    {
        var hadMatch = _match != null;
        LoadMatch();
        ApplyMatch();
        ApplyMatchSettings();
        // The server is open again: let warmup run out normally.
        if (hadMatch && _match == null) Server.ExecuteCommand("mp_warmup_pausetimer 0");
        ApplyCasual();
        command.ReplyToCommand(_match == null ? "cs2panel: no match, server open" : $"cs2panel: match {_match.MatchId} loaded, {_matchPlayers.Count} players");
    }

    [ConsoleCommand("cs2panel_match_status", "Reports the cs2-panel match for the panel")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnMatchStatus(CCSPlayerController? caller, CommandInfo command)
    {
        var phase = _match == null ? "none" : _matchOver ? "over" : IsWarmup() ? "warmup" : "live";
        var sideA = SideOf("a");
        int scoreA = 0, scoreB = 0;
        try
        {
            foreach (var team in Utilities.FindAllEntitiesByDesignerName<CCSTeam>("cs_team_manager"))
            {
                if (team.TeamNum == (int)CsTeam.Terrorist || team.TeamNum == (int)CsTeam.CounterTerrorist)
                {
                    if (team.TeamNum == (int)sideA) scoreA = team.Score;
                    else scoreB = team.Score;
                }
            }
        }
        catch (Exception e)
        {
            Logger.LogWarning(e, "cs2panel: could not read team scores");
        }
        var status = new MatchStatus(_match != null, _match?.MatchId ?? "", phase, MatchPlayersOnline().Count(), _matchPlayers.Count, scoreA, scoreB, _mapLoads, Server.MapName, _matchOver ? Math.Round(Server.CurrentTime - _matchOverAt, 1) : 0,
            // For the panel's check after a match: is everyone gone, and is the server's own password back?
            Utilities.GetPlayers().Count(p => p is { IsValid: true, IsBot: false, IsHLTV: false } && (int)p.Connected == 0), // 0 = fully connected
            ConVar.Find("sv_password")?.StringValue ?? "");
        command.ReplyToCommand(MatchMarker + JsonSerializer.Serialize(status, Json));
    }

    private void LoadMatch()
    {
        try
        {
            var file = File.Exists(MatchFilePath) ? JsonSerializer.Deserialize<MatchFile>(File.ReadAllText(MatchFilePath), Json) : null;
            var previous = _match?.MatchId;
            _casual = file is { Active: false, Casual: true };
            if (file is not { Active: true } || file.Players.Count == 0)
            {
                _match = null;
                _matchPlayers = new();
            }
            else
            {
                var players = new Dictionary<ulong, MatchPlayer>();
                foreach (var p in file.Players)
                {
                    if (ulong.TryParse(p.SteamId, out var id)) players[id] = p;
                }
                _match = file;
                _matchPlayers = players;
            }
            if (_match?.MatchId != previous)
            {
                _matchOver = false;
                _countdown = false;
                _loadouts.Clear();
                _died.Clear();
            }
        }
        catch (Exception e)
        {
            Logger.LogError(e, "cs2panel: could not read {File}", MatchFilePath);
        }
    }

    /// <summary>Puts the current match into effect for the players already on the server.</summary>
    private void ApplyMatch()
    {
        if (_match == null) return;
        HoldWarmup();
        foreach (var player in Utilities.GetPlayers().Where(p => p is { IsValid: true, IsBot: false, IsHLTV: false }))
        {
            if (!_matchPlayers.ContainsKey(player.SteamID)) KickOutsider(player);
            else Place(player);
        }
    }

    /// <summary>Runs the config the panel wrote for this match's lobby (a plain file name under cfg/).</summary>
    private void ExecMatchConfig()
    {
        if (_match == null || _matchOver || string.IsNullOrEmpty(_match.Exec)) return;
        if (!System.Text.RegularExpressions.Regex.IsMatch(_match.Exec, @"^[A-Za-z0-9_\-]+\.cfg$")) return;
        Server.ExecuteCommand($"exec {_match.Exec}");
    }

    /// <summary>Warmup goes on until everyone is in (or the players start the match from the site).</summary>
    private void HoldWarmup()
    {
        if (_match == null || _matchOver) return;
        Server.ExecuteCommand("mp_autoteambalance 0; mp_limitteams 0");
        if (IsWarmup()) Server.ExecuteCommand("mp_warmup_pausetimer 1");
    }

    private HookResult OnPlayerConnectFull(EventPlayerConnectFull @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if (_match == null && _casual && player is { IsValid: true, IsBot: false })
        {
            AddTimer(1.0f, () =>
            {
                if (player.IsValid) PlaceOnSmallerTeam(player);
            });
            return HookResult.Continue;
        }
        if (_match == null || player is not { IsValid: true, IsBot: false }) return HookResult.Continue;
        // The team menu comes up first; move the player once they're properly in.
        AddTimer(1.0f, () =>
        {
            if (player.IsValid) Place(player);
            CheckEveryoneIn();
        });
        // A 1v1 player who comes back mid-round would sit dead until the next round.
        AddTimer(2.5f, () => RespawnRejoined(player));
        return HookResult.Continue;
    }

    /// <summary>Between a round's end and the next round's start.</summary>
    private bool _roundOver;

    /// <summary>A 1v1: one match player per team (the other may be the bot).</summary>
    private bool IsDuel => _match != null && !_matchOver && _matchPlayers.Count is >= 1 and <= 2;

    /// <summary>
    /// In a live 1v1 round, a match player who rejoined (e.g. after a timeout) is respawned straight away,
    /// with the weapons they bought, instead of waiting out the round with nobody to play against.
    /// </summary>
    private void RespawnRejoined(CCSPlayerController player)
    {
        if (!IsDuel || _roundOver || IsWarmup() || !player.IsValid || player.PawnIsAlive) return;
        if (!_matchPlayers.ContainsKey(player.SteamID)) return;
        if ((CsTeam)player.TeamNum is not (CsTeam.Terrorist or CsTeam.CounterTerrorist)) return;
        if (KeepWeapons) _died.Add(player.SteamID);
        player.Respawn();
        player.PrintToChat(" Welcome back! You've been respawned.");
    }

    private HookResult OnPlayerTeam(EventPlayerTeam @event, GameEventInfo info)
    {
        if (_match != null) Server.NextFrame(CheckEveryoneIn);
        return HookResult.Continue;
    }

    private HookResult OnMatchOver(EventCsWinPanelMatch @event, GameEventInfo info)
    {
        if (_match != null)
        {
            _matchOver = true;
            _matchOverAt = Server.CurrentTime;
        }
        else if (CycleActive && _cycleNext >= 0)
        {
            var next = _cycleNext;
            AddTimer(CycleDelay, () =>
            {
                if (_match != null || !CycleActive || next >= _cycle!.Maps.Count) return;
                _cycleLoading = next;
                var entry = _cycle.Maps[next];
                Server.ExecuteCommand(entry.Workshop != null ? $"host_workshop_map {entry.Workshop}" : $"changelevel {entry.Map}");
            });
        }
        return HookResult.Continue;
    }

    // ------------------------------------------------------------- keep bought weapons (1v1)

    /// <summary>The last primary and pistol each player bought in this match.</summary>
    private readonly Dictionary<ulong, (string? Primary, string? Secondary)> _loadouts = new();
    /// <summary>Players who died since their last spawn: they get their bought weapons back.</summary>
    private readonly HashSet<ulong> _died = new();

    private static readonly HashSet<string> Pistols = new()
    {
        "weapon_glock", "weapon_hkp2000", "weapon_usp_silencer", "weapon_p250", "weapon_fiveseven",
        "weapon_tec9", "weapon_cz75a", "weapon_deagle", "weapon_revolver", "weapon_elite",
    };
    private static readonly HashSet<string> NotGuns = new()
    {
        "weapon_hegrenade", "weapon_flashbang", "weapon_smokegrenade", "weapon_molotov", "weapon_incgrenade",
        "weapon_decoy", "weapon_taser", "weapon_c4", "weapon_knife", "weapon_knife_t",
    };

    private bool KeepWeapons => _match is { KeepWeapons: true } && !_matchOver;

    private HookResult OnItemPurchase(EventItemPurchase @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if (!KeepWeapons || player is not { IsValid: true, IsBot: false }) return HookResult.Continue;
        var weapon = @event.Weapon ?? "";
        if (!weapon.StartsWith("weapon_")) weapon = "weapon_" + weapon;
        if (NotGuns.Contains(weapon) || weapon.StartsWith("weapon_knife")) return HookResult.Continue;
        _loadouts.TryGetValue(player.SteamID, out var l);
        _loadouts[player.SteamID] = Pistols.Contains(weapon) ? (l.Primary, weapon) : (weapon, l.Secondary);
        return HookResult.Continue;
    }

    private HookResult OnPlayerDeath(EventPlayerDeath @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if (KeepWeapons && player is { IsValid: true, IsBot: false }) _died.Add(player.SteamID);
        return HookResult.Continue;
    }

    private HookResult OnPlayerSpawn(EventPlayerSpawn @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if ((_match != null || _casual) && player is { IsValid: true, IsBot: false })
        {
            AddTimer(0.5f, () => FixNoclip(player));
            SlayOnceInWarmup(player);
        }
        if (!KeepWeapons || player is not { IsValid: true, IsBot: false }) return HookResult.Continue;
        var id = player.SteamID;
        if (!_died.Remove(id) || !_loadouts.TryGetValue(id, out var loadout)) return HookResult.Continue;
        // After the game has handed out the default pistol.
        AddTimer(0.3f, () => RestoreLoadout(player, loadout));
        return HookResult.Continue;
    }

    /// <summary>Players already slain once in this map's warmup.</summary>
    private readonly HashSet<ulong> _warmupSlain = new();

    /// <summary>
    /// A player's first spawn in warmup can come out broken (stuck in the map, or invisible but on the radar).
    /// Dying fixes it: warmup respawns them normally on one of the map's spawns. So each player is slain once,
    /// a moment after their first warmup spawn on this map.
    /// </summary>
    private void SlayOnceInWarmup(CCSPlayerController player)
    {
        if (!IsWarmup() || !_warmupSlain.Add(player.SteamID)) return;
        AddTimer(1.0f, () =>
        {
            if (player.IsValid && player.PawnIsAlive && IsWarmup()) player.PlayerPawn.Value?.CommitSuicide(false, true);
        });
    }

    private HookResult OnPlayerDisconnect(EventPlayerDisconnect @event, GameEventInfo info)
    {
        if (@event.Userid is { IsValid: true } p) _warmupSlain.Remove(p.SteamID);
        return HookResult.Continue;
    }

    /// <summary>A spawned player should walk, never fly through walls (a spawn racing a team change can leave them in noclip).</summary>
    private static void FixNoclip(CCSPlayerController player)
    {
        if (!player.IsValid || !player.PawnIsAlive) return;
        var pawn = player.PlayerPawn.Value;
        if (pawn == null || pawn.MoveType != MoveType_t.MOVETYPE_NOCLIP) return;
        if (ConVar.Find("sv_cheats")?.GetPrimitiveValue<bool>() == true) return;
        pawn.MoveType = MoveType_t.MOVETYPE_WALK;
        Schema.SetSchemaValue(pawn.Handle, "CBaseEntity", "m_nActualMoveType", 2);
        Utilities.SetStateChanged(pawn, "CBaseEntity", "m_MoveType");
    }

    private void RestoreLoadout(CCSPlayerController player, (string? Primary, string? Secondary) loadout)
    {
        if (!player.IsValid || !player.PawnIsAlive) return;
        var weapons = player.PlayerPawn.Value?.WeaponServices?.MyWeapons;
        if (weapons == null) return;
        var held = weapons.Where(w => w.IsValid && w.Value != null).Select(w => w.Value!).ToList();
        if (loadout.Secondary != null)
        {
            // The spawn pistol goes; the bought one comes back.
            foreach (var w in held.Where(w => Pistols.Contains(w.DesignerName))) w.Remove();
            player.GiveNamedItem(loadout.Secondary);
        }
        if (loadout.Primary != null && !held.Any(w => !Pistols.Contains(w.DesignerName) && !NotGuns.Contains(w.DesignerName) && !w.DesignerName.StartsWith("weapon_knife")))
        {
            player.GiveNamedItem(loadout.Primary);
        }
    }

    // ------------------------------------------------------------- map cycle (Casual servers)

    private bool CycleActive => _cycle is { Active: true } && _cycle.Maps.Count >= 2 && _match == null;

    private void LoadCycle()
    {
        try
        {
            var file = File.Exists(CycleFilePath) ? JsonSerializer.Deserialize<MapCycleFile>(File.ReadAllText(CycleFilePath), Json) : null;
            _cycle = file?.Maps.All(ValidEntry) == true ? file : null;
            if (_cycle == null) { _cycleIndex = -1; _cycleNext = -1; return; }
            _cycleIndex = _cycle.Maps.FindIndex(e => e.Map != null && e.Map.Equals(Server.MapName, StringComparison.OrdinalIgnoreCase));
            PickNext();
        }
        catch (Exception e)
        {
            _cycle = null;
            Logger.LogError(e, "cs2panel: could not read {File}", CycleFilePath);
        }
    }

    private static bool ValidEntry(MapCycleEntry e) =>
        (e.Map != null && System.Text.RegularExpressions.Regex.IsMatch(e.Map, @"^[A-Za-z0-9_\-]+$")) ||
        (e.Workshop != null && System.Text.RegularExpressions.Regex.IsMatch(e.Workshop, @"^\d+$"));

    /// <summary>After a map load: note where we are, choose the next map, and keep CS2 from changing map itself.</summary>
    private void CycleOnMapStart()
    {
        if (!CycleActive) { _cycleLoading = -1; return; }
        var byName = _cycle!.Maps.FindIndex(e => e.Map != null && e.Map.Equals(Server.MapName, StringComparison.OrdinalIgnoreCase));
        _cycleIndex = byName >= 0 ? byName : _cycleLoading >= 0 ? _cycleLoading : -1;
        _cycleLoading = -1;
        PickNext();
        Server.ExecuteCommand("mp_match_end_changelevel 0; mp_match_end_restart 0; mp_match_restart_delay 25");
    }

    private void PickNext()
    {
        var n = _cycle?.Maps.Count ?? 0;
        if (n < 2) { _cycleNext = -1; return; }
        if (_cycle!.Random)
        {
            var pick = Random.Shared.Next(n - (_cycleIndex >= 0 ? 1 : 0));
            _cycleNext = _cycleIndex >= 0 && pick >= _cycleIndex ? pick + 1 : pick;
        }
        else _cycleNext = (_cycleIndex + 1) % n;
    }

    [ConsoleCommand("cs2panel_mapcycle_reload", "Re-reads the map cycle written by cs2-panel")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnCycleReload(CCSPlayerController? caller, CommandInfo command)
    {
        LoadCycle();
        if (CycleActive) Server.ExecuteCommand("mp_match_end_changelevel 0; mp_match_end_restart 0; mp_match_restart_delay 25");
        command.ReplyToCommand(CycleActive ? $"cs2panel: map cycle with {_cycle!.Maps.Count} maps" : "cs2panel: no map cycle");
    }

    [ConsoleCommand("cs2panel_mapcycle_status", "Reports the map cycle for the panel")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnCycleStatus(CCSPlayerController? caller, CommandInfo command)
    {
        string? next = null;
        if (CycleActive && _cycleNext >= 0 && _cycleNext < _cycle!.Maps.Count)
        {
            var e = _cycle.Maps[_cycleNext];
            next = e.Workshop != null ? $"workshop:{e.Workshop}" : e.Map;
        }
        command.ReplyToCommand(CycleMarker + JsonSerializer.Serialize(new { active = CycleActive, next }, Json));
    }

    /// <summary>Match players can't switch to the other team.</summary>
    private HookResult OnJoinTeam(CCSPlayerController? player, CommandInfo command)
    {
        if (_match == null || player is not { IsValid: true } || !_matchPlayers.ContainsKey(player.SteamID)) return HookResult.Continue;
        var want = DesiredTeam(player.SteamID);
        if (!int.TryParse(command.GetArg(1), out var requested) || requested == (int)want) return HookResult.Continue;
        player.PrintToChat($" You're playing {(want == CsTeam.CounterTerrorist ? "CT" : "T")} in this match.");
        if ((CsTeam)player.TeamNum != want) Server.NextFrame(() => Place(player));
        return HookResult.Handled;
    }

    private void Place(CCSPlayerController player)
    {
        if (_match == null || !player.IsValid || !_matchPlayers.ContainsKey(player.SteamID)) return;
        var want = DesiredTeam(player.SteamID);
        if ((CsTeam)player.TeamNum != want) JoinTeam(player, want);
    }

    /// <summary>
    /// Puts a player on a team the way the team menu does, so the game spawns them properly (in warmup too).
    /// A forced team change plus Respawn() gave the first player a broken body: stuck in the map, or invisible.
    /// </summary>
    private static void JoinTeam(CCSPlayerController player, CsTeam team)
    {
        if ((CsTeam)player.TeamNum is CsTeam.None or CsTeam.Spectator) player.ExecuteClientCommandFromServer($"jointeam {(int)team} 1");
        else player.ChangeTeam(team);
    }

    /// <summary>The match's password and bot, from match.json. Safe to run again and again.</summary>
    private void ApplyMatchSettings()
    {
        if (_match == null || _matchOver) return;
        if (_match.Password != null) Server.ExecuteCommand($"sv_password \"{Clean(_match.Password)}\"");
        if (_match.Bot is { } bot)
        {
            var side = bot.Side == "t" ? "T" : "CT";
            Server.ExecuteCommand($"bot_quota_mode normal; bot_difficulty {Math.Clamp(bot.Difficulty, 0, 3)}; bot_join_team {side}; bot_quota 1");
        }
        else
        {
            Server.ExecuteCommand("bot_quota 0; bot_kick");
        }
    }

    [ConsoleCommand("cs2panel_kick_all", "Kicks every player (after a match), with a reason")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnKickAll(CCSPlayerController? caller, CommandInfo command)
    {
        var reason = Clean(command.ArgString.Trim().Trim('"'));
        if (reason.Length == 0) reason = "The match is over";
        var count = 0;
        foreach (var p in Utilities.GetPlayers().Where(p => p is { IsValid: true, IsBot: false, IsHLTV: false }))
        {
            if (!p.UserId.HasValue) continue;
            Server.ExecuteCommand($"kickid {p.UserId.Value} \"{reason}\"");
            count++;
        }
        command.ReplyToCommand($"cs2panel: kicked {count} players");
    }

    /// <summary>
    /// The side a match player belongs on: wherever their teammates are now (sides
    /// swap at half time), or the side they started on if none are here.
    /// </summary>
    private CsTeam DesiredTeam(ulong steamId)
    {
        if (!_matchPlayers.TryGetValue(steamId, out var entry)) return CsTeam.Spectator;
        foreach (var p in MatchPlayersOnline())
        {
            if (p.SteamID == steamId) continue;
            if (_matchPlayers.TryGetValue(p.SteamID, out var mate) && mate.Group == entry.Group)
            {
                var side = (CsTeam)p.TeamNum;
                if (side is CsTeam.Terrorist or CsTeam.CounterTerrorist) return side;
            }
        }
        return entry.Team == "t" ? CsTeam.Terrorist : CsTeam.CounterTerrorist;
    }

    private CsTeam SideOf(string group)
    {
        foreach (var p in MatchPlayersOnline())
        {
            if (_matchPlayers.TryGetValue(p.SteamID, out var mp) && mp.Group == group)
            {
                var side = (CsTeam)p.TeamNum;
                if (side is CsTeam.Terrorist or CsTeam.CounterTerrorist) return side;
            }
        }
        var first = _matchPlayers.Values.FirstOrDefault(p => p.Group == group);
        return first?.Team == "t" ? CsTeam.Terrorist : CsTeam.CounterTerrorist;
    }

    private IEnumerable<CCSPlayerController> MatchPlayersOnline() =>
        Utilities.GetPlayers().Where(p => p is { IsValid: true, IsBot: false, IsHLTV: false } && _matchPlayers.ContainsKey(p.SteamID));

    /// <summary>When every match player is in and on a team, warmup ends after a short countdown.</summary>
    private void CheckEveryoneIn()
    {
        if (_match == null || _matchOver || _countdown || !IsWarmup()) return;
        var ready = MatchPlayersOnline().Count(p => (CsTeam)p.TeamNum is CsTeam.Terrorist or CsTeam.CounterTerrorist);
        if (ready < _matchPlayers.Count) return;
        _countdown = true;
        Server.PrintToChatAll($" All {ready} players are here. The match starts in 10 seconds.");
        AddTimer(10.0f, () =>
        {
            _countdown = false;
            if (_match != null && IsWarmup()) Server.ExecuteCommand("mp_warmup_pausetimer 0; mp_warmup_end");
        });
    }

    private void AnnounceMissing()
    {
        if (_match == null || _matchOver || !IsWarmup()) return;
        var online = MatchPlayersOnline().Select(p => p.SteamID).ToHashSet();
        var missing = _matchPlayers.Where(kv => !online.Contains(kv.Key)).Select(kv => Clean(kv.Value.Name)).ToList();
        if (missing.Count > 0) Server.PrintToChatAll($" Waiting for: {string.Join(", ", missing)}");
    }

    private static bool IsWarmup()
    {
        try
        {
            var rules = Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules").FirstOrDefault()?.GameRules;
            return rules?.WarmupPeriod ?? true;
        }
        catch
        {
            return true;
        }
    }

    private static void KickOutsider(CCSPlayerController player)
    {
        if (!player.UserId.HasValue) return;
        Server.ExecuteCommand($"kickid {player.UserId.Value} \"This server is reserved for a match right now\"");
    }

    // ------------------------------------------------------------- casual servers

    /// <summary>Keeps casual teams even: automatic balancing, at most one player difference when switching.</summary>
    private void ApplyCasual()
    {
        if (_match == null && _casual) Server.ExecuteCommand("mp_autoteambalance 1; mp_limitteams 1");
    }

    /// <summary>A newcomer goes on the team with fewer people (random on a tie). They can still switch afterwards.</summary>
    private void PlaceOnSmallerTeam(CCSPlayerController player)
    {
        var team = (CsTeam)player.TeamNum;
        if (team is CsTeam.Terrorist or CsTeam.CounterTerrorist) return;
        var others = Utilities.GetPlayers().Where(p => p is { IsValid: true, IsHLTV: false } && p.SteamID != player.SteamID).ToList();
        var t = others.Count(p => (CsTeam)p.TeamNum == CsTeam.Terrorist);
        var ct = others.Count(p => (CsTeam)p.TeamNum == CsTeam.CounterTerrorist);
        var pick = t < ct ? CsTeam.Terrorist : ct < t ? CsTeam.CounterTerrorist : (Random.Shared.Next(2) == 0 ? CsTeam.Terrorist : CsTeam.CounterTerrorist);
        JoinTeam(player, pick);
    }

    // ------------------------------------------------------------- bans

    private int LoadBans()
    {
        try
        {
            if (!File.Exists(BansFile))
            {
                _bans = new();
                return 0;
            }
            var file = JsonSerializer.Deserialize<BanFile>(File.ReadAllText(BansFile), Json);
            var bans = new Dictionary<ulong, BanEntry>();
            foreach (var b in file?.Bans ?? new())
            {
                if (ulong.TryParse(b.SteamId, out var id)) bans[id] = b;
            }
            _bans = bans;
            return bans.Values.Count(b => !b.IsExpired);
        }
        catch (Exception e)
        {
            // Keep the previous list rather than letting everyone in.
            Logger.LogError(e, "cs2panel: could not read {File}", BansFile);
            return _bans.Count;
        }
    }

    private BanEntry? ActiveBan(ulong steamId64) =>
        _bans.TryGetValue(steamId64, out var ban) && !ban.IsExpired ? ban : null;

    private void KickBannedPlayers()
    {
        foreach (var player in Utilities.GetPlayers().Where(p => p is { IsValid: true, IsBot: false }))
        {
            var ban = ActiveBan(player.SteamID);
            if (ban != null) Kick(player, ban);
        }
    }

    private static void Kick(CCSPlayerController player, BanEntry ban)
    {
        if (!player.UserId.HasValue) return;
        var until = ban.ExpiresAt is { } e ? $" until {e.ToUniversalTime():yyyy-MM-dd HH:mm} UTC" : " permanently";
        var reason = Clean(string.IsNullOrWhiteSpace(ban.Reason) ? "No reason given" : ban.Reason);
        Server.ExecuteCommand($"kickid {player.UserId.Value} \"You are banned{until}: {reason}\"");
    }

    /// <summary>Removes characters that would break out of the quoted kick message.</summary>
    private static string Clean(string s) =>
        new string(s.Where(c => c != '"' && c != ';' && c != '\n' && c != '\r').ToArray());
}

public record PlayerInfo(
    [property: JsonPropertyName("userId")] int UserId,
    [property: JsonPropertyName("steamId")] string SteamId,
    [property: JsonPropertyName("name")] string Name);

public record MatchStatus(
    [property: JsonPropertyName("active")] bool Active,
    [property: JsonPropertyName("matchId")] string MatchId,
    [property: JsonPropertyName("phase")] string Phase,
    [property: JsonPropertyName("connected")] int Connected,
    [property: JsonPropertyName("expected")] int Expected,
    [property: JsonPropertyName("scoreA")] int ScoreA,
    [property: JsonPropertyName("scoreB")] int ScoreB,
    [property: JsonPropertyName("mapLoads")] int MapLoads,
    [property: JsonPropertyName("map")] string Map,
    [property: JsonPropertyName("overSeconds")] double OverSeconds,
    [property: JsonPropertyName("humans")] int Humans,
    [property: JsonPropertyName("password")] string Password);

public class MatchFile
{
    public int Version { get; set; }
    public bool Active { get; set; }
    /// <summary>No match; a casual server where newcomers are put on the smaller team.</summary>
    public bool Casual { get; set; }
    public string MatchId { get; set; } = "";
    /// <summary>The match's password; put back after every map load.</summary>
    public string? Password { get; set; }
    /// <summary>The one bot filling a short team, or none.</summary>
    public MatchBot? Bot { get; set; }
    /// <summary>Players get the weapons they bought back after dying (1v1).</summary>
    public bool KeepWeapons { get; set; }
    /// <summary>A config under cfg/ run after every map load, before the match's own settings.</summary>
    public string? Exec { get; set; }
    public List<MatchPlayer> Players { get; set; } = new();
}

public class MapCycleFile
{
    public int Version { get; set; }
    /// <summary>Only when the server runs Casual and the cycle has 2 or more maps.</summary>
    public bool Active { get; set; }
    public bool Random { get; set; }
    public List<MapCycleEntry> Maps { get; set; } = new();
}

public class MapCycleEntry
{
    /// <summary>An installed map, e.g. de_dust2.</summary>
    public string? Map { get; set; }
    /// <summary>A Workshop map's ID.</summary>
    public string? Workshop { get; set; }
}

public class MatchBot
{
    /// <summary>Side at the start: "ct" or "t".</summary>
    public string Side { get; set; } = "ct";
    public int Difficulty { get; set; } = 1;
}

public class MatchPlayer
{
    public string SteamId { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>Side at the start: "ct" or "t".</summary>
    public string Team { get; set; } = "ct";
    /// <summary>Which of the two teams: "a" or "b".</summary>
    public string Group { get; set; } = "a";
}

public class BanFile
{
    public int Version { get; set; }
    public List<BanEntry> Bans { get; set; } = new();
}

public class BanEntry
{
    public string SteamId { get; set; } = "";
    public string Reason { get; set; } = "";
    public DateTimeOffset? ExpiresAt { get; set; }

    [JsonIgnore]
    public bool IsExpired => ExpiresAt is { } e && e <= DateTimeOffset.UtcNow;
}
