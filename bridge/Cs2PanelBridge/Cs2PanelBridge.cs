using System.Text.Json;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Entities;
using Microsoft.Extensions.Logging;

namespace Cs2PanelBridge;

/// <summary>
/// Companion plugin for cs2-panel.
///
/// It never talks to the network. The panel writes the ban list to
/// configs/plugins/Cs2PanelBridge/bans.json and runs `cs2panel_reload` over
/// RCON; the plugin keeps players on that list out. The panel reads player
/// SteamIDs with `cs2panel_players`, since CS2's own `status` doesn't show them.
/// </summary>
public class Cs2PanelBridge : BasePlugin
{
    public override string ModuleName => "CS2 Panel Bridge";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleAuthor => "cs2-panel";
    public override string ModuleDescription => "Enforces cs2-panel bans and reports players to the panel.";

    /// <summary>Marks the JSON line in RCON output so the panel can find it among other console text.</summary>
    private const string PlayersMarker = "CS2PANEL_PLAYERS ";

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private Dictionary<ulong, BanEntry> _bans = new();

    private string BansFile => Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "configs", "plugins", "Cs2PanelBridge", "bans.json"));

    public override void Load(bool hotReload)
    {
        LoadBans();
        RegisterListener<Listeners.OnClientAuthorized>(OnClientAuthorized);
        if (hotReload) Server.NextFrame(KickBannedPlayers);
    }

    private void OnClientAuthorized(int playerSlot, SteamID steamId)
    {
        var ban = ActiveBan(steamId.SteamId64);
        if (ban == null) return;
        // Kick on the next frame; the player isn't fully set up inside this callback.
        Server.NextFrame(() =>
        {
            var player = Utilities.GetPlayerFromSlot(playerSlot);
            if (player is { IsValid: true }) Kick(player, ban);
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
