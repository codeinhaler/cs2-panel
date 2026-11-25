using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Menu;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace Cs2PanelBridge;

/// <summary>
/// The in-game admin menu (`!panel` in chat). Who may use it, with which permissions, and the maps
/// it offers come from the panel (admins.json). Every action is kept for the panel, which asks for
/// them with `cs2panel_actions` and shows them in its Activity.
///
/// Permissions: map, restart, kick, cvar, rcon, and interrupt (may change the map, restart, kick or
/// change settings while a matchmaking match runs here; without it those are hidden during a match).
/// </summary>
public partial class Cs2PanelBridge
{
    private const string ActionsMarker = "CS2PANEL_ACTIONS ";
    private const string Tag = " \u0004[Panel]\u0001 ";
    private static readonly Regex MapNameRe = new("^[A-Za-z0-9_\\-/]{1,64}$");
    private static readonly Regex WorkshopIdRe = new("^[0-9]{1,20}$");
    private static readonly Regex CvarNameRe = new("^[A-Za-z0-9_]{1,64}$");

    private string AdminsFilePath => Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "configs", "plugins", "Cs2PanelBridge", "admins.json"));

    private Dictionary<ulong, AdminEntry> _admins = new();
    private List<MenuMap> _menuMaps = new();
    /// <summary>What people did since the panel last asked (kept to the last 200).</summary>
    private readonly List<AdminAction> _actions = new();

    private bool MatchRunning => _match != null && !_matchOver;

    private int LoadAdmins()
    {
        try
        {
            if (!File.Exists(AdminsFilePath))
            {
                _admins = new();
                _menuMaps = new();
                return 0;
            }
            var file = JsonSerializer.Deserialize<AdminsFile>(File.ReadAllText(AdminsFilePath), Json);
            var admins = new Dictionary<ulong, AdminEntry>();
            foreach (var a in file?.Admins ?? new())
            {
                if (ulong.TryParse(a.SteamId, out var id)) admins[id] = a;
            }
            _admins = admins;
            _menuMaps = (file?.Maps ?? new()).Where(m =>
                (m.Map != null && MapNameRe.IsMatch(m.Map)) || (m.Workshop != null && WorkshopIdRe.IsMatch(m.Workshop))).ToList();
            return admins.Count;
        }
        catch (Exception e)
        {
            // Keep the previous list.
            Logger.LogError(e, "cs2panel: could not read {File}", AdminsFilePath);
            return _admins.Count;
        }
    }

    [ConsoleCommand("cs2panel_admins_reload", "Reloads the cs2-panel in-game admins and map menu")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnAdminsReload(CCSPlayerController? caller, CommandInfo command)
    {
        var count = LoadAdmins();
        command.ReplyToCommand($"cs2panel: {count} in-game admins, {_menuMaps.Count} maps in the menu");
    }

    [ConsoleCommand("cs2panel_actions", "Hands what in-game admins did to the panel (and forgets it)")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnActions(CCSPlayerController? caller, CommandInfo command)
    {
        command.ReplyToCommand(ActionsMarker + JsonSerializer.Serialize(_actions, Json));
        _actions.Clear();
    }

    private AdminEntry? AdminOf(CCSPlayerController? player)
    {
        if (player is not { IsValid: true } || player.IsBot) return null;
        return _admins.TryGetValue(player.SteamID, out var a) && !a.IsExpired ? a : null;
    }

    private static bool Has(AdminEntry a, string perm) => a.Perms.Contains(perm);

    /// <summary>Allowed right now: during a match, map/restart/kick/cvar also need "interrupt".</summary>
    private bool MayNow(AdminEntry a, string perm) => Has(a, perm) && (!MatchRunning || perm == "rcon" || Has(a, "interrupt"));

    private void LogAction(CCSPlayerController player, string action, string? detail)
    {
        _actions.Add(new AdminAction(player.SteamID.ToString(), player.PlayerName, action, detail, MatchRunning));
        if (_actions.Count > 200) _actions.RemoveAt(0);
    }

    private static void Tell(CCSPlayerController player, string text) => player.PrintToChat(Tag + text);

    private static string Html(string s) => WebUtility.HtmlEncode(s);

    // ------------------------------------------------------------- !panel

    [ConsoleCommand("css_panel", "Opens the CS2 Panel admin menu")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_ONLY)]
    public void OnPanel(CCSPlayerController? player, CommandInfo command)
    {
        if (player is not { IsValid: true }) return;
        var admin = AdminOf(player);
        if (admin == null)
        {
            Tell(player, "You're not an admin on this server.");
            return;
        }
        var args = command.ArgString.Trim();
        var space = args.IndexOf(' ');
        var sub = (space < 0 ? args : args[..space]).ToLowerInvariant();
        var rest = space < 0 ? "" : args[(space + 1)..].Trim();
        switch (sub)
        {
            case "":
                OpenMain(player);
                break;
            case "map":
            case "maps":
                OpenMaps(player);
                break;
            case "kick":
                OpenKick(player);
                break;
            case "cvar":
                SetCvar(player, rest);
                break;
            case "rcon":
                RunCommand(player, rest);
                break;
            default:
                Tell(player, "Type !panel for the menu, or !panel cvar <name> <value>, !panel rcon <command>.");
                break;
        }
    }

    private void OpenMain(CCSPlayerController player)
    {
        var admin = AdminOf(player);
        if (admin == null) return;
        var menu = new CenterHtmlMenu("CS2 Panel", this);
        var any = false;
        if (MayNow(admin, "map")) { menu.AddMenuOption("Change map", (p, _) => OpenMaps(p)); any = true; }
        if (MayNow(admin, "restart")) { menu.AddMenuOption("Restart the game", (p, _) => ConfirmRestart(p)); any = true; }
        if (MayNow(admin, "kick")) { menu.AddMenuOption("Kick a player", (p, _) => OpenKick(p)); any = true; }
        if (MayNow(admin, "cvar")) Tell(player, "Change a setting: !panel cvar <name> <value>");
        if (Has(admin, "rcon")) Tell(player, "Run a command: !panel rcon <command>");
        if (!any)
        {
            Tell(player, MatchRunning && !Has(admin, "interrupt")
                ? "A match is running on this server. Your role can't change it."
                : "Your role has nothing to do in the menu.");
            return;
        }
        MenuManager.OpenCenterHtmlMenu(this, player, menu);
        Tell(player, "Pick with !1 to !9 in chat.");
    }

    /// <summary>Asks before doing it, with a warning when a match is running.</summary>
    private void Confirm(CCSPlayerController player, string question, Action<CCSPlayerController> yes)
    {
        var title = MatchRunning ? $"<font color='#ff5555'>A match is running here.</font><br>{question}" : question;
        var menu = new CenterHtmlMenu(title, this);
        menu.AddMenuOption("Yes", (p, _) =>
        {
            MenuManager.CloseActiveMenu(p);
            yes(p);
        });
        menu.AddMenuOption("No", (p, _) => MenuManager.CloseActiveMenu(p));
        MenuManager.OpenCenterHtmlMenu(this, player, menu);
    }

    // ------------------------------------------------------------- maps

    private void OpenMaps(CCSPlayerController player)
    {
        var admin = AdminOf(player);
        if (admin == null || !MayNow(admin, "map"))
        {
            Tell(player, MatchRunning ? "A match is running on this server. Your role can't change the map." : "Your role can't change the map.");
            return;
        }
        var builtIn = _menuMaps.Where(m => m.Map != null).ToList();
        var workshop = _menuMaps.Where(m => m.Workshop != null).ToList();
        if (builtIn.Count == 0 && workshop.Count == 0)
        {
            Tell(player, "The panel hasn't sent a map list yet.");
            return;
        }
        if (builtIn.Count > 0 && workshop.Count > 0)
        {
            var menu = new CenterHtmlMenu("Change map", this);
            menu.AddMenuOption($"Built-in maps ({builtIn.Count})", (p, _) => OpenMapList(p, "Built-in maps", builtIn));
            menu.AddMenuOption($"Workshop maps ({workshop.Count})", (p, _) => OpenMapList(p, "Workshop maps", workshop));
            MenuManager.OpenCenterHtmlMenu(this, player, menu);
        }
        else OpenMapList(player, "Change map", builtIn.Count > 0 ? builtIn : workshop);
    }

    private void OpenMapList(CCSPlayerController player, string title, List<MenuMap> maps)
    {
        var menu = new CenterHtmlMenu(title, this);
        foreach (var m in maps)
        {
            var current = m.Map != null && m.Map.Equals(Server.MapName, StringComparison.OrdinalIgnoreCase);
            var label = Html(m.Title) + (current ? " <font color='#999999'>(now)</font>" : "");
            menu.AddMenuOption(label, (p, _) => Confirm(p, $"Change to {Html(m.Title)}?", q => ChangeMap(q, m)));
        }
        MenuManager.OpenCenterHtmlMenu(this, player, menu);
    }

    private void ChangeMap(CCSPlayerController player, MenuMap m)
    {
        var admin = AdminOf(player);
        if (admin == null || !MayNow(admin, "map")) return;
        LogAction(player, "map", m.Workshop != null ? $"{m.Title} (Workshop {m.Workshop})" : m.Title == m.Map ? m.Map : $"{m.Title} ({m.Map})");
        Server.PrintToChatAll($"{Tag}{player.PlayerName} is changing the map to {m.Title}.");
        // A moment for people to read it.
        AddTimer(3.0f, () =>
        {
            if (m.Workshop != null) Server.ExecuteCommand($"host_workshop_map {m.Workshop}");
            else Server.ExecuteCommand($"changelevel {m.Map}");
        });
    }

    // ------------------------------------------------------------- restart

    private void ConfirmRestart(CCSPlayerController player) => Confirm(player, "Restart the game? Scores go back to 0.", DoRestart);

    private void DoRestart(CCSPlayerController player)
    {
        var admin = AdminOf(player);
        if (admin == null || !MayNow(admin, "restart")) return;
        LogAction(player, "restart", null);
        Server.PrintToChatAll($"{Tag}{player.PlayerName} restarted the game.");
        Server.ExecuteCommand("mp_restartgame 1");
    }

    // ------------------------------------------------------------- kick

    private void OpenKick(CCSPlayerController player)
    {
        var admin = AdminOf(player);
        if (admin == null || !MayNow(admin, "kick"))
        {
            Tell(player, MatchRunning ? "A match is running on this server. Your role can't kick here now." : "Your role can't kick players.");
            return;
        }
        var others = Utilities.GetPlayers()
            .Where(p => p is { IsValid: true, IsBot: false, IsHLTV: false } && p.UserId.HasValue && p.SteamID != player.SteamID)
            .ToList();
        if (others.Count == 0)
        {
            Tell(player, "Nobody else is on the server.");
            return;
        }
        var menu = new CenterHtmlMenu("Kick a player", this);
        foreach (var target in others)
        {
            var userId = target.UserId!.Value;
            var steamId = target.SteamID;
            var name = target.PlayerName;
            menu.AddMenuOption(Html(name), (p, _) => Confirm(p, $"Kick {Html(name)}?", q => KickPlayer(q, userId, steamId, name)));
        }
        MenuManager.OpenCenterHtmlMenu(this, player, menu);
    }

    private void KickPlayer(CCSPlayerController player, int userId, ulong steamId, string name)
    {
        var admin = AdminOf(player);
        if (admin == null || !MayNow(admin, "kick")) return;
        var target = Utilities.GetPlayerFromUserid(userId);
        if (target is not { IsValid: true } || target.SteamID != steamId)
        {
            Tell(player, $"{name} has already left.");
            return;
        }
        LogAction(player, "kick", $"{name} ({steamId})");
        Server.ExecuteCommand($"kickid {userId} \"Kicked by an admin\"");
        Server.PrintToChatAll($"{Tag}{player.PlayerName} kicked {Clean(name)}.");
    }

    // ------------------------------------------------------------- settings and commands

    private void SetCvar(CCSPlayerController player, string args)
    {
        var admin = AdminOf(player);
        if (admin == null || !Has(admin, "cvar"))
        {
            Tell(player, "Your role can't change server settings.");
            return;
        }
        if (!MayNow(admin, "cvar"))
        {
            Tell(player, "A match is running on this server. Your role can't change settings now.");
            return;
        }
        var space = args.IndexOf(' ');
        var name = space < 0 ? args : args[..space];
        var value = space < 0 ? "" : Clean(args[(space + 1)..].Trim().Trim('"'));
        if (!CvarNameRe.IsMatch(name) || value.Length == 0)
        {
            Tell(player, "Use: !panel cvar <name> <value>, for example !panel cvar mp_roundtime 3");
            return;
        }
        LogAction(player, "cvar", $"{name} {value}");
        Server.ExecuteCommand($"{name} \"{value}\"");
        Tell(player, $"Set {name} to {value}.");
    }

    private void RunCommand(CCSPlayerController player, string args)
    {
        var admin = AdminOf(player);
        if (admin == null || !Has(admin, "rcon"))
        {
            Tell(player, "Your role can't run console commands.");
            return;
        }
        var cmd = args.Replace("\n", " ").Replace("\r", " ").Trim();
        if (cmd.Length == 0)
        {
            Tell(player, "Use: !panel rcon <command>");
            return;
        }
        LogAction(player, "rcon", cmd.Length > 200 ? cmd[..200] : cmd);
        Server.ExecuteCommand(cmd);
        Tell(player, $"Ran: {cmd}");
    }
}

public class AdminsFile
{
    public int Version { get; set; }
    public List<AdminEntry> Admins { get; set; } = new();
    public List<MenuMap> Maps { get; set; } = new();
}

public class AdminEntry
{
    public string SteamId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Role { get; set; } = "";
    public List<string> Perms { get; set; } = new();
    public DateTimeOffset? ExpiresAt { get; set; }

    [JsonIgnore]
    public bool IsExpired => ExpiresAt is { } e && e <= DateTimeOffset.UtcNow;
}

public class MenuMap
{
    /// <summary>An installed map, e.g. de_dust2.</summary>
    public string? Map { get; set; }
    /// <summary>A Workshop map's ID.</summary>
    public string? Workshop { get; set; }
    public string Title { get; set; } = "";
}

public record AdminAction(
    [property: JsonPropertyName("steamId")] string SteamId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("action")] string Action,
    [property: JsonPropertyName("detail")] string? Detail,
    [property: JsonPropertyName("match")] bool Match);
