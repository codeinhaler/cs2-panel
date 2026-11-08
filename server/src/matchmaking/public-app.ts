import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { HttpError, forbidden } from "../errors.js";
import { buildLoginUrl, verifyCallback } from "../auth/steam-openid.js";
import { fetchProfile } from "../auth/steam-profile.js";
import { MM_MAX_AGE_MS, MM_SESSION_COOKIE, type MmPlayerStore } from "./players.js";
import { MODES, type Matchmaking, type MatchView } from "./service.js";
import { themeCss } from "./look.js";

declare module "fastify" {
  interface FastifyRequest {
    mmPlayer: string | null;
  }
}

export interface PublicDeps {
  mm: Matchmaking;
  players: MmPlayerStore;
  isBanned: (steamId: string) => boolean;
  fetchFn: typeof fetch;
  webDir: string;
  dev: boolean;
  logLevel: string;
  /** Certificate and key when the site runs on HTTPS. */
  https?: { cert: string; key: string } | null;
}

/** What a player in the match needs to join. */
export interface JoinInfo {
  address: string;
  password: string;
  steamUrl: string;
  console: string;
}

/** The host name from the browser's Host header, without the port. */
export function hostOnly(hostHeader: string | undefined): string {
  const h = (hostHeader ?? "").trim();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0] ?? "";
}

const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * The matchmaking site for players. It's its own web server on its own port,
 * so it can be opened to the internet while the panel stays on the LAN: it has
 * none of the panel's routes, and the panel's sign-in doesn't work here.
 */
