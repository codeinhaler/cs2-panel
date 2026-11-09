import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { buildApp, type App } from "../src/app.js";
import { FakeHost, installFakeBase } from "../src/host/fake-host.js";
import type { Config } from "../src/config.js";
import { PaloAlto, parseResponse, type PanRequest } from "../src/tls/paloalto.js";
import type { CertFiles, IssueOptions } from "../src/tls/acme.js";

const OWNER = "76561198000000001";
const FP = Array.from({ length: 32 }, () => "AB").join(":");

/** A self-signed certificate standing in for Let's Encrypt's. */
function makeCert(dir: string, domain: string, days: number): CertFiles {
  const key = path.join(dir, `k-${domain}-${days}.pem`);
  const crt = path.join(dir, `c-${domain}-${days}.pem`);
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", String(days), "-subj", `/O=Test CA/CN=${domain}`],
    { stdio: "ignore" },
  );
  return { cert: readFileSync(crt, "utf8"), key: readFileSync(key, "utf8") };
}

describe("Palo Alto API", () => {
  it("reads PAN-OS answers with single quotes and spaces", () => {
    expect(parseResponse({ status: 200, body: "<response status = 'success'><result><key>LUFRPT1abc==</key></result></response>" }).ok).toBe(true);
    const err = parseResponse({ status: 200, body: "<response status = 'error' code = '403'><result><msg>Invalid Credential</msg></result></response>" });
    expect(err).toMatchObject({ ok: false, message: "Invalid Credential" });
    expect(parseResponse({ status: 200, body: "<html>login</html>" }).message).toMatch(/Unexpected answer from the firewall \(HTTP 200\): <html>login/);
  });

  it("sends the login as a form, not in the address", async () => {
    let seen: { query: Record<string, string>; body?: string; contentType?: string } | null = null;
    const pan = new PaloAlto("fw", FP, async ({ query, body, contentType }) => {
      seen = { query, body: body?.toString(), contentType };
      return { status: 200, body: "<response status = 'success'><result><key>KEY123</key></result></response>" };
    });
    expect(await pan.keygen("certbot", "p&ss word")).toBe("KEY123");
    expect(seen!.query).toEqual({ type: "keygen" });
    expect(seen!.contentType).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(seen!.body)).toEqual(new URLSearchParams({ user: "certbot", password: "p&ss word" }));
  });

  it("reads success and error answers", () => {
    expect(parseResponse({ status: 200, body: '<response status="success"><result><key>K</key></result></response>' }).ok).toBe(true);
    const err = parseResponse({ status: 200, body: '<response status="error"><msg><line>Invalid credentials.</line></msg></response>' });
    expect(err).toMatchObject({ ok: false, message: "Invalid credentials." });
    expect(parseResponse({ status: 403, body: "" }).message).toMatch(/refused the API key/);
  });

  it("imports the key pair with an encrypted key, then commits and waits for the job", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cs2panel-pan-"));
    const files = makeCert(dir, "en.fredagsspiller.dk", 90);
    const calls: { query: Record<string, string>; body?: string; contentType?: string }[] = [];
    let polls = 0;
    const req: PanRequest = async ({ query, body, contentType, fingerprint }) => {
      expect(fingerprint).toBe(FP);
      calls.push({ query, body: body?.toString(), contentType });
      if (query.type === "import") return { status: 200, body: '<response status="success"><msg>Successfully imported</msg></response>' };
      if (query.type === "commit") return { status: 200, body: '<response status="success" code="19"><result><job>42</job></result></response>' };
      polls++;
      const fin = polls >= 2;
      return {
        status: 200,
        body: `<response status="success"><result><job><status>${fin ? "FIN" : "ACT"}</status><result>${fin ? "OK" : "PEND"}</result></job></result></response>`,
      };
    };
    const pan = new PaloAlto("192.168.1.1", FP, req);
    await pan.importKeypair("KEY", "fredagsspiller", files.cert, files.key);
    const imp = calls[0]!;
    expect(imp.query).toMatchObject({ type: "import", category: "keypair", "certificate-name": "fredagsspiller", format: "pem", key: "KEY" });
    expect(imp.query.passphrase!.length).toBeGreaterThan(10);
    expect(imp.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(imp.body).toContain("-----BEGIN CERTIFICATE-----");
    expect(imp.body).toContain("-----BEGIN ENCRYPTED PRIVATE KEY-----");
    expect(imp.body).not.toContain("-----BEGIN PRIVATE KEY-----");

    expect(await pan.commit("KEY", "certbot", async () => undefined)).toBe("Commit job 42 finished.");
    expect(calls[1]!.query.cmd).toBe("<commit><partial><admin><member>certbot</member></admin></partial></commit>");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a failed commit", async () => {
    const req: PanRequest = async ({ query }) =>
      query.type === "commit"
        ? { status: 200, body: '<response status="success"><result><job>7</job></result></response>' }
        : {
            status: 200,
            body: '<response status="success"><result><job><status>FIN</status><result>FAIL</result><details><line>Validation error: bad rule</line></details></job></result></response>',
          };
    await expect(new PaloAlto("fw", FP, req).commit("KEY", "certbot", async () => undefined)).rejects.toThrow(/Validation error: bad rule/);
  });
});

