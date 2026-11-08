import { promises as fs } from "node:fs";
import { X509Certificate } from "node:crypto";
import { Resolver } from "node:dns/promises";
import path from "node:path";
import * as acme from "acme-client";

/**
 * Let's Encrypt certificates for the matchmaking site, proven with a DNS
 * record at Cloudflare (DNS-01), so port 80 doesn't have to be open for it.
 */

export const LE_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
export const LE_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

export interface CertFiles {
  cert: string;
  key: string;
}

export interface CertInfo {
  domain: string | null;
  issuer: string;
  notBefore: string;
  notAfter: string;
  /** Let's Encrypt's test CA, which browsers don't trust. */
  staging: boolean;
}

export function describeCert(pem: string): CertInfo {
  const x = new X509Certificate(pem);
  const cn = /CN=([^\n,]+)/.exec(x.subject)?.[1] ?? null;
  return {
    domain: cn,
    issuer: /O=([^\n,]+)/.exec(x.issuer)?.[1] ?? x.issuer,
    notBefore: new Date(x.validFrom).toISOString(),
    notAfter: new Date(x.validTo).toISOString(),
    staging: /STAGING|Fake|\(STAGING\)/i.test(x.issuer),
  };
}

/** Where the certificate, its key and the Let's Encrypt account key live (key files readable only by the panel). */
export class CertStore {
  constructor(private readonly dir: string) {}

  private file = (name: string) => path.join(this.dir, name);

  async read(): Promise<CertFiles | null> {
    try {
      return { cert: await fs.readFile(this.file("fullchain.pem"), "utf8"), key: await fs.readFile(this.file("privkey.pem"), "utf8") };
    } catch {
      return null;
    }
  }

  async write(files: CertFiles): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const [name, content, mode] of [
      ["privkey.pem", files.key, 0o600],
      ["fullchain.pem", files.cert, 0o644],
    ] as const) {
      await fs.writeFile(this.file(`${name}.tmp`), content, { mode });
      await fs.rename(this.file(`${name}.tmp`), this.file(name));
    }
  }

  async accountKey(staging: boolean): Promise<Buffer> {
    const name = staging ? "account-staging.key" : "account.key";
    try {
      return await fs.readFile(this.file(name));
    } catch {
      const key = await acme.crypto.createPrivateRsaKey(2048);
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(this.file(name), key, { mode: 0o600 });
      return key;
    }
  }
}

// ------------------------------------------------------------- Cloudflare

const CF = "https://api.cloudflare.com/client/v4";

export class CloudflareDns {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch,
  ) {}

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${CF}${url}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message?: string }[] };
    if (!res.ok || !data.success) {
      const msg =
        data.errors
          ?.map((e) => e.message)
          .filter(Boolean)
          .join("; ") || `HTTP ${res.status}`;
      throw new Error(res.status === 401 || res.status === 403 ? `Cloudflare refused the API token (${msg}).` : `Cloudflare: ${msg}`);
    }
    return data.result as T;
  }

  /** The zone that holds a name: tries en.fredagsspiller.dk, then fredagsspiller.dk. */
  async zoneFor(name: string): Promise<{ id: string; name: string }> {
    const parts = name.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join(".");
      const zones = await this.call<{ id: string; name: string }[]>("GET", `/zones?name=${encodeURIComponent(candidate)}`);
      if (zones[0]) return zones[0];
    }
    throw new Error(`The Cloudflare token has no access to a zone for ${name}. Give it Zone → DNS → Edit for that domain.`);
  }

  async createTxt(zoneId: string, name: string, content: string): Promise<string> {
    const r = await this.call<{ id: string }>("POST", `/zones/${zoneId}/dns_records`, { type: "TXT", name, content, ttl: 60 });
    return r.id;
  }

  async deleteRecord(zoneId: string, id: string): Promise<void> {
    await this.call("DELETE", `/zones/${zoneId}/dns_records/${id}`);
  }
}

// ------------------------------------------------------------- getting a certificate

export interface IssueOptions {
  domain: string;
  email: string;
  staging: boolean;
  cloudflareToken: string;
  store: CertStore;
  fetchFn: typeof fetch;
  log?: (line: string) => void;
  /** Tests replace these. */
  acmeClient?: (opts: { directoryUrl: string; accountKey: Buffer }) => Pick<acme.Client, "auto">;
  waitForTxt?: (name: string, value: string) => Promise<void>;
}

/** Waits until Cloudflare's own resolvers serve the TXT record, so Let's Encrypt finds it. */
export async function waitForTxt(name: string, value: string, timeoutMs = 180_000): Promise<void> {
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "1.0.0.1"]);
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const records = await resolver.resolveTxt(name);
      if (records.some((r) => r.join("") === value)) return;
    } catch {
      /* not there yet */
    }
    if (Date.now() > until) throw new Error(`The DNS record ${name} didn't show up within ${Math.round(timeoutMs / 1000)} seconds.`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function issueCertificate(o: IssueOptions): Promise<CertFiles> {
  const log = o.log ?? (() => undefined);
  const cf = new CloudflareDns(o.cloudflareToken, o.fetchFn);
  const zone = await cf.zoneFor(o.domain);
  const accountKey = await o.store.accountKey(o.staging);
  const directoryUrl = o.staging ? LE_STAGING : LE_PRODUCTION;
  const client = o.acmeClient ? o.acmeClient({ directoryUrl, accountKey }) : new acme.Client({ directoryUrl, accountKey });
  // RSA keys work with every Palo Alto version.
  const [key, csr] = await acme.crypto.createCsr({ commonName: o.domain, altNames: [o.domain] });
  const records = new Map<string, string>();
  const wait = o.waitForTxt ?? ((n: string, v: string) => waitForTxt(n, v));

  const cert = await client.auto({
    csr,
    email: o.email,
    termsOfServiceAgreed: true,
    challengePriority: ["dns-01"],
    // We wait for the record ourselves, against Cloudflare's resolvers.
    skipChallengeVerification: true,
    challengeCreateFn: async (authz, _challenge, keyAuthorization) => {
      const name = `_acme-challenge.${authz.identifier.value}`;
      log(`Adding ${name} at Cloudflare`);
      records.set(keyAuthorization, await cf.createTxt(zone.id, name, keyAuthorization));
      await wait(name, keyAuthorization);
    },
    challengeRemoveFn: async (_authz, _challenge, keyAuthorization) => {
      const id = records.get(keyAuthorization);
      if (id) await cf.deleteRecord(zone.id, id).catch(() => undefined);
    },
  });
  const files = { cert, key: key.toString() };
  await o.store.write(files);
  return files;
}