export async function buildPublicApp(d: PublicDeps): Promise<FastifyInstance> {
  const { mm, players } = d;
  const app = (
    d.https
      ? Fastify({ logger: { level: d.logLevel }, trustProxy: false, bodyLimit: 64 * 1024, https: { cert: d.https.cert, key: d.https.key } })
      : Fastify({ logger: { level: d.logLevel }, trustProxy: false, bodyLimit: 64 * 1024 })
  ) as FastifyInstance;
  await app.register(cookie);
  app.decorateRequest("mmPlayer", null);

  app.addHook("onRequest", async (req) => {
    req.mmPlayer = players.resolveSession(req.cookies[MM_SESSION_COOKIE]);
  });
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw forbidden("Cross-site request blocked.");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: err.issues[0]?.message ?? "Invalid input." });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: "Something went wrong. Try again." });
  });

  const baseUrl = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`;
  const requirePlayer = (req: FastifyRequest): string => {
    if (!req.mmPlayer) throw new HttpError(401, "Sign in with Steam first.");
    return req.mmPlayer;
  };
  const signIn = (reply: FastifyReply, steamId: string) => {
    players.ensure(steamId);
    reply.setCookie(MM_SESSION_COOKIE, players.createSession(steamId), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: !!d.https,
      maxAge: Math.floor(MM_MAX_AGE_MS / 1000),
    });
    void fetchProfile(steamId, d.fetchFn).then((p) => players.setProfile(steamId, p));
  };

  // ------------------------------------------------------------- sign-in

  app.get("/api/auth/steam", async (req, reply) => reply.redirect(buildLoginUrl(baseUrl(req))));

  app.get("/api/auth/steam/callback", async (req, reply) => {
    let steamId: string;
    try {
      steamId = await verifyCallback(req.query as Record<string, string>, baseUrl(req), d.fetchFn);
    } catch (e) {
      return reply.redirect(`/?error=${encodeURIComponent((e as Error).message)}`);
    }
    if (d.isBanned(steamId)) return reply.redirect(`/?error=${encodeURIComponent("You're banned from these servers.")}`);
    signIn(reply, steamId);
    return reply.redirect("/");
  });

  if (d.dev) {
    // Development only: be any SteamID without Steam.
    app.get("/api/auth/dev", async (req, reply) => {
      const { steamId, name } = z.object({ steamId: z.string().regex(/^7656119\d{10}$/), name: z.string().max(32).optional() }).parse(req.query);
      players.ensure(steamId);
      if (name) players.setProfile(steamId, { name });
      reply.setCookie(MM_SESSION_COOKIE, players.createSession(steamId), { path: "/", httpOnly: true, sameSite: "lax" });
      return reply.redirect("/");
    });
  }

  app.post("/api/auth/logout", async (req, reply) => {
    const me = req.mmPlayer;
    if (me) mm.leave(me);
    players.destroySession(req.cookies[MM_SESSION_COOKIE]);
    reply.clearCookie(MM_SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // ------------------------------------------------------------- state

  const withJoin = (req: FastifyRequest, m: MatchView): MatchView & { joinInfo: JoinInfo | null } => {
    const { join, ...rest } = m;
    if (!join) return { ...rest, join: null, joinInfo: null };
    const host = mm.config().gameAddress || hostOnly(req.headers.host);
    const address = `${host}:${join.port}`;
    return {
      ...rest,
      join: null,
      joinInfo: {
        address,
        password: join.password,
        steamUrl: `steam://connect/${address}/${join.password}`,
        console: `connect ${address}; password ${join.password}`,
      },
    };
  };

  app.get("/api/state", async (req) => {
    const me = req.mmPlayer;
    if (me) mm.touch(me);
    const s = mm.state(me);
    const host = mm.config().gameAddress || hostOnly(req.headers.host);
    const casual = {
      name: s.casual.name,
      servers: s.casual.servers.map(({ port, password, ...rest }) => {
        const address = `${host}:${port}`;
        return {
          ...rest,
          joinInfo: {
            address,
            password,
            steamUrl: password ? `steam://connect/${address}/${password}` : `steam://connect/${address}`,
            console: password ? `connect ${address}; password ${password}` : `connect ${address}`,
          },
        };
      }),
    };
    return { ...s, casual, matches: s.matches.map((m) => withJoin(req, m)) };
  });

  // ------------------------------------------------------------- lobby

  app.post("/api/lobby/join", async (req) => {
    const { mode } = z.object({ mode: z.enum(MODES).default("competitive") }).parse(req.body ?? {});
    mm.join(requirePlayer(req), mode);
    return { ok: true };
  });
  app.post("/api/lobby/leave", async (req) => {
    mm.leave(requirePlayer(req));
    return { ok: true };
  });
  app.post("/api/lobby/ready", async (req) => {
    const { ready } = z.object({ ready: z.boolean() }).parse(req.body ?? {});
    mm.setReady(requirePlayer(req), ready);
    return { ok: true };
  });
  app.put("/api/me/rating", async (req) => {
    const { rating } = z.object({ rating: z.number().int().nullable() }).parse(req.body ?? {});
    mm.setSelfRating(requirePlayer(req), rating);
    return { ok: true };
  });

  // ------------------------------------------------------------- teams

  app.post("/api/teams", async (req) => {
    await mm.makeTeams(requirePlayer(req));
    return { ok: true };
  });
  app.post("/api/teams/:id/reshuffle", async (req) => {
    mm.reshuffle(requirePlayer(req), idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/teams/:id/cancel", async (req) => {
    mm.cancelDraft(requirePlayer(req), idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/teams/:id/start", async (req) => {
    const matchId = await mm.startDraft(requirePlayer(req), idParam.parse(req.params).id);
    return { matchId };
  });

  // ------------------------------------------------------------- matches

  app.post("/api/matches/:id/ban", async (req) => {
    const { map } = z.object({ map: z.string().min(1).max(80) }).parse(req.body ?? {});
    mm.ban(requirePlayer(req), idParam.parse(req.params).id, map);
    return { ok: true };
  });
  app.post("/api/matches/:id/side", async (req) => {
    const { side } = z.object({ side: z.enum(["ct", "t"]) }).parse(req.body ?? {});
    mm.pickSide(requirePlayer(req), idParam.parse(req.params).id, side);
    return { ok: true };
  });
  app.post("/api/matches/:id/join", async (req) => {
    const team = await mm.joinMatch(requirePlayer(req), idParam.parse(req.params).id);
    return { team };
  });
  app.post("/api/matches/:id/late-joins", async (req) => {
    const { allow } = z.object({ allow: z.boolean() }).parse(req.body ?? {});
    mm.setLateJoins(requirePlayer(req), idParam.parse(req.params).id, allow);
    return { ok: true };
  });
  app.post("/api/matches/:id/start-now", async (req) => {
    await mm.startNow(requirePlayer(req), idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/matches/:id/cancel", async (req) => {
    await mm.cancelMatch(requirePlayer(req), idParam.parse(req.params).id);
    return { ok: true };
  });

  // ------------------------------------------------------------- the page

  app.get("/branding/:kind", async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(["icon", "banner"]) }).parse(req.params);
    const img = await mm.readImage(kind);
    if (!img) return reply.status(404).send({ error: "Not found." });
    return reply.type(img.type).header("Cache-Control", "public, max-age=86400").send(img.data);
  });

  /** The page with the theme, title and icon put in, so it shows right from the first paint. */
  const page = async (): Promise<string> => {
    let html = await fs.readFile(path.join(d.webDir, "play.html"), "utf8");
    const c = mm.config();
    const css = themeCss(c.look);
    const urls = mm.imageUrls();
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(c.title)}</title>`);
    if (urls.icon) html = html.replace(/<link rel="icon" href="[^"]*"\s*\/?>/, `<link rel="icon" href="${urls.icon}" />`);
    if (css) html = html.replace("</head>", `<style id="cs2mm-theme">${css}</style></head>`);
    return html;
  };

  // Only the player page and its files are served here, never the panel's page.
  if (existsSync(path.join(d.webDir, "play.html"))) {
    await app.register(fastifyStatic, {
      root: path.join(d.webDir, "assets"),
      prefix: "/assets/",
      wildcard: false,
      setHeaders: (res) => res.header("Cache-Control", "public, max-age=31536000, immutable"),
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || path.extname(req.url.split("?")[0]!) !== "") return reply.status(404).send({ error: "Not found." });
      return page().then((html) => reply.header("Cache-Control", "no-cache").type("text/html; charset=utf-8").send(html));
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found." });
      return reply.type("text/plain").send("The matchmaking page isn't built. Run npm run build.");
    });
  }

  return app;
}

/** Starts, moves or stops the public site to match the settings. */
export class PublicSite {
  private app: FastifyInstance | null = null;
  private redirect: FastifyInstance | null = null;
  /** What's running now, e.g. "http:8090" or "https:443". */
  private running: string | null = null;
  private listeningOn: number | null = null;
  private secure = false;
  private lastError: string | null = null;
  /** Off in tests; the panel turns it on when it runs for real. */
  autoListen = false;

  constructor(
    private readonly build: (https: { cert: string; key: string } | null) => Promise<FastifyInstance>,
    private readonly mm: Matchmaking,
    private readonly host: string,
    private readonly panelPort: number,
    /** The certificate to serve, when HTTPS is on and one exists. */
    private readonly certificate: () => { cert: string; key: string } | null = () => null,
    /** The domain the http → https redirect sends people to. */
    private readonly domain: () => string = () => "",
  ) {}

  status(): { listening: boolean; port: number | null; https: boolean; error: string | null } {
    return { listening: this.listeningOn !== null, port: this.listeningOn, https: this.secure, error: this.lastError };
  }

  /** An instance for tests to send requests to without listening. */
  async instance(): Promise<FastifyInstance> {
    if (!this.app) {
      this.app = await this.build(this.certificate());
      await this.app.ready();
    }
    return this.app;
  }

  /** A renewed certificate takes effect without restarting the site. */
  async updateCertificate(files: { cert: string; key: string }): Promise<void> {
    if (this.secure && this.app) {
      (this.app.server as unknown as import("node:https").Server).setSecureContext({ cert: files.cert, key: files.key });
      return;
    }
    await this.sync();
  }

  async sync(): Promise<void> {
    if (!this.autoListen) return;
    const c = this.mm.config();
    const cert = c.enabled ? this.certificate() : null;
    const want = !c.enabled ? null : cert ? "https:443" : `http:${c.port}`;
    if (want === this.running && (want === null || this.app)) return;
    await this.close();
    if (want === null) return;
    const port = cert ? 443 : c.port;
    if (port === this.panelPort) {
      this.lastError = "The matchmaking site can't use the panel's own port.";
      return;
    }
    const app = await this.build(cert);
    try {
      await app.listen({ host: this.host, port });
      this.app = app;
      this.running = want;
      this.listeningOn = port;
      this.secure = !!cert;
      this.lastError = null;
    } catch (e) {
      await app.close().catch(() => undefined);
      this.lastError = listenError(e, port);
      return;
    }
    if (cert) await this.startRedirect();
  }

  /** Port 80: sends everyone to the https address. */
  private async startRedirect(): Promise<void> {
    const r = Fastify({ logger: false });
    r.all("/*", async (req, reply) => reply.redirect(`https://${this.domain() || hostOnly(req.headers.host)}${req.url}`, 301));
    try {
      await r.listen({ host: this.host, port: 80 });
      this.redirect = r;
    } catch (e) {
      await r.close().catch(() => undefined);
      // The https site still works; only plain http links don't forward.
      this.lastError = `HTTPS is on, but the redirect from http didn't start: ${listenError(e, 80)}`;
    }
  }

  async close(): Promise<void> {
    if (this.app) await this.app.close().catch(() => undefined);
    if (this.redirect) await this.redirect.close().catch(() => undefined);
    this.app = null;
    this.redirect = null;
    this.running = null;
    this.listeningOn = null;
    this.secure = false;
  }
}

function listenError(e: unknown, port: number): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") return `Port ${port} is already used by something else.`;
  if (code === "EACCES") return `The panel isn't allowed to use port ${port}. Run update.sh again so its service gets permission for ports below 1024.`;
  return (e as Error).message;
}
