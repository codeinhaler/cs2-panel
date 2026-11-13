import path from "node:path";
import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { HttpError, badRequest, forbidden, notFound } from "./errors.js";
import { AuditLog } from "./audit.js";
import { SecretBox } from "./crypto.js";
import { can, permissionsFor, type Permission } from "./auth/permissions.js";
import { PrefsSchema, UserStore, type User } from "./auth/users.js";
import { SESSION_COOKIE, MAX_AGE_MS, SessionStore } from "./auth/sessions.js";
import { buildLoginUrl, verifyCallback } from "./auth/steam-openid.js";
import { fetchProfile, resolveSteamId } from "./auth/steam-profile.js";
import type { Host } from "./host/host.js";
import { rconExec as defaultRcon, withLocalFallback, type RconExec } from "./game/rcon.js";
import { GameUpdater } from "./game/updater.js";
import { InstanceFiles } from "./servers/instance-files.js";
import { PresetStore } from "./servers/presets.js";
import { ServerStore } from "./servers/store.js";
import { ConfigService } from "./servers/configs.js";
import { OperationGate, ServerService, type Actor } from "./servers/service.js";
import { PluginSources } from "./plugins/sources.js";
import { PluginService } from "./plugins/service.js";
import { CATALOG, pluginPages } from "./plugins/catalog.js";
import { PlayerService } from "./players/service.js";
import { BanService, BRIDGE_ID } from "./players/bans.js";
import { MapMenuService } from "./plugins/map-menu.js";
import { ExecConfigService, withBlock } from "./servers/exec-configs.js";
import { MapCycleService, isCasual } from "./servers/map-cycle.js";
import { BridgeAutoUpdate } from "./plugins/bridge-autoupdate.js";
import { CpuService } from "./cpu/service.js";
import { DiscordBot } from "./discord-bot/service.js";
import { sysReader, type SysReader } from "./cpu/topology.js";
import { SharedConfigService, withoutSharedBlock } from "./servers/shared-config.js";
import { WorkshopLookup, workshopBlocks } from "./game/workshop.js";
import { parseMapSpec } from "./servers/map-spec.js";
import { CommandSchema, commandPermission, gameModeLine, rconFor } from "./servers/commands.js";
import { Settings } from "./settings.js";
import { Automation } from "./automation/index.js";
import { humanCounter } from "./automation/humans.js";
import { UpdateWatcher, type UpdatePolicy } from "./automation/updates.js";
import { RestartScheduler } from "./automation/restarts.js";
import { Monitor, MACHINE, RANGES, type Range } from "./monitor/monitor.js";
import { queryInfo, type A2sInfo } from "./game/a2s.js";
import { DiscordNotifier, EVENT_GROUPS, type EventGroup } from "./notify/discord.js";
import { BackupService } from "./backups/service.js";
import { MmPlayerStore } from "./matchmaking/players.js";
import { MODES, Matchmaking } from "./matchmaking/service.js";
import { PublicSite, buildPublicApp } from "./matchmaking/public-app.js";
import { LAYOUTS, SiteImages, THEMES, type ImageKind } from "./matchmaking/look.js";
import { CertStore } from "./tls/acme.js";
import { TlsService } from "./tls/service.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  host: Host;
  rcon?: RconExec;
  fetchFn?: typeof fetch;
  logLevel?: string;
  /** Seconds-long waits are skipped in tests. */
  pluginCheckDelayMs?: number;
  /** Replaces the Steam server query the monitor uses (tests). */
  a2sQuery?: (port: number) => Promise<A2sInfo | null>;
  /** Replaces the waits before scheduled restarts (tests). */
  automationSleep?: (ms: number) => Promise<void>;
  /** A fake /sys and /proc for the CPU topology (tests). */
  cpuSys?: SysReader;
  /** Replaces Let's Encrypt and the firewall (tests). */
  tls?: Partial<Pick<import("./tls/service.js").TlsDeps, "issue" | "panRequest" | "probe" | "sleep" | "now">>;
  /** Replaces the clock and waits matchmaking uses (tests). */
  matchmakingClock?: { now: () => number; sleep: (ms: number) => Promise<void>; random?: (n: number) => number };
}

export interface App {
  fastify: FastifyInstance;
  services: {
    users: UserStore;
    sessions: SessionStore;
    audit: AuditLog;
    servers: ServerService;
    configs: ConfigService;
    updater: GameUpdater;
    presets: PresetStore;
    plugins: PluginService;
    players: PlayerService;
    bans: BanService;
    automation: Automation;
    monitor: Monitor;
    discord: DiscordNotifier;
    backups: BackupService;
    matchmaking: Matchmaking;
    publicSite: PublicSite;
    tls: TlsService;
    discordBot: DiscordBot;
  };
}

