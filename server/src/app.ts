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
  const servers = new ServerService(serverStore, presets, files, configs, host, audit, gate);
  const updater = new GameUpdater(host, files, serverStore, audit, gate, rcon);
  const pluginSources = new PluginSources(path.join(config.dataDir, "plugin-cache"), fetchFn);
  const plugins = new PluginService(db, pluginSources, servers, files, audit, gate, rcon, path.join(config.dataDir, "tmp"), config.mysql);
  updater.afterStart = (started) => plugins.healthLines(started);
  if (deps.pluginCheckDelayMs !== undefined) updater.pluginCheckDelayMs = deps.pluginCheckDelayMs;

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
    return { user, permissions: permissionsFor(user.role), dev: config.dev };
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
    };
  });

  app.get("/api/presets", async (req) => {
    requirePerm(req, "view");
    return { presets: presets.list() };
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
    return { server };
  });

  app.post("/api/servers", async (req) => {
    const user = requirePerm(req, "server.manage");
    return { server: await servers.create(req.body, actorOf(user)) };
  });

  app.patch("/api/servers/:id", async (req) => {
    const user = requirePerm(req, "server.manage");
    const { id } = idParam.parse(req.params);
    return servers.update(id, req.body, actorOf(user));
  });

  app.post("/api/servers/:id/duplicate", async (req) => {
    const user = requirePerm(req, "server.manage");
    const { id } = idParam.parse(req.params);
    const server = await servers.duplicate(id, req.body, actorOf(user));
    plugins.copyInstalls(id, server.id);
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
    return { plugins: await plugins.overview(id, refresh), mysqlConfigured: plugins.mysqlConfigured };
  });

  app.get("/api/plugins/:pluginId/versions", async (req) => {
    requirePerm(req, "view");
    const { pluginId } = z.object({ pluginId: z.string() }).parse(req.params);
    try {
      return { versions: (await plugins.versions(pluginId)).filter((v) => v.asset).map((v) => ({ version: v.version, publishedAt: v.publishedAt, prerelease: v.prerelease })) };
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

  app.addContentTypeParser(["application/zip", "application/gzip", "application/octet-stream"], { parseAs: "buffer", bodyLimit: 200 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
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

  // ------------------------------------------------------------- game update

  app.get("/api/game", async (req) => {
    requirePerm(req, "view");
    const q = z.object({ since: z.coerce.number().int().default(0) }).parse(req.query);
    const { lines, next } = updater.linesSince(q.since);
    return {
      cs2: { installed: await files.baseInstalled(), ...(await files.baseVersion()) },
      job: { ...updater.job, lines: undefined },
      lines,
      next,
    };
  });

  app.post("/api/game/update", async (req) => {
    const user = requirePerm(req, "game.update");
    const body = z
      .object({ validate: z.boolean().default(false), warnSeconds: z.number().int().min(0).max(600).default(60) })
      .parse(req.body ?? {});
    updater.start(body, user.id);
    return { ok: true };
  });

  // ------------------------------------------------------------- frontend

  if (existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
    // Single-page app: anything that isn't an API call or a file gets index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || path.extname(req.url.split("?")[0]!) !== "") {
        return reply.status(404).send({ error: "Not found." });
      }
      return reply.sendFile("index.html");
    });
  }

  return {
    fastify: app,
    services: { users, sessions, audit, servers, configs, updater, presets, plugins },
  };
}
