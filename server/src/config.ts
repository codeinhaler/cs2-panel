import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(8080),
  ownerSteamId: z.string().regex(/^7656119\d{10}$/, "ownerSteamId must be a SteamID64"),
  secretKey: z.string().regex(/^[0-9a-f]{64}$/, "secretKey must be 64 hex characters"),
  dataDir: z.string().default("/var/lib/cs2-panel"),
  cs2Root: z.string().default("/srv/cs2"),
  instanceEnvDir: z.string().default("/etc/cs2-panel/instances"),
  cs2ctl: z.string().default("/usr/local/lib/cs2-panel/cs2ctl"),
  webDir: z.string().optional(),
  /** Development mode: fake host control, dev login, no real systemd. */
  dev: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema> & { webDir: string };

const here = path.dirname(fileURLToPath(import.meta.url));

/** Loads config from $CS2PANEL_CONFIG, or builds a dev config when CS2PANEL_DEV=1. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let raw: unknown;
  if (env.CS2PANEL_DEV === "1") {
    const root = path.resolve(env.CS2PANEL_DEV_DIR ?? ".dev-data");
    mkdirSync(root, { recursive: true });
    raw = {
      host: "127.0.0.1",
      port: Number(env.PORT ?? 8080),
      ownerSteamId: env.CS2PANEL_DEV_OWNER ?? "76561197960287930",
      secretKey: "0".repeat(64),
      dataDir: root,
      cs2Root: path.join(root, "cs2"),
      instanceEnvDir: path.join(root, "env"),
      cs2ctl: "/bin/false",
      dev: true,
    };
  } else {
    const file = env.CS2PANEL_CONFIG ?? "/etc/cs2-panel/panel.json";
    raw = JSON.parse(readFileSync(file, "utf8"));
  }
  const parsed = ConfigSchema.parse(raw);
  // In a release, the frontend sits next to server.mjs in ./web.
  const webDir = parsed.webDir ?? path.resolve(here, "web");
  return { ...parsed, webDir };
}
