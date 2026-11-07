using System.Text.Json;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Entities;
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
    public override string ModuleVersion => "1.2.0";
    public override string ModuleAuthor => "cs2-panel";
    public override string ModuleDescription => "Enforces cs2-panel bans, locks matchmaking matches and reports players to the panel.";

    /// <summary>Marks the JSON line in RCON output so the panel can find it among other console text.</summary>
    private const string PlayersMarker = "CS2PANEL_PLAYERS ";
    private const string MatchMarker = "CS2PANEL_MATCH ";

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private Dictionary<ulong, BanEntry> _bans = new();

    private string BansFile => Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "configs", "plugins", "Cs2PanelBridge", "bans.json"));
    private string MatchFilePath => Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "configs", "plugins", "Cs2PanelBridge", "match.json"));

    /// <summary>The match being played, or null when the server is open to everyone.</summary>
    private MatchFile? _match;
    private Dictionary<ulong, MatchPlayer> _matchPlayers = new();
    private bool _matchOver;
    private bool _countdown;

    public override void Load(bool hotReload)
    {
        LoadBans();
        LoadMatch();
        RegisterListener<Listeners.OnClientAuthorized>(OnClientAuthorized);
        RegisterListener<Listeners.OnMapStart>(_ => AddTimer(2.0f, HoldWarmup));
        RegisterEventHandler<EventPlayerConnectFull>(OnPlayerConnectFull);
        RegisterEventHandler<EventPlayerTeam>(OnPlayerTeam);
        RegisterEventHandler<EventCsWinPanelMatch>(OnMatchOver);
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
        // The server is open again: let warmup run out normally.
        if (hadMatch && _match == null) Server.ExecuteCommand("mp_warmup_pausetimer 0");
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
        var status = new MatchStatus(_match != null, _match?.MatchId ?? "", phase, MatchPlayersOnline().Count(), _matchPlayers.Count, scoreA, scoreB);
        command.ReplyToCommand(MatchMarker + JsonSerializer.Serialize(status, Json));
    }

    private void LoadMatch()
    {
        try
        {
            var file = File.Exists(MatchFilePath) ? JsonSerializer.Deserialize<MatchFile>(File.ReadAllText(MatchFilePath), Json) : null;
            var previous = _match?.MatchId;
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
        if (_match == null || player is not { IsValid: true, IsBot: false }) return HookResult.Continue;
        // The team menu comes up first; move the player once they're properly in.
        AddTimer(1.0f, () =>
        {
            if (player.IsValid) Place(player);
            CheckEveryoneIn();
        });
        return HookResult.Continue;
    }

    private HookResult OnPlayerTeam(EventPlayerTeam @event, GameEventInfo info)
    {
        if (_match != null) Server.NextFrame(CheckEveryoneIn);
        return HookResult.Continue;
    }

    private HookResult OnMatchOver(EventCsWinPanelMatch @event, GameEventInfo info)
    {
        if (_match != null) _matchOver = true;
        return HookResult.Continue;
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
        if ((CsTeam)player.TeamNum != want) player.ChangeTeam(want);
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
    [property: JsonPropertyName("scoreB")] int ScoreB);

public class MatchFile
{
    public int Version { get; set; }
    public bool Active { get; set; }
    public string MatchId { get; set; } = "";
    public List<MatchPlayer> Players { get; set; } = new();
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
