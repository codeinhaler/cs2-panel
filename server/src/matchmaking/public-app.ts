import path from "node:path";
import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { HttpError, forbidden } from "../errors.js";
import { buildLoginUrl, verifyCallback } from "../auth/steam-openid.js";
import { fetchProfile } from "../auth/steam-profile.js";
import { MM_MAX_AGE_MS, MM_SESSION_COOKIE, type MmPlayerStore } from "./players.js";
import type { Matchmaking, MatchView } from "./service.js";

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
  const app = Fastify({ logger: { level: d.logLevel }, trustProxy: false, bodyLimit: 64 * 1024 });
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
    return { ...s, matches: s.matches.map((m) => withJoin(req, m)) };
  });

  // ------------------------------------------------------------- lobby

  app.post("/api/lobby/join", async (req) => {
    mm.join(requirePlayer(req));
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
  app.post("/api/matches/:id/start-now", async (req) => {
    await mm.startNow(requirePlayer(req), idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/matches/:id/cancel", async (req) => {
    await mm.cancelMatch(requirePlayer(req), idParam.parse(req.params).id);
    return { ok: true };
  });

  // ------------------------------------------------------------- the page

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
      return reply.header("Cache-Control", "no-cache").sendFile("play.html", d.webDir);
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
  private listeningOn: number | null = null;
  private lastError: string | null = null;
  /** Off in tests; the panel turns it on when it runs for real. */
  autoListen = false;

  constructor(
    private readonly build: () => Promise<FastifyInstance>,
    private readonly mm: Matchmaking,
    private readonly host: string,
    private readonly panelPort: number,
  ) {}

  status(): { listening: boolean; port: number | null; error: string | null } {
    return { listening: this.listeningOn !== null, port: this.listeningOn, error: this.lastError };
  }

  /** An instance for tests to send requests to without listening. */
  async instance(): Promise<FastifyInstance> {
    if (!this.app) {
      this.app = await this.build();
      await this.app.ready();
    }
    return this.app;
  }

  async sync(): Promise<void> {
    if (!this.autoListen) return;
    const c = this.mm.config();
    const want = c.enabled ? c.port : null;
    if (want === this.listeningOn && (want === null || this.app)) return;
    await this.close();
    if (want === null) return;
    if (want === this.panelPort) {
      this.lastError = "The matchmaking site can't use the panel's own port.";
      return;
    }
    const app = await this.build();
    try {
      await app.listen({ host: this.host, port: want });
      this.app = app;
      this.listeningOn = want;
      this.lastError = null;
    } catch (e) {
      await app.close().catch(() => undefined);
      this.lastError = (e as NodeJS.ErrnoException).code === "EADDRINUSE" ? `Port ${want} is already used by something else.` : (e as Error).message;
    }
  }

  async close(): Promise<void> {
    if (this.app) await this.app.close().catch(() => undefined);
    this.app = null;
    this.listeningOn = null;
  }
}
