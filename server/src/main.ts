import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { buildApp } from "./app.js";
import { SystemHost } from "./host/system-host.js";
import { FakeHost, installFakeBase } from "./host/fake-host.js";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = openDb(path.join(config.dataDir, "panel.db"));

let host;
if (config.dev) {
  console.warn("cs2-panel running in DEVELOPMENT mode: systemd is simulated and /api/auth/dev is enabled.");
  if (process.env.CS2PANEL_DEV_FAKE_BASE === "1") installFakeBase(config.cs2Root);
  host = new FakeHost(config.cs2Root, config.instanceEnvDir);
} else {
  host = new SystemHost(config.cs2ctl, config.cs2Root);
}

const { fastify, services } = await buildApp({ config, db, host });
services.players.startPolling();
services.automation.start();
await services.matchmaking.recover();
services.tls.start();
services.matchmaking.start();

const shutdown = async () => {
  services.players.stopPolling();
  services.automation.stop();
  services.matchmaking.stop();
  services.tls.stop();
  await services.publicSite.close();
  await fastify.close();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await fastify.listen({ host: config.host, port: config.port });
console.log(`cs2-panel listening on http://${config.host}:${config.port}`);

// The matchmaking site for players, on its own port, when it's switched on.
services.publicSite.autoListen = true;
await services.publicSite.sync();
const site = services.publicSite.status();
if (site.listening) console.log(`matchmaking site listening on http://${config.host}:${site.port}`);
else if (site.error) console.warn(`matchmaking site: ${site.error}`);