describe("HTTPS for the matchmaking site", () => {
  let dir: string;
  let app: App;
  let cookie: string;
  let now: number;
  let issued: IssueOptions[];
  let nextCert: CertFiles;
  let panCalls: string[];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "cs2panel-tls-"));
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      ownerSteamId: OWNER,
      secretKey: "11".repeat(32),
      dataDir: dir,
      cs2Root: path.join(dir, "cs2"),
      instanceEnvDir: path.join(dir, "env"),
      cs2ctl: "/bin/false",
      webDir: path.join(dir, "no-web"),
      bridgeDir: path.join(dir, "no-bridge"),
      dev: true,
    };
    installFakeBase(config.cs2Root);
    now = Date.now();
    issued = [];
    panCalls = [];
    nextCert = makeCert(dir, "en.fredagsspiller.dk", 90);
    app = await buildApp({
      config,
      db: openDb(path.join(dir, "panel.db")),
      host: new FakeHost(config.cs2Root, config.instanceEnvDir),
      fetchFn: (async () => new Response("{}")) as typeof fetch,
      logLevel: "silent",
      pluginCheckDelayMs: 0,
      rcon: async () => "",
      tls: {
        now: () => now,
        issue: async (o) => {
          issued.push(o);
          await o.store.write(nextCert);
          return nextCert;
        },
        probe: async () => FP,
        sleep: async () => undefined,
        panRequest: async ({ query, body }) => {
          panCalls.push(query.type!);
          if (query.type === "keygen") {
            return new URLSearchParams(String(body ?? "")).get("password") === "secret"
              ? { status: 200, body: "<response status = 'success'><result><key>APIKEY</key></result></response>" }
              : { status: 200, body: "<response status = 'error' code = '403'><result><msg>Invalid Credential</msg></result></response>" };
          }
          if (query.type === "op" && query.cmd!.includes("<system>")) {
            return {
              status: 200,
              body: '<response status="success"><result><system><hostname>pa-440</hostname><sw-version>11.1.4</sw-version></system></result></response>',
            };
          }
          if (query.type === "import") return { status: 200, body: '<response status="success"><msg>ok</msg></response>' };
          if (query.type === "commit") return { status: 200, body: '<response status="success"><result><job>9</job></result></response>' };
          return { status: 200, body: '<response status="success"><result><job><status>FIN</status><result>OK</result></job></result></response>' };
        },
      },
    });
    const res = await app.fastify.inject({ method: "GET", url: `/api/auth/dev?steamId=${OWNER}` });
    cookie = `cs2p_session=${res.cookies.find((c) => c.name === "cs2p_session")!.value}`;
  });

  afterEach(async () => {
    await app.fastify.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.fastify.inject({ method: method as "GET", url, headers: { cookie }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  };
  const https = { enabled: true, domain: "en.fredagsspiller.dk", email: "admin@fredagsspiller.dk", staging: false };

  it("gets a certificate through Cloudflare, sends it to the firewall and commits", async () => {
    expect((await call("PUT", "/api/tls/https", { settings: { ...https, domain: "" } })).body.error).toMatch(/domain and email/);
    expect((await call("PUT", "/api/tls/https", { settings: { ...https, domain: "not a domain" } })).status).toBe(400);
    const saved = await call("PUT", "/api/tls/https", { settings: https, cloudflareToken: "cf_" + "x".repeat(37) });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ cloudflareTokenSet: true, active: false, cert: null });
    // The token is stored sealed, not in plain text.
    const db = (app.services.servers as any).store.db;
    expect(JSON.stringify(db.prepare("SELECT * FROM settings").all())).not.toContain("cf_xxxx");

    // Firewall: address, confirm its certificate, log in once (the password isn't kept).
    await call("PUT", "/api/tls/firewall", { settings: { enabled: true, host: "192.168.1.1", certName: "fredagsspiller", commit: true } });
    expect((await call("POST", "/api/tls/firewall/probe")).body.fingerprint).toBe(FP);
    expect((await call("POST", "/api/tls/firewall/connect", { fingerprint: FP, user: "certbot", password: "wrong" })).body.error).toMatch(/Invalid Credential/);
    const conn = await call("POST", "/api/tls/firewall/connect", { fingerprint: FP, user: "certbot", password: "secret" });
    expect(conn.body).toMatchObject({
      info: { hostname: "pa-440", version: "11.1.4" },
      firewallKeySet: true,
      firewallAdmin: "certbot",
      firewallFingerprint: FP,
    });
    expect(JSON.stringify(db.prepare("SELECT * FROM settings").all())).not.toContain("secret");

    // No certificate yet when connecting: nothing to send.
    expect(conn.body.lastPush).toBeNull();

    panCalls = [];
    const renewed = await call("POST", "/api/tls/renew");
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    expect(issued[0]).toMatchObject({
      domain: "en.fredagsspiller.dk",
      email: "admin@fredagsspiller.dk",
      staging: false,
      cloudflareToken: "cf_" + "x".repeat(37),
    });
    expect(renewed.body).toMatchObject({ active: true, cert: { domain: "en.fredagsspiller.dk" }, lastRenew: { ok: true }, lastPush: { ok: true } });
    expect(renewed.body.lastPush.message).toBe('Imported as "fredagsspiller". Commit job 9 finished.');
    expect(panCalls).toEqual(["import", "commit", "op"]);
    // The key file is only readable by the panel.
    expect(statSync(path.join(dir, "tls", "privkey.pem")).mode & 0o777).toBe(0o600);
    expect(app.services.tls.active()?.cert).toBe(nextCert.cert);
  });

  it("renews when fewer than 30 days are left, and not before", async () => {
    await call("PUT", "/api/tls/https", { settings: https, cloudflareToken: "cf_" + "x".repeat(37) });
    await app.services.tls.check();
    expect(issued).toHaveLength(1); // no certificate yet
    await app.services.tls.check();
    expect(issued).toHaveLength(1); // 90 days left

    now += 70 * 86_400_000;
    await app.services.tls.check();
    expect(issued).toHaveLength(2);
    expect(app.services.tls.status().lastRenew?.ok).toBe(true);

    // A failure is recorded and tried again next time.
    nextCert = { cert: "not a cert", key: "x" };
    now += 70 * 86_400_000;
    await app.services.tls.check();
    expect(app.services.tls.status().lastRenew).toMatchObject({ ok: false });
  });

  it("doesn't serve a certificate for another domain", async () => {
    nextCert = makeCert(dir, "old.example.com", 90);
    await call("PUT", "/api/tls/https", { settings: https, cloudflareToken: "cf_" + "x".repeat(37) });
    await call("POST", "/api/tls/renew");
    expect(app.services.tls.active()).toBeNull();
    expect((await call("POST", "/api/tls/firewall/push")).body.error).toMatch(/Connect to the firewall first/);
  });

  it("sends the existing certificate as soon as the firewall is connected", async () => {
    await call("PUT", "/api/tls/https", { settings: https, cloudflareToken: "cf_" + "x".repeat(37) });
    await call("POST", "/api/tls/renew");
    await call("PUT", "/api/tls/firewall", { settings: { enabled: true, host: "10.10.10.1", certName: "enfredagsspillerdk", commit: true } });
    panCalls = [];
    const conn = await call("POST", "/api/tls/firewall/connect", { fingerprint: FP, user: "cs2panel", password: "secret" });
    expect(conn.body.lastPush).toMatchObject({ ok: true, message: 'Imported as "enfredagsspillerdk". Commit job 9 finished.' });
    expect(panCalls).toEqual(["keygen", "op", "import", "commit", "op"]);
  });
});
