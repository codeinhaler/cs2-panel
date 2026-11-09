import https from "node:https";
import { createPrivateKey, randomBytes } from "node:crypto";
import type { TLSSocket } from "node:tls";

/**
 * Talks to a Palo Alto firewall's XML API over the LAN: gets an API key,
 * imports the site's certificate and key (for inbound SSL inspection) and
 * commits. The firewall's management certificate is usually self-signed, so
 * instead of normal certificate checks the panel pins its SHA-256 fingerprint,
 * which the admin confirms once.
 */

export interface PanResult {
  status: number;
  body: string;
}

export type PanRequest = (opts: {
  host: string;
  fingerprint: string | null;
  method: "GET" | "POST";
  query: Record<string, string>;
  body?: Buffer;
  contentType?: string;
}) => Promise<PanResult>;

const normFp = (fp: string) => fp.replace(/[^0-9a-f]/gi, "").toUpperCase();

/** Real requests. With no fingerprint, only `probe` is allowed. */
export const panRequest: PanRequest = ({ host, fingerprint, method, query, body, contentType }) =>
  new Promise((resolve, reject) => {
    if (!fingerprint) return reject(new Error("Confirm the firewall's certificate first."));
    const req = https.request(
      {
        host: host.replace(/:\d+$/, ""),
        port: Number(/:(\d+)$/.exec(host)?.[1] ?? 443),
        path: `/api/?${new URLSearchParams(query).toString()}`,
        method,
        headers: body ? { "Content-Type": contentType ?? "application/octet-stream", "Content-Length": body.length } : {},
        rejectUnauthorized: false,
        timeout: 60_000,
        checkServerIdentity: (_h, cert) =>
          normFp(cert.fingerprint256) === normFp(fingerprint) ? undefined : new Error("The firewall's certificate changed. Confirm it again on the panel."),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("The firewall didn't answer.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

/** The SHA-256 fingerprint of the certificate the firewall presents, so the admin can confirm it. */
export function probeFingerprint(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: host.replace(/:\d+$/, ""),
      port: Number(/:(\d+)$/.exec(host)?.[1] ?? 443),
      path: "/",
      method: "HEAD",
      rejectUnauthorized: false,
      timeout: 10_000,
    });
    req.on("socket", (s: TLSSocket) =>
      s.on("secureConnect", () => {
        const cert = s.getPeerCertificate();
        req.destroy();
        if (cert?.fingerprint256) resolve(normFp(cert.fingerprint256).replace(/(..)(?!$)/g, "$1:"));
        else reject(new Error("The firewall didn't present a certificate."));
      }),
    );
    req.on("timeout", () => req.destroy(new Error(`${host} didn't answer on HTTPS.`)));
    req.on("error", (e) => {
      if (!/socket hang up|aborted/.test(e.message)) reject(new Error(`Couldn't reach ${host}: ${e.message}`));
    });
    req.end();
  });
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** "success" or the firewall's own error text. */
export function parseResponse(r: PanResult): { ok: boolean; message: string; body: string } {
  // PAN-OS writes status = 'success' (single quotes, spaces); accept either quote style.
  const status = /<response[^>]*?\bstatus\s*=\s*["'](\w+)["']/.exec(r.body)?.[1];
  const lines = [...r.body.matchAll(/<(?:line|msg)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:line|msg)>/g)]
    .map((m) => unescapeXml(m[1]!.replace(/<[^>]+>/g, " ").trim()))
    .filter(Boolean);
  if (r.status === 403) return { ok: false, message: "The firewall refused the API key.", body: r.body };
  if (status === "success") return { ok: true, message: lines.join(" "), body: r.body };
  const snippet = r.body.replace(/\s+/g, " ").trim().slice(0, 200);
  return { ok: false, message: lines.join(" ") || `Unexpected answer from the firewall (HTTP ${r.status})${snippet ? `: ${snippet}` : ""}`, body: r.body };
}

export class PaloAlto {
  constructor(
    private readonly host: string,
    private readonly fingerprint: string | null,
    private readonly request: PanRequest = panRequest,
  ) {}

  private async call(query: Record<string, string>, body?: Buffer, contentType?: string) {
    const r = parseResponse(await this.request({ host: this.host, fingerprint: this.fingerprint, method: body ? "POST" : "GET", query, body, contentType }));
    if (!r.ok) throw new Error(r.message);
    return r;
  }

  /** Swaps a username and password for an API key. The password isn't kept. */
  async keygen(user: string, password: string): Promise<string> {
    const r = await this.call({ type: "keygen" }, Buffer.from(new URLSearchParams({ user, password }).toString()), "application/x-www-form-urlencoded");
    const key = /<key>([^<]+)<\/key>/.exec(r.body)?.[1];
    if (!key) throw new Error("The firewall didn't return an API key.");
    return key;
  }

  /** Checks that the key works; returns the PAN-OS version. */
  async systemInfo(key: string): Promise<{ hostname: string | null; version: string | null }> {
    const r = await this.call({ type: "op", cmd: "<show><system><info></info></system></show>", key });
    return { hostname: /<hostname>([^<]*)<\/hostname>/.exec(r.body)?.[1] ?? null, version: /<sw-version>([^<]*)<\/sw-version>/.exec(r.body)?.[1] ?? null };
  }

  /**
   * Imports the certificate and private key under one name, replacing what's
   * there. The firewall wants the key encrypted, so it's encrypted with a
   * one-off passphrase for the upload.
   */
  async importKeypair(key: string, certName: string, certPem: string, keyPem: string): Promise<void> {
    const passphrase = randomBytes(18).toString("base64url");
    const encrypted = createPrivateKey(keyPem).export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }) as string;
    const boundary = `----cs2panel${randomBytes(8).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${certName}.pem"\r\nContent-Type: application/x-pem-file\r\n\r\n`),
      Buffer.from(`${certPem.trim()}\n${encrypted.trim()}\n`),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await this.call(
      { type: "import", category: "keypair", "certificate-name": certName, format: "pem", passphrase, key },
      body,
      `multipart/form-data; boundary=${boundary}`,
    );
  }

  /** Commits only this admin's changes and waits for the job to finish. */
  async commit(key: string, admin: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
    const esc = admin.replace(/[<>&"']/g, "");
    const r = await this.call({ type: "commit", cmd: `<commit><partial><admin><member>${esc}</member></admin></partial></commit>`, key });
    const job = /<job>(\d+)<\/job>/.exec(r.body)?.[1];
    if (!job) return r.message || "Nothing to commit.";
    for (let i = 0; i < 120; i++) {
      await sleep(5000);
      const s = await this.call({ type: "op", cmd: `<show><jobs><id>${job}</id></jobs></show>`, key });
      const status = /<status>(\w+)<\/status>/.exec(s.body)?.[1];
      if (status !== "FIN") continue;
      const result = /<result>(\w+)<\/result>/.exec(s.body)?.[1];
      const details = [...s.body.matchAll(/<line>([\s\S]*?)<\/line>/g)].map((m) => unescapeXml(m[1]!.replace(/<[^>]+>/g, " ").trim())).filter(Boolean);
      if (result === "OK") return `Commit job ${job} finished.`;
      throw new Error(`The commit failed: ${details.join(" ") || result}`);
    }
    throw new Error(`Commit job ${job} didn't finish within 10 minutes. Check the firewall's task manager.`);
  }
}