const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function buildApp(deps: AppDeps): Promise<App> {
  const { config, db, host } = deps;
  const rcon = deps.rcon ?? withLocalFallback(defaultRcon);
  const fetchFn = deps.fetchFn ?? fetch;

  const box = new SecretBox(config.secretKey);
  const users = new UserStore(db);
  const sessions = new SessionStore(db);
  const audit = new AuditLog(db);
  const presets = new PresetStore(db);
  const serverStore = new ServerStore(db, box);
  const files = new InstanceFiles(config.cs2Root, config.instanceEnvDir, (slug) => host.isMounted(slug));
  const configs = new ConfigService(db, files);
  const gate = new OperationGate();
  const settings = new Settings(db);
  const servers = new ServerService(serverStore, presets, files, configs, host, audit, gate);
  // CPU Management: picks CPUs for new servers, checks lists, and writes the CPUs a server starts on.
  // In development, CS2PANEL_DEV_SYS can point at a fake /sys + /proc tree to try other machines.
  const cpuSys = deps.cpuSys ?? (config.dev && process.env.CS2PANEL_DEV_SYS ? sysReader(process.env.CS2PANEL_DEV_SYS) : undefined);
  const cpu = new CpuService({ settings, servers, host, audit, ...(cpuSys ? { sys: cpuSys } : {}) });
  servers.cpuHooks = cpu;
  servers.beforeStart.push((s) => cpu.noteStart(s));
  const updater = new GameUpdater(host, files, serverStore, audit, gate, rcon);
  const workshop = new WorkshopLookup(fetchFn);
  /** Refuses Workshop maps/collections Steam says are removed, missing, private or not CS2. */
  const checkWorkshop = async (map: unknown): Promise<void> => {
    if (typeof map !== "string") return;
    const spec = parseMapSpec(map);
    if (!spec || spec.kind === "stock") return;
    const info = await workshop.lookup(spec.id, spec.kind === "workshop" ? "map" : "collection");
    if (workshopBlocks(info.status)) throw badRequest(info.message);
  };
  const pluginSources = new PluginSources(path.join(config.dataDir, "plugin-cache"), fetchFn, Date.now, config.bridgeDir);
  const plugins = new PluginService(db, pluginSources, servers, files, audit, gate, rcon, path.join(config.dataDir, "tmp"), config.mysql);
  updater.afterStart = (started) => plugins.healthLines(started);
  const players = new PlayerService(db, servers, plugins, files, host, rcon, audit);
  const execConfigs = new ExecConfigService(db, configs, audit);
  const shared = new SharedConfigService(settings, servers, configs, files, host, rcon, audit);
  servers.hostnameFor = (s) => shared.hostnameFor(s);
  // Every server gets the current shared file before it starts, and right after it's created.
  servers.beforeStart.push((s) => shared.applyTo(s, null));
  servers.afterCreate.push((s, _preset, actorId) => shared.applyTo(s, actorId));
  // A new server from a preset runs the preset's configs; changing game mode moves the exec block.
  servers.afterCreate.push(async (s, preset, actorId) => {
    if (preset.execConfigs.length) await execConfigs.set(s, preset.execConfigs, actorId).catch(() => undefined);
  });
  servers.afterUpdate.push(async (s, info, actorId) => {
    if (info.appliedPreset) await execConfigs.set(s, info.appliedPreset.execConfigs, actorId).catch(() => undefined);
    else if (info.modeChanged) await execConfigs.apply(s, actorId);
  });
  const humans = humanCounter(players);
  const discord = new DiscordNotifier(db, settings, box, fetchFn);
  audit.listeners.push(discord.onEvent);
  const monitor = new Monitor({
    db,
    host,
    servers: () => servers.listRecords(),
    query: deps.a2sQuery ?? ((port) => queryInfo(port)),
    counts: (id) => players.recentCounts(id),
    audit,
  });
  const backups = new BackupService(
    db,
    settings,
    host,
    servers,
    plugins,
    execConfigs,
    gate,
    updater,
    audit,
    path.join(config.cs2Root, "backups"),
    path.join(config.dataDir, "backups"),
  );
  const automation = new Automation(
    new UpdateWatcher(settings, files, host, updater, gate, serverStore, humans, audit),
    new RestartScheduler(db, settings, servers, host, gate, updater, humans, rcon, audit, deps.automationSleep),
    monitor,
    backups,
  );
  const mapMenus = new MapMenuService(configs, plugins, files.baseDir);
  const bans = new BanService(db, servers, plugins, files, host, rcon, audit);
  servers.liveCounts = (id) => players.recentCounts(id);
  // Every server with the bridge gets the current ban list before it starts and right after the bridge is installed.
  servers.beforeStart.push((s) => bans.writeFor(s));
  plugins.afterApply.push((s, ids) => (ids.includes(BRIDGE_ID) ? bans.writeFor(s) : Promise.resolve()));
  // Casual servers' map cycle: the bridge's file before each start, after the bridge is installed and when the mode changes.
  const mapCycles = new MapCycleService(db, files, host, rcon, audit, (id) => plugins.installedIds(id).includes(BRIDGE_ID), checkWorkshop);
  servers.beforeStart.push((s) => mapCycles.apply(s).catch(() => undefined));
  plugins.afterApply.push((s, ids) => (ids.includes(BRIDGE_ID) ? mapCycles.apply(s).catch(() => undefined) : Promise.resolve()));
  servers.afterUpdate.push(async (s, info) => {
    if (info.appliedPreset || info.modeChanged) await mapCycles.apply(s).catch(() => undefined);
  });
  if (deps.pluginCheckDelayMs !== undefined) updater.pluginCheckDelayMs = deps.pluginCheckDelayMs;

  const mmPlayers = new MmPlayerStore(db);
  const isBanned = (steamId: string) => !!bans.activeBan(steamId);
  const matchmaking = new Matchmaking({
    db,
    settings,
    box,
    players: mmPlayers,
    servers,
    hasBridge: (id) => bans.hasBridge(id),
    pluginBusy: (id) => plugins.isBusy(id),
    files,
    host,
    rcon,
    humans: (id) => players.recentCounts(id)?.humans ?? null,
    isBanned,
    audit,
    fetchFn,
    images: new SiteImages(path.join(config.dataDir, "matchmaking")),
    workshop: (id) => workshop.lookup(id, "map"),
    ...(deps.matchmakingClock ?? {}),
  });
  // After a panel update, each server gets the bridge from this release once it's empty and not in a match.
  automation.bridge = new BridgeAutoUpdate(
    plugins,
    () => servers.listRecords(),
    humans,
    (id) => matchmaking.inUse(id),
  );
  const tls = new TlsService({
    settings,
    box,
    audit,
    store: new CertStore(path.join(config.dataDir, "tls")),
    fetchFn,
    ...(deps.tls ?? {}),
  });
  await tls.load();
  // The Discord bot: optional voice automation for matches. Never holds up matchmaking.
  const discordBot = new DiscordBot({
    db,
    settings,
    box,
    audit,
    fetchFn,
    configured: () => matchmaking.config().discord,
    isMatchActive: (id) => matchmaking.isMatchActive(id),
  });
  matchmaking.voice = discordBot;
  const publicSite = new PublicSite(
    (https) =>
      buildPublicApp({
        https,
        discordBot,
        mm: matchmaking,
        players: mmPlayers,
        isBanned,
        fetchFn,
        webDir: config.webDir,
        dev: config.dev,
        logLevel: deps.logLevel ?? (config.dev ? "info" : "warn"),
      }),
    matchmaking,
    config.host,
    config.port,
    () => tls.active(),
    () => tls.https().domain,
  );
  matchmaking.onSettingsChanged = () => publicSite.sync();
  tls.onCertificate = (files) => publicSite.updateCertificate(files);
  mmPlayers.purgeExpired();

  users.ensureOwner(config.ownerSteamId);
  presets.seed();
  sessions.purgeExpired();

  const app = Fastify({ logger: { level: deps.logLevel ?? (config.dev ? "info" : "warn") }, trustProxy: false, bodyLimit: 1024 * 1024 });
  await app.register(cookie);
  await app.register(websocket);

  app.decorateRequest("user", null);

  // ------------------------------------------------------------- auth plumbing

  app.addHook("onRequest", async (req) => {
    const userId = sessions.resolve(req.cookies[SESSION_COOKIE]);
    const user = userId ? users.byId(userId) : null;
    req.user = user && !user.disabled ? user : null;
  });

  // Cross-site request protection for state-changing calls: the browser must
  // say it's coming from this same host. SameSite cookies cover most of this;
  // the Origin check is a second layer.
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw forbidden("Cross-site request blocked.");
  });

  const requireUser = (req: FastifyRequest): User => {
    if (!req.user) throw new HttpError(401, "Please sign in.");
    return req.user;
  };
  const requirePerm = (req: FastifyRequest, perm: Permission): User => {
    const user = requireUser(req);
    if (!can(user.role, perm)) throw forbidden();
    return user;
  };
  const actorOf = (user: User): Actor => ({ id: user.id, can: (p) => can(user.role, p) });

  const baseUrl = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`;

  const setSession = (reply: FastifyReply, userId: number) => {
    reply.setCookie(SESSION_COOKIE, sessions.create(userId), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: Math.floor(MAX_AGE_MS / 1000),
    });
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const field = first?.path.join(".");
      return reply.status(400).send({ error: first ? `${field ? field + ": " : ""}${first.message}` : "Invalid input." });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: "Something went wrong on the server. Check the panel's log." });
  });

  // ------------------------------------------------------------- auth routes

  app.get("/api/auth/steam", async (req, reply) => reply.redirect(buildLoginUrl(baseUrl(req))));

  app.get("/api/auth/steam/callback", async (req, reply) => {
    let steamId: string;
    try {
      steamId = await verifyCallback(req.query as Record<string, string>, baseUrl(req), fetchFn);
    } catch (e) {
      return reply.redirect(`/login?error=${encodeURIComponent((e as Error).message)}`);
    }
    const user = users.bySteamId(steamId);
    if (!user || user.disabled) {
      audit.record(null, "auth.denied", null, { steamId });
      return reply.redirect(`/login?error=${encodeURIComponent("This Steam account doesn't have access to the panel. Ask the Owner to add you.")}`);
    }
    setSession(reply, user.id);
    users.touchLogin(user.id);
    void fetchProfile(steamId, fetchFn).then((p) => users.updateProfile(user.id, p));
    audit.record(user.id, "auth.login");
    return reply.redirect("/");
  });

  if (config.dev) {
    // Development only: sign in as any existing user without Steam.
    app.get("/api/auth/dev", async (req, reply) => {
      const { steamId } = z.object({ steamId: z.string().optional() }).parse(req.query);
      const user = users.bySteamId(steamId ?? config.ownerSteamId);
      if (!user) throw notFound("No such user.");
      setSession(reply, user.id);
      return reply.redirect("/");
    });
  }

  app.post("/api/auth/logout", async (req, reply) => {
    sessions.destroy(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const user = requireUser(req);
    return { user, permissions: permissionsFor(user.role), dev: config.dev, version: config.version ?? "dev" };
  });

  app.put("/api/me/prefs", async (req) => {
    const user = requireUser(req);
    const prefs = PrefsSchema.parse(req.body ?? {});
    users.setPrefs(user.id, prefs);
    return { prefs };
  });

  // ------------------------------------------------------------- users

  app.get("/api/users", async (req) => {
    requirePerm(req, "users.manage");
    return { users: users.list() };
  });

  app.post("/api/users", async (req) => {
    const me = requirePerm(req, "users.manage");
    const body = z.object({ steam: z.string().min(1), role: z.enum(["admin", "moderator"]) }).parse(req.body);
    let steamId: string;
    try {
      steamId = await resolveSteamId(body.steam, fetchFn);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (users.bySteamId(steamId)) throw badRequest("That Steam account is already on the team.");
    const profile = await fetchProfile(steamId, fetchFn);
    const user = users.create(steamId, body.role, me.id, profile);
    audit.record(me.id, "user.add", null, { steamId, role: body.role, name: profile.name ?? null });
    return { user };
  });

  app.patch("/api/users/:id", async (req) => {
    const me = requirePerm(req, "users.manage");
    const { id } = idParam.parse(req.params);
    const body = z.object({ role: z.enum(["admin", "moderator"]).optional(), disabled: z.boolean().optional() }).parse(req.body);
    const target = users.byId(id);
    if (!target) throw notFound("User not found.");
    if (target.role === "owner") throw badRequest("The Owner account can't be changed here.");
    users.update(id, body);
    if (body.disabled) sessions.destroyAllFor(id);
    audit.record(me.id, "user.update", null, { steamId: target.steamId, name: target.displayName, ...body });
    return { user: users.byId(id) };
  });

  app.delete("/api/users/:id", async (req) => {
    const me = requirePerm(req, "users.manage");
    const { id } = idParam.parse(req.params);
    const target = users.byId(id);
    if (!target) throw notFound("User not found.");
    if (target.role === "owner") throw badRequest("The Owner account can't be removed.");
    users.remove(id);
    audit.record(me.id, "user.remove", null, { steamId: target.steamId, name: target.displayName });
    return { ok: true };
  });

  // ------------------------------------------------------------- audit

  app.get("/api/audit", async (req) => {
    requirePerm(req, "view");
    const q = z
      .object({
        limit: z.coerce.number().int().optional(),
        before: z.coerce.number().int().optional(),
        serverId: z.coerce.number().int().optional(),
      })
      .parse(req.query);
    return { entries: audit.list(q) };
  });

  // ------------------------------------------------------------- host & presets

  app.get("/api/host", async (req) => {
    requirePerm(req, "view");
    return {
      cpuCount: host.cpuCount(),
      suggestedCpu: servers.suggestCpu(),
      usedPorts: servers.usedPorts(),
      cs2: { installed: await files.baseInstalled(), ...(await files.baseVersion()) },
      busy: gate.busy,
      update: await (async () => {
        const a = await automation.updates.status();
        return { available: a.updateAvailable, latestBuild: a.latestBuild, policy: a.settings.policy, deadline: a.deadline };
      })(),
    };
  });

  /** What Steam says about a Workshop map or collection, for the map picker. */
  app.get("/api/workshop/:id", async (req) => {
    requirePerm(req, "view");
    const { id } = z.object({ id: z.string().regex(/^\d{1,20}$/) }).parse(req.params);
    const { kind } = z.object({ kind: z.enum(["map", "collection"]).default("map") }).parse(req.query);
    return workshop.lookup(id, kind);
  });

  /** Maps in the CS2 install, for map pickers. */
  app.get("/api/maps", async (req) => {
    requirePerm(req, "view");
    return { maps: await mapMenus.installedMaps() };
  });

  app.get("/api/presets", async (req) => {
    requirePerm(req, "view");
    return { presets: presets.list() };
  });

  app.post("/api/presets", async (req) => {
    const user = requirePerm(req, "preset.manage");
    await checkWorkshop((req.body as { defaultMap?: unknown } | null)?.defaultMap);
    const preset = presets.create(req.body, user.id);
    audit.record(user.id, "preset.create", null, { name: preset.name });
    return { preset };
  });

  app.put("/api/presets/:id", async (req) => {
    const user = requirePerm(req, "preset.manage");
    const { id } = idParam.parse(req.params);
    await checkWorkshop((req.body as { defaultMap?: unknown } | null)?.defaultMap);
    const preset = presets.update(id, req.body);
    audit.record(user.id, "preset.update", null, { name: preset.name });
    return { preset };
  });

  app.delete("/api/presets/:id", async (req) => {
    const user = requirePerm(req, "preset.manage");
    const { id } = idParam.parse(req.params);
    const name = presets.byId(id)?.name;
    const r = presets.delete(id);
    audit.record(user.id, "preset.delete", null, { name, serversUsing: r.serversUsing });
    return r;
  });

  /** Makes a custom preset from a server: its game mode, map, player count, edited cfg files and configs to run. */
  app.post("/api/servers/:id/save-preset", async (req) => {
    const user = requirePerm(req, "preset.manage");
    const { id } = idParam.parse(req.params);
    const body = z.object({ name: z.string(), description: z.string().default("") }).parse(req.body);
    const s = servers.require(id);
    const configFiles: Record<string, string> = {};
    for (const f of await configs.list(s)) {
      if (!f.path.startsWith("cfg/") || f.source === "stock" || f.readOnly || !f.path.endsWith(".cfg")) continue;
      const cur = await configs.readCurrent(s, f.path);
      if (!cur) continue;
      // The panel's exec block is saved as the preset's configs to run instead.
      const content = withoutSharedBlock(withBlock(cur.content, []));
      if (content.trim()) configFiles[f.path.slice("cfg/".length)] = content;
    }
    const preset = presets.create(
      {
        name: body.name,
        description: body.description,
        gameType: s.gameType,
        gameMode: s.gameMode,
        defaultMap: s.map,
        maxPlayers: s.maxPlayers,
        configFiles,
        execConfigs: execConfigs.get(id),
      },
      user.id,
    );
    audit.record(user.id, "preset.create", id, { name: preset.name, fromServer: s.name });
    return { preset };
  });

  app.put("/api/servers/:id/exec-configs", async (req) => {
    const user = requirePerm(req, "config.edit");
    const { id } = idParam.parse(req.params);
    const { configs: list } = z.object({ configs: z.array(z.string().max(100)).max(20) }).parse(req.body);
    return { execConfigs: await execConfigs.set(servers.require(id), list, user.id) };
  });

  app.get("/api/servers/:id/map-cycle", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    const s = servers.require(id);
    return { mapCycle: mapCycles.get(id), casual: isCasual(s), bridge: plugins.installedIds(id).includes(BRIDGE_ID), next: await mapCycles.next(s) };
  });

  app.put("/api/servers/:id/map-cycle", async (req) => {
    const user = requirePerm(req, "config.edit");
    const { id } = idParam.parse(req.params);
    return { mapCycle: await mapCycles.set(servers.require(id), req.body, user.id) };
  });

  // ------------------------------------------------------------- Discord bot

  /** The address players come back to after Discord sign-in (to register in the Discord Developer Portal). */
  const discordRedirect = () => {
    const h = tls.https();
    return h.enabled && h.domain ? `https://${h.domain}/api/discord/callback` : null;
  };

  app.get("/api/discord-bot", async (req) => {
    requirePerm(req, "view");
    return {
      settings: discordBot.view(),
      status: discordBot.getStatus(),
      guildId: discordBot.guildId(),
      inviteUrl: discordBot.inviteUrl(),
      redirectUri: discordRedirect(),
      ...discordBot.monitoring(),
    };
  });

  app.put("/api/discord-bot", async (req) => {
    const user = requirePerm(req, "server.manage");
    return { settings: await discordBot.save(req.body, user.id) };
  });

  app.post("/api/discord-bot/check", async (req) => {
    requirePerm(req, "server.manage");
    return discordBot.check();
  });

  // Moves only the admin who presses it (their own linked Discord), to a test channel and back.
  app.post("/api/discord-bot/test-move", async (req) => {
    const user = requirePerm(req, "server.manage");
    return discordBot.testMove(user.steamId);
  });

  app.post("/api/discord-bot/reconcile", async (req) => {
    requirePerm(req, "server.manage");
    await discordBot.reconcile();
    return { ok: true };
  });

  // ------------------------------------------------------------- CPU Management

  app.get("/api/cpu", async (req) => {
    requirePerm(req, "view");
    const { refresh } = z.object({ refresh: z.string().optional() }).parse(req.query);
    return cpu.overview(refresh === "1");
  });

  app.get("/api/cpu/usage", async (req) => {
    requirePerm(req, "view");
    return cpu.usage();
  });

  app.get("/api/cpu/suggest", async (req) => {
    requirePerm(req, "view");
    return cpu.suggest();
  });

  app.put("/api/cpu/policy", async (req) => {
    const user = requirePerm(req, "server.manage");
    return { policy: await cpu.setPolicy(req.body, user.id) };
  });

  // The one place a server's CPUs change: CPU Management, its overview and the server's Settings tab all use it.
  app.put("/api/servers/:id/cpu", async (req) => {
    const user = requirePerm(req, "server.manage");
    const { id } = idParam.parse(req.params);
    return cpu.assign(id, req.body, user.id);
  });

  app.get("/api/ports/check", async (req) => {
    requirePerm(req, "view");
    const q = z.object({ port: z.coerce.number().int(), serverId: z.coerce.number().int().optional() }).parse(req.query);
    return { problem: await servers.checkPort(q.port, q.serverId) };
  });

  // ------------------------------------------------------------- servers

  app.get("/api/servers", async (req) => {
    requirePerm(req, "view");
    return { servers: await servers.list() };
  });

  app.get("/api/servers/:id", async (req) => {
    const user = requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    const server = await servers.get(id);
    // Moderators don't need the join password.
    if (!can(user.role, "server.manage")) server.password = server.password ? "••••" : "";
    const installed = plugins.installedIds(id);
    return {
      server,
      pluginPages: pluginPages(installed),
      bridge: installed.includes(BRIDGE_ID),
      execConfigs: execConfigs.get(id),
      mapCycle: mapCycles.get(id),
      // The token itself only for those who may change it; others see the last 4 characters (gsltHint).
      ...(can(user.role, "server.manage") ? { gslt: servers.require(id).gsltToken ?? "" } : {}),
    };
  });

  app.post("/api/servers", async (req) => {
    const user = requirePerm(req, "server.manage");
    await checkWorkshop((req.body as { map?: unknown } | null)?.map);
    return { server: await servers.create(req.body, actorOf(user)) };
  });

  app.patch("/api/servers/:id", async (req) => {
    const user = requirePerm(req, "server.manage");
    const { id } = idParam.parse(req.params);
    await checkWorkshop((req.body as { map?: unknown } | null)?.map);
    return servers.update(id, req.body, actorOf(user));
  });

  app.post("/api/servers/:id/duplicate", async (req) => {
    const user = requirePerm(req, "server.manage");
    const { id } = idParam.parse(req.params);
    const server = await servers.duplicate(id, req.body, actorOf(user));
    plugins.copyInstalls(id, server.id);
    execConfigs.copy(id, server.id);
    mapCycles.copy(id, server.id);
    return { server };
  });

  app.delete("/api/servers/:id", async (req) => {
    const user = requirePerm(req, "server.delete");
    const { id } = idParam.parse(req.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
    await servers.delete(id, confirm, actorOf(user));
    return { ok: true };
  });

  for (const action of ["start", "stop", "restart", "kill"] as const) {
    app.post(`/api/servers/:id/${action}`, async (req) => {
      const user = requirePerm(req, "server.control");
      const { id } = idParam.parse(req.params);
      return { server: await servers.control(id, action, actorOf(user)) };
    });
  }

  app.post("/api/servers/:id/rcon", async (req) => {
    const user = requirePerm(req, "rcon");
    const { id } = idParam.parse(req.params);
    const { command } = z.object({ command: z.string().trim().min(1).max(500) }).parse(req.body);
    const s = servers.require(id);
    audit.record(user.id, "server.rcon", id, { command });
    try {
      return { output: await rcon({ port: s.port, password: s.rconPassword }, command) };
    } catch (e) {
      const msg = (e as Error).message;
      const status = await host.serviceStatus(s.slug);
      if (/refused/i.test(msg) && status.state === "active") {
        throw badRequest(
          "The server is running but isn't accepting RCON connections. Restart it once from the panel so it picks up the current launch settings; if that doesn't help, check the Console for errors.",
        );
      }
      throw badRequest(msg);
    }
  });

  // Everyday commands as buttons (Commands tab).
  app.post("/api/servers/:id/commands", async (req) => {
    const user = requireUser(req);
    const { id } = idParam.parse(req.params);
    const cmd = CommandSchema.parse(req.body);
    if (!can(user.role, commandPermission(cmd))) throw forbidden("Your role can't do that.");
    const s = servers.require(id);
    if ((await host.serviceStatus(s.slug)).state !== "active") throw badRequest("Start the server first.");
    if (cmd.action === "changemap") await checkWorkshop(cmd.map);
    let line: string;
    try {
      line = rconFor(cmd);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const { action, ...details } = cmd;
    audit.record(user.id, "server.command", id, { action, ...details });
    try {
      return { output: await rcon({ port: s.port, password: s.rconPassword }, line) };
    } catch (e) {
      throw badRequest(`The server didn't take the command: ${(e as Error).message}`);
    }
  });

  // Switching game mode from the Commands tab: right away, until the next restart or for good.
  /** Modes switched "until the next restart", keyed by server, with the start time of the process they apply to. */
  const liveModes = new Map<number, { presetName: string; map: string; processSince: string | null }>();

  app.get("/api/servers/:id/gamemode", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    const s = servers.require(id);
    const status = await host.serviceStatus(s.slug);
    let live = liveModes.get(id) ?? null;
    // A restart (or stop) loads the saved mode again.
    if (live && (status.state !== "active" || live.processSince !== status.since)) {
      liveModes.delete(id);
      live = null;
    }
    const preset = s.presetId ? presets.byId(s.presetId) : null;
    return { saved: { presetId: s.presetId, presetName: preset?.name ?? null, gameType: s.gameType, gameMode: s.gameMode, map: s.map }, live };
  });

  app.post("/api/servers/:id/gamemode", async (req) => {
    const user = requirePerm(req, "server.control");
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        presetId: z.number().int(),
        map: z.string().trim().max(80).optional(),
        keep: z.boolean().default(false),
        applyConfigs: z.boolean().default(false),
      })
      .parse(req.body);
    if (body.keep && !can(user.role, "server.manage")) throw forbidden("Only Admins and the Owner can change a server's saved game mode.");
    const s = servers.require(id);
    const status = await host.serviceStatus(s.slug);
    if (status.state !== "active") throw badRequest("Start the server first, or change the game mode in Settings.");
    const preset = presets.byId(body.presetId);
    if (!preset) throw badRequest("Unknown preset.");
    const map = body.map || preset.defaultMap;
    await checkWorkshop(map);
    let line: string;
    try {
      line = gameModeLine(preset.gameType, preset.gameMode, map);
    } catch (e) {
      throw badRequest((e as Error).message);
    }

    // Keeping it: save it first (launch options, and the preset's files if asked), so the
    // map change below already loads them.
    let restartNote = false;
    if (body.keep) {
      await servers.update(
        id,
        { presetId: preset.id, map, maxPlayers: preset.maxPlayers, ...(body.applyConfigs ? { applyPresetConfigs: true } : {}) },
        actorOf(user),
      );
      // The player limit is a launch option, so only a restart changes it.
      restartNote = preset.maxPlayers !== s.maxPlayers;
      liveModes.delete(id);
    }
    audit.record(user.id, "server.gamemode", id, { preset: preset.name, map, keep: body.keep, applyConfigs: body.keep && body.applyConfigs });
    let output: string;
    try {
      output = await rcon({ port: s.port, password: s.rconPassword }, line);
    } catch (e) {
      throw badRequest(`The server didn't take the command: ${(e as Error).message}`);
    }
    if (!body.keep) liveModes.set(id, { presetName: preset.name, map, processSince: status.since });
    return { output, maxPlayersNote: restartNote ? `Max players (${preset.maxPlayers}) changes at the next restart.` : null };
  });

  // Live console: journald output streamed over a WebSocket.
  app.get("/api/servers/:id/console", { websocket: true }, (socket, req) => {
    let stream: { stop(): void } | null = null;
    try {
      requirePerm(req, "view");
      const { id } = idParam.parse(req.params);
      const s = servers.require(id);
      stream = host.followLogs(s.slug, 300, (line) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "log", line }));
      });
    } catch (e) {
      socket.send(JSON.stringify({ type: "error", message: (e as Error).message }));
      socket.close();
      return;
    }
    socket.on("close", () => stream?.stop());
  });

  // ------------------------------------------------------------- config files

  app.get("/api/servers/:id/configs", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    return { files: await configs.list(servers.require(id)) };
  });

  app.get("/api/servers/:id/configs/file", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    const { path: p } = z.object({ path: z.string() }).parse(req.query);
    return configs.read(servers.require(id), p);
  });

  app.put("/api/servers/:id/configs/file", async (req) => {
    const user = requirePerm(req, "config.edit");
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        path: z.string(),
        content: z.string(),
        comment: z.string().max(200).optional(),
        apply: z.enum(["save", "exec", "restart"]).default("save"),
      })
      .parse(req.body);
    const s = servers.require(id);
    const { changed } = await configs.save(s, body.path, body.content, user.id, body.comment ?? "");
    if (changed) audit.record(user.id, "config.save", id, { path: body.path, comment: body.comment ?? "" });
    const applied = await applyConfig(s, body.path, body.apply, user);
    return { changed, applied, file: await configs.read(s, body.path) };
  });

  app.delete("/api/servers/:id/configs/file", async (req) => {
    const user = requirePerm(req, "config.edit");
    const { id } = idParam.parse(req.params);
    const { path: p } = z.object({ path: z.string() }).parse(req.query);
    const s = servers.require(id);
    const { result } = await configs.revert(s, p, user.id);
    audit.record(user.id, result === "stock" ? "config.revert" : "config.delete", id, { path: p });
    return { result };
  });

  app.get("/api/servers/:id/configs/revisions/:revId", async (req) => {
    requirePerm(req, "view");
    const { id, revId } = z.object({ id: z.coerce.number().int(), revId: z.coerce.number().int() }).parse(req.params);
    servers.require(id);
    return configs.revisionContent(id, revId);
  });

  app.post("/api/servers/:id/configs/rollback", async (req) => {
    const user = requirePerm(req, "config.edit");
    const { id } = idParam.parse(req.params);
    const { revisionId } = z.object({ revisionId: z.number().int() }).parse(req.body);
    const s = servers.require(id);
    const { path: p } = await configs.rollback(s, revisionId, user.id);
    audit.record(user.id, "config.rollback", id, { path: p, revisionId });
    return { file: await configs.read(s, p).catch(() => null), path: p };
  });

  async function applyConfig(s: { id: number; slug: string; port: number; rconPassword: string }, p: string, mode: string, user: User) {
    if (mode === "save") return "saved";
    const status = await host.serviceStatus(s.slug);
    if (status.state !== "active") return "saved (server not running)";
    if (mode === "restart") {
      await servers.control(s.id, "restart", actorOf(user));
      return "restarted";
    }
    if (!can(user.role, "rcon")) throw forbidden("Executing configs needs RCON permission.");
    if (!p.startsWith("cfg/") || !p.endsWith(".cfg")) return "saved (only .cfg files under cfg/ can be executed)";
    try {
      await rcon({ port: s.port, password: s.rconPassword }, `exec ${p.slice(4, -4)}`);
      return "executed";
    } catch (e) {
      return `saved, but exec failed: ${(e as Error).message}`;
    }
  }

  // ------------------------------------------------------------- plugins

  app.get("/api/servers/:id/plugins", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    const { refresh } = z.object({ refresh: z.coerce.boolean().optional() }).parse(req.query);
    return { plugins: await plugins.overview(id, refresh), databaseConfigured: plugins.databaseConfigured, warnings: await plugins.warnings(id) };
  });

  app.get("/api/plugins/catalog", async (req) => {
    requirePerm(req, "view");
    return {
      plugins: CATALOG.map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        requires: e.requires,
        library: !!e.library,
        companionOf: e.companionOf ?? null,
      })),
    };
  });

  app.get("/api/plugins/:pluginId/versions", async (req) => {
    requirePerm(req, "view");
    const { pluginId } = z.object({ pluginId: z.string() }).parse(req.params);
    try {
      return {
        versions: (await plugins.versions(pluginId))
          .filter((v) => v.asset)
          .map((v) => ({ version: v.version, publishedAt: v.publishedAt, prerelease: v.prerelease })),
      };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw badRequest((e as Error).message);
    }
  });

  app.post("/api/servers/:id/plugins/:pluginId/install", async (req) => {
    const user = requirePerm(req, "plugins.manage");
    const { id, pluginId } = z.object({ id: z.coerce.number().int(), pluginId: z.string() }).parse(req.params);
    const { version } = z.object({ version: z.string().optional() }).parse(req.body ?? {});
    return plugins.install(id, pluginId, version, user.id);
  });

  app.post("/api/servers/:id/plugins/:pluginId/rollback", async (req) => {
    const user = requirePerm(req, "plugins.manage");
    const { id, pluginId } = z.object({ id: z.coerce.number().int(), pluginId: z.string() }).parse(req.params);
    return plugins.rollback(id, pluginId, user.id);
  });

  app.delete("/api/servers/:id/plugins/:pluginId", async (req) => {
    const user = requirePerm(req, "plugins.manage");
    const { id, pluginId } = z.object({ id: z.coerce.number().int(), pluginId: z.string() }).parse(req.params);
    return plugins.uninstall(id, pluginId, user.id);
  });

  app.addContentTypeParser(
    ["application/zip", "application/gzip", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: 200 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.post("/api/servers/:id/plugins/upload", { bodyLimit: 200 * 1024 * 1024 }, async (req) => {
    // Custom plugins run arbitrary code on the server, so only the Owner may upload them.
    const user = requirePerm(req, "plugins.upload");
    const { id } = idParam.parse(req.params);
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(req.query);
    if (!Buffer.isBuffer(req.body)) throw badRequest("Send the file itself as the request body.");
    return plugins.installUpload(id, name, req.body, user.id);
  });

  app.get("/api/servers/:id/plugins/health", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    return plugins.health(id);
  });

  // ------------------------------------------------------------- players

  const steamIdFrom = async (input: string): Promise<string> => {
    try {
      return await resolveSteamId(input, fetchFn);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  };

  app.get("/api/servers/:id/players", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    return players.live(id);
  });

  app.post("/api/servers/:id/players/:userId/kick", async (req) => {
    const user = requirePerm(req, "players.moderate");
    const { id, userId } = z.object({ id: z.coerce.number().int(), userId: z.coerce.number().int().min(0) }).parse(req.params);
    const { reason } = z.object({ reason: z.string().max(200).default("") }).parse(req.body ?? {});
    await players.kick(id, userId, reason, user.id);
    return { ok: true };
  });

  app.get("/api/players/recent", async (req) => {
    requirePerm(req, "view");
    const { serverId } = z.object({ serverId: z.coerce.number().int().optional() }).parse(req.query);
    return { players: players.recent(serverId) };
  });

  // Panel bans: one list for all servers, enforced by the bridge plugin.
  app.get("/api/bans", async (req) => {
    requirePerm(req, "view");
    const { all } = z.object({ all: z.enum(["0", "1", "true", "false"]).default("0") }).parse(req.query);
    return { bans: bans.list(all === "1" || all === "true") };
  });

  app.post("/api/bans", async (req) => {
    const user = requirePerm(req, "players.moderate");
    const body = z
      .object({
        serverId: z.number().int().optional(),
        userId: z.number().int().min(0).optional(),
        steam: z.string().max(200).optional(),
        name: z.string().max(64).optional(),
        minutes: z.number().int(),
        reason: z.string().max(200),
      })
      .parse(req.body);
    let steamId: string;
    let name = body.name?.trim() || null;
    if (body.userId !== undefined) {
      if (body.serverId === undefined) throw badRequest("Pick the server the player is on.");
      const p = (await players.live(body.serverId)).players.find((x) => x.userId === body.userId);
      if (!p) throw badRequest("That player isn't on the server anymore. Ban them by SteamID instead.");
      if (!p.steamId) throw badRequest("The panel can't see this player's SteamID. Install CS2 Panel Bridge on the server (Plugins tab), or ban by SteamID.");
      steamId = p.steamId;
      name = p.name;
    } else {
      if (!body.steam?.trim()) throw badRequest("Pick a player or enter a SteamID.");
      steamId = await steamIdFrom(body.steam);
    }
    const ban = await bans.ban({ steamId, name, minutes: body.minutes, reason: body.reason, serverId: body.serverId ?? null }, user.id);
    return { ban, coverage: bans.coverage() };
  });

  app.post("/api/bans/:id/unban", async (req) => {
    const user = requirePerm(req, "players.moderate");
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string().max(200).default("") }).parse(req.body ?? {});
    await bans.unban(id, reason, user.id);
    return { ok: true };
  });

  app.get("/api/bans/coverage", async (req) => {
    requirePerm(req, "view");
    return bans.coverage();
  });

  app.get("/api/servers/:id/moderation", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    return players.moderationInfo(id);
  });

  app.get("/api/servers/:id/moderation/bans", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    const { all } = z.object({ all: z.coerce.boolean().default(false) }).parse(req.query);
    return { bans: await players.bans(id, all) };
  });

  app.post("/api/servers/:id/moderation/bans", async (req) => {
    const user = requirePerm(req, "players.moderate");
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ userId: z.number().int().optional(), steam: z.string().optional(), minutes: z.number().int(), reason: z.string().max(200) })
      .parse(req.body);
    if (body.userId === undefined && !body.steam) throw badRequest("Pick a player or enter a SteamID.");
    const target = body.userId !== undefined ? { userId: body.userId } : { steamId: await steamIdFrom(body.steam!) };
    await players.ban(id, target, body.minutes, body.reason, user.id);
    return { ok: true };
  });

  app.post("/api/servers/:id/moderation/bans/unban", async (req) => {
    const user = requirePerm(req, "players.moderate");
    const { id } = idParam.parse(req.params);
    const body = z.object({ steamId: z.string(), reason: z.string().max(200).default("") }).parse(req.body);
    await players.unban(id, body.steamId, body.reason, user.id);
    return { ok: true };
  });

  // The maps in the plugin's in-game change-map menu (SimpleAdmin's DefaultMaps/WorkshopMaps).
  app.get("/api/servers/:id/moderation/maps", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    return { menu: await mapMenus.get(servers.require(id)), installed: await mapMenus.installedMaps() };
  });

  app.put("/api/servers/:id/moderation/maps", async (req) => {
    const user = requirePerm(req, "config.edit");
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        maps: z.array(z.string().max(100)).max(300),
        workshop: z.array(z.object({ name: z.string().max(100), id: z.string().max(30) })).max(300),
      })
      .parse(req.body);
    const s = servers.require(id);
    const { changed, file } = await mapMenus.set(s, body, user.id);
    if (changed) audit.record(user.id, "config.save", id, { path: file, comment: "Change-map menu" });
    return { changed, menu: await mapMenus.get(s) };
  });

  app.get("/api/servers/:id/moderation/admins", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    return { admins: await players.admins(id) };
  });

  app.post("/api/servers/:id/moderation/admins", async (req) => {
    const user = requirePerm(req, "gameadmins.manage");
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        steam: z.string().min(1),
        name: z.string().min(1).max(64),
        flags: z.string().min(1).max(200),
        immunity: z.number().int().default(0),
        minutes: z.number().int().min(0).default(0),
      })
      .parse(req.body);
    await players.addAdmin(id, { ...body, steamId: await steamIdFrom(body.steam) }, user.id);
    return { ok: true };
  });

  app.delete("/api/servers/:id/moderation/admins/:steamId", async (req) => {
    const user = requirePerm(req, "gameadmins.manage");
    const { id, steamId } = z.object({ id: z.coerce.number().int(), steamId: z.string() }).parse(req.params);
    await players.removeAdmin(id, steamId, user.id);
    return { ok: true };
  });

  // ------------------------------------------------------------- game update

  app.get("/api/game", async (req) => {
    requirePerm(req, "view");
    const q = z.object({ since: z.coerce.number().int().default(0) }).parse(req.query);
    // Job state first, then the log: if the state says finished, the log is complete.
    // (Reading them the other way round, with awaits in between, could report "succeeded" with lines missing.)
    const job = { ...updater.job, lines: undefined };
    const { lines, next } = updater.linesSince(q.since);
    return {
      cs2: { installed: await files.baseInstalled(), ...(await files.baseVersion()) },
      job,
      lines,
      next,
      auto: await automation.updates.status(),
    };
  });

  app.put("/api/game/auto", async (req) => {
    const user = requirePerm(req, "game.update");
    const body = z
      .object({
        policy: z.enum(["off", "notify", "when-empty", "now"]) as z.ZodType<UpdatePolicy>,
        checkMinutes: z.number().int(),
        maxWaitMinutes: z.number().int(),
        warnSeconds: z.number().int(),
      })
      .parse(req.body);
    automation.updates.setConfig(body, user.id);
    return { auto: await automation.updates.status() };
  });

  app.post("/api/game/check", async (req) => {
    requirePerm(req, "game.update");
    await automation.updates.check();
    return { auto: await automation.updates.status() };
  });

  // ---------------------------------------------------------------- monitor

  app.get("/api/monitor", async (req) => {
    requirePerm(req, "view");
    return {
      latest: monitor.latest(),
      alerts: monitor.alerts(),
      cpuCount: host.cpuCount(),
      servers: servers.listRecords().map((s) => ({ id: s.id, name: s.name, cpu: s.cpu })),
    };
  });

  app.get("/api/metrics", async (req) => {
    requirePerm(req, "view");
    const q = z
      .object({
        scope: z.union([z.literal("machine"), z.coerce.number().int().positive()]),
        range: z.enum(Object.keys(RANGES) as [Range, ...Range[]]).default("24h"),
      })
      .parse(req.query);
    if (q.scope !== "machine") servers.require(q.scope);
    return monitor.series(q.scope === "machine" ? MACHINE : q.scope, q.range);
  });

  app.get("/api/alerts", async (req) => {
    requirePerm(req, "view");
    const { all } = z.object({ all: z.enum(["0", "1"]).default("0") }).parse(req.query);
    return { alerts: monitor.alerts(all === "1") };
  });

  // ---------------------------------------------------------------- backups

  app.get("/api/backups", async (req) => {
    requirePerm(req, "view");
    const list = await backups.list();
    return { backups: list, settings: backups.config(), totalBytes: list.reduce((n, b) => n + b.sizeBytes, 0) };
  });

  app.post("/api/servers/:id/backups", async (req) => {
    const user = requirePerm(req, "server.manage");
    const { id } = idParam.parse(req.params);
    return { backup: await backups.backupServer(servers.require(id), user.id, "manual") };
  });

  app.post("/api/backups/panel", async (req) => {
    const user = requirePerm(req, "users.manage");
    return { backup: await backups.backupPanel(user.id, "manual") };
  });

  /** Server backups: Admins and the Owner. The panel database holds everyone's data: Owner only. */
  const backupPerm = (id: string) => (backups.resolve(id).kind === "panel" ? "users.manage" : "server.manage");

  app.get("/api/backups/download", async (req, reply) => {
    const { id } = z.object({ id: z.string().max(200) }).parse(req.query);
    requirePerm(req, backupPerm(id));
    const f = await backups.open(id);
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", String(f.size))
      .header("Content-Disposition", `attachment; filename="${f.file}"`)
      .send(f.stream);
  });

  app.delete("/api/backups", async (req) => {
    const { id } = z.object({ id: z.string().max(200) }).parse(req.query);
    const user = requirePerm(req, backupPerm(id));
    await backups.delete(id, user.id);
    return { ok: true };
  });

  app.post("/api/backups/restore", async (req) => {
    const user = requirePerm(req, "server.manage");
    const { id } = z.object({ id: z.string().max(200) }).parse(req.body);
    return backups.restore(id, user.id);
  });

  app.put("/api/backups/settings", async (req) => {
    const user = requirePerm(req, "server.manage");
    const body = z.object({ enabled: z.boolean(), time: z.string().max(5), keep: z.number().int() }).parse(req.body);
    return { settings: backups.setConfig(body, user.id) };
  });

  // ---------------------------------------------------------- shared settings

  app.get("/api/shared", async (req) => {
    requirePerm(req, "view");
    return {
      shared: shared.get(),
      preview: servers.listRecords().map((s) => ({ id: s.id, name: s.name, hostname: shared.hostnameFor(s), uses: shared.uses(s.id) })),
    };
  });

  app.put("/api/shared", async (req) => {
    const user = requirePerm(req, "server.manage");
    const body = z
      .object({
        hostnamePrefix: z.string().max(64).default(""),
        tags: z.string().max(200).default(""),
        cvars: z.string().max(20_000).default(""),
        excluded: z.array(z.number().int()).max(200).default([]),
      })
      .parse(req.body);
    const r = await shared.set(body, user.id);
    return { shared: r.config, liveOn: r.liveOn };
  });

  // ---------------------------------------------------------- notifications

  app.get("/api/notifications", async (req) => {
    requirePerm(req, "server.manage");
    return { discord: discord.view(), groups: EVENT_GROUPS };
  });

  app.put("/api/notifications", async (req) => {
    const user = requirePerm(req, "server.manage");
    const body = z
      .object({
        webhook: z.string().max(300).optional(),
        events: z.partialRecord(z.enum(Object.keys(EVENT_GROUPS) as [EventGroup, ...EventGroup[]]), z.boolean()).default({}),
      })
      .parse(req.body);
    const view = discord.set(body);
    audit.record(user.id, "notifications.update", null, { webhookSet: view.webhookSet, events: view.events });
    return { discord: view };
  });

  app.post("/api/notifications/test", async (req) => {
    requirePerm(req, "server.manage");
    await discord.test();
    return { ok: true };
  });

  app.get("/api/servers/:id/schedule", async (req) => {
    requirePerm(req, "view");
    const { id } = idParam.parse(req.params);
    servers.require(id);
    return automation.restarts.view(id);
  });

  app.put("/api/servers/:id/schedule", async (req) => {
    const user = requirePerm(req, "server.manage");
    const { id } = idParam.parse(req.params);
    servers.require(id);
    const body = z
      .object({ restartAt: z.string().max(5).nullable(), ifPlayers: z.enum(["wait", "restart"]), maxWaitMinutes: z.number().int() })
      .parse(req.body);
    automation.restarts.set(id, body, user.id);
    return automation.restarts.view(id);
  });

  app.post("/api/game/update", async (req) => {
    const user = requirePerm(req, "game.update");
    const body = z.object({ validate: z.boolean().default(false), warnSeconds: z.number().int().min(0).max(600).default(60) }).parse(req.body ?? {});
    void updater.start(body, user.id);
    return { ok: true };
  });

  // ------------------------------------------------------------- matchmaking (admin side)

  app.get("/api/matchmaking", async (req) => {
    requirePerm(req, "view");
    const config = matchmaking.config();
    const pool = new Set(config.serverIds);
    return {
      settings: config,
      leetifyKeyHint: matchmaking.leetifyKeyHint(),
      site: publicSite.status(),
      servers: servers.listRecords().map((s) => ({ id: s.id, name: s.name, port: s.port, inPool: pool.has(s.id), hasBridge: bans.hasBridge(s.id) })),
      maps: await mapMenus.installedMaps(),
      state: matchmaking.state(null),
      history: matchmaking.history(),
      mapNames: matchmaking.mapNames(),
      httpsDomain: publicSite.status().https ? tls.https().domain : null,
      themes: THEMES,
      layouts: LAYOUTS,
      images: matchmaking.imageUrls(),
    };
  });

  const imageKind = z.object({ kind: z.enum(["icon", "banner"]) });
  app.addContentTypeParser(["image/png", "image/jpeg", "image/webp"], { parseAs: "buffer", bodyLimit: 4 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );
  app.put("/api/matchmaking/images/:kind", { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const user = requirePerm(req, "server.manage");
    const { kind } = imageKind.parse(req.params);
    if (!Buffer.isBuffer(req.body)) throw badRequest("Upload a PNG, JPG or WebP image.");
    await matchmaking.saveImage(kind as ImageKind, req.body, user.id);
    return { images: matchmaking.imageUrls() };
  });
  app.get("/api/matchmaking/images/:kind", async (req, reply) => {
    requirePerm(req, "view");
    const img = await matchmaking.readImage(imageKind.parse(req.params).kind as ImageKind);
    if (!img) throw notFound("No image uploaded.");
    return reply.type(img.type).header("Cache-Control", "no-cache").send(img.data);
  });
  app.delete("/api/matchmaking/images/:kind", async (req) => {
    const user = requirePerm(req, "server.manage");
    const { kind } = imageKind.parse(req.params);
    await matchmaking.removeImage(kind as ImageKind, user.id);
    return { images: matchmaking.imageUrls() };
  });

  app.put("/api/matchmaking", async (req) => {
    const user = requirePerm(req, "server.manage");
    const body = z.object({ settings: z.unknown(), leetifyKey: z.string().max(300).nullable().optional() }).parse(req.body ?? {});
    const settings = await matchmaking.saveConfig(body.settings, body.leetifyKey, user.id);
    return { settings, site: publicSite.status(), leetifyKeyHint: matchmaking.leetifyKeyHint() };
  });

  app.delete("/api/matchmaking/workshop/:id", async (req) => {
    const user = requirePerm(req, "server.manage");
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { mode } = z.object({ mode: z.enum(MODES) }).parse(req.query ?? {});
    return matchmaking.removeWorkshopMap(id, mode, user.id);
  });

  app.put("/api/matchmaking/players/:steamId/rating", async (req) => {
    const user = requirePerm(req, "players.moderate");
    const { steamId } = z.object({ steamId: z.string() }).parse(req.params);
    const { rating } = z.object({ rating: z.number().int().nullable() }).parse(req.body ?? {});
    matchmaking.setOverride(steamId, rating, user.id);
    return { ok: true };
  });

  app.post("/api/matchmaking/players/:steamId/remove", async (req) => {
    const user = requirePerm(req, "players.moderate");
    const { steamId } = z.object({ steamId: z.string() }).parse(req.params);
    matchmaking.kick(steamId, user.id);
    return { ok: true };
  });

  app.post("/api/matchmaking/matches/:id/cancel", async (req) => {
    const user = requirePerm(req, "players.moderate");
    await matchmaking.cancelMatch(null, idParam.parse(req.params).id, user.id);
    return { ok: true };
  });

  // A match server whose cleanup keeps failing: try again now, or free it after sorting it out by hand.
  app.post("/api/matchmaking/servers/:id/cleanup", async (req) => {
    const user = requirePerm(req, "players.moderate");
    const { id } = idParam.parse(req.params);
    const { action } = z.object({ action: z.enum(["retry", "release"]) }).parse(req.body ?? {});
    if (action === "retry") await matchmaking.retryCleanup(id, user.id);
    else await matchmaking.releaseServer(id, user.id);
    return { ok: true };
  });

  // ------------------------------------------------------------- HTTPS for the matchmaking site

  app.get("/api/tls", async (req) => {
    requirePerm(req, "view");
    return { ...tls.status(), site: publicSite.status() };
  });

  app.put("/api/tls/https", async (req) => {
    const user = requirePerm(req, "server.manage");
    const body = z.object({ settings: z.unknown(), cloudflareToken: z.string().max(300).nullable().optional() }).parse(req.body ?? {});
    tls.saveHttps(body.settings, body.cloudflareToken, user.id);
    await publicSite.sync();
    return { ...tls.status(), site: publicSite.status() };
  });

  app.post("/api/tls/renew", async (req) => {
    const user = requirePerm(req, "server.manage");
    await tls.renew(user.id);
    await publicSite.sync();
    return { ...tls.status(), site: publicSite.status() };
  });

  app.put("/api/tls/firewall", async (req) => {
    const user = requirePerm(req, "server.manage");
    tls.saveFirewall((req.body as { settings?: unknown } | null)?.settings, user.id);
    return tls.status();
  });

  app.post("/api/tls/firewall/probe", async (req) => {
    requirePerm(req, "server.manage");
    try {
      return { fingerprint: await tls.probe() };
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  });

  app.post("/api/tls/firewall/connect", async (req) => {
    const user = requirePerm(req, "server.manage");
    const b = z.object({ fingerprint: z.string().max(200), user: z.string().min(1).max(64), password: z.string().min(1).max(256) }).parse(req.body ?? {});
    const info = await tls.connect(b.fingerprint, b.user, b.password, user.id);
    return { ...tls.status(), info };
  });

  app.post("/api/tls/firewall/forget", async (req) => {
    const user = requirePerm(req, "server.manage");
    tls.forgetFirewall(user.id);
    return tls.status();
  });

  app.post("/api/tls/firewall/push", async (req) => {
    const user = requirePerm(req, "server.manage");
    await tls.push(user.id);
    return tls.status();
  });

  // ------------------------------------------------------------- frontend

  if (existsSync(config.webDir)) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      wildcard: false,
      // index.html must always be fresh so an update reaches the browser; the hashed
      // files under assets/ never change, so those can be cached for good.
      setHeaders: (res, file) => {
        res.header("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    // Single-page app: anything that isn't an API call or a file gets index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || path.extname(req.url.split("?")[0]!) !== "") {
        return reply.status(404).send({ error: "Not found." });
      }
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
  }

  return {
    fastify: app,
    services: {
      users,
      sessions,
      audit,
      servers,
      configs,
      updater,
      presets,
      plugins,
      players,
      bans,
      automation,
      monitor,
      discord,
      backups,
      matchmaking,
      publicSite,
      tls,
      discordBot,
    },
  };
}
