import { z } from "zod";
import type { AuditLog } from "../audit.js";
import type { SecretBox } from "../crypto.js";
import { badRequest } from "../errors.js";
import type { Settings } from "../settings.js";
import { CertStore, describeCert, issueCertificate, type CertFiles, type CertInfo, type IssueOptions } from "./acme.js";
import { PaloAlto, panRequest, probeFingerprint, type PanRequest } from "./paloalto.js";

/** Renew when fewer than this many days are left (Let's Encrypt certificates last 90). */
const RENEW_DAYS = 30;
const CHECK_MS = 6 * 60 * 60_000;

export const HttpsSettingsSchema = z.object({
  enabled: z.boolean(),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^$|^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, "Enter a domain name like en.fredagsspiller.dk."),
  email: z
    .string()
    .trim()
    .max(200)
    .regex(/^$|^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Enter an email address (Let's Encrypt sends expiry warnings there)."),
  /** Let's Encrypt's test CA: for trying things out without hitting rate limits. */
  staging: z.boolean(),
});
export type HttpsSettings = z.infer<typeof HttpsSettingsSchema>;
const DEFAULT_HTTPS: HttpsSettings = { enabled: false, domain: "", email: "", staging: false };

export const FirewallSettingsSchema = z.object({
  enabled: z.boolean(),
  host: z
    .string()
    .trim()
    .max(253)
    .regex(/^$|^[A-Za-z0-9.-]+(:\d{1,5})?$/, "Enter the firewall's management address, like 192.168.1.1."),
  /** Name of the certificate on the firewall; the inbound decryption rule refers to it. */
  certName: z
    .string()
    .trim()
    .max(31)
    .regex(/^$|^[A-Za-z0-9._-]+$/, "Certificate names can use letters, digits, dot, dash and underscore (at most 31)."),
  commit: z.boolean(),
});
export type FirewallSettings = z.infer<typeof FirewallSettingsSchema>;
const DEFAULT_FIREWALL: FirewallSettings = { enabled: false, host: "", certName: "fredagsspiller", commit: true };

interface FirewallState {
  /** Pinned SHA-256 of the firewall's management certificate. */
  fingerprint: string | null;
  /** The admin the API key belongs to; partial commits are for this admin. */
  admin: string | null;
  apiKey: string | null; // sealed
}

export interface Outcome {
  at: string;
  ok: boolean;
  message: string;
}

export interface TlsDeps {
  settings: Settings;
  box: SecretBox;
  audit: AuditLog;
  store: CertStore;
  fetchFn: typeof fetch;
  now?: () => number;
  /** Tests replace these. */
  issue?: (o: IssueOptions) => Promise<CertFiles>;
  panRequest?: PanRequest;
  probe?: (host: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

/** The site's HTTPS certificate: getting and renewing it, and sending it to the Palo Alto. */
export class TlsService {
  private lastRenew: Outcome | null = null;
  private lastPush: Outcome | null = null;
  private busy: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private cert: CertFiles | null = null;
  /** Called with the new certificate, so the site can start using it right away. */
  onCertificate: (files: CertFiles) => Promise<void> = async () => undefined;
  private readonly now: () => number;

  constructor(private readonly d: TlsDeps) {
    this.now = d.now ?? Date.now;
  }

  // ------------------------------------------------------------- settings

  https(): HttpsSettings {
    return { ...DEFAULT_HTTPS, ...this.d.settings.get<Partial<HttpsSettings>>("tls.https", {}) };
  }

  firewall(): FirewallSettings {
    return { ...DEFAULT_FIREWALL, ...this.d.settings.get<Partial<FirewallSettings>>("tls.firewall", {}) };
  }

  private fwState(): FirewallState {
    return { fingerprint: null, admin: null, apiKey: null, ...this.d.settings.get<Partial<FirewallState>>("tls.firewallState", {}) };
  }

  private cloudflareToken(): string | null {
    try {
      return this.d.box.openOptional(this.d.settings.get<string | null>("tls.cloudflareToken", null));
    } catch {
      return null;
    }
  }

  private apiKey(): string | null {
    try {
      return this.d.box.openOptional(this.fwState().apiKey);
    } catch {
      return null;
    }
  }

  async load(): Promise<void> {
    this.cert = await this.d.store.read();
  }

  /** The certificate to serve, when HTTPS is on and there is one for the configured domain. */
  active(): CertFiles | null {
    const h = this.https();
    if (!h.enabled || !this.cert) return null;
    try {
      return describeCert(this.cert.cert).domain === h.domain ? this.cert : null;
    } catch {
      return null;
    }
  }

  certInfo(): CertInfo | null {
    if (!this.cert) return null;
    try {
      return describeCert(this.cert.cert);
    } catch {
      return null;
    }
  }

  status() {
    const fw = this.fwState();
    return {
      https: this.https(),
      cloudflareTokenSet: !!this.cloudflareToken(),
      cert: this.certInfo(),
      active: !!this.active(),
      lastRenew: this.lastRenew,
      firewall: this.firewall(),
      firewallFingerprint: fw.fingerprint,
      firewallAdmin: fw.admin,
      firewallKeySet: !!this.apiKey(),
      lastPush: this.lastPush,
      working: !!this.busy,
    };
  }

  saveHttps(raw: unknown, cloudflareToken: string | null | undefined, actorId: number): void {
    const next = HttpsSettingsSchema.parse(raw);
    if (next.enabled && (!next.domain || !next.email)) throw badRequest("Fill in the domain and email before switching HTTPS on.");
    this.d.settings.set("tls.https", next);
    if (cloudflareToken !== undefined) {
      const t = cloudflareToken?.trim() || null;
      if (t && !/^[\w-]{20,200}$/.test(t)) throw badRequest("That doesn't look like a Cloudflare API token.");
      this.d.settings.set("tls.cloudflareToken", this.d.box.sealOptional(t));
    }
    this.d.audit.record(actorId, "tls.settings", null, {
      enabled: next.enabled,
      domain: next.domain,
      staging: next.staging,
      ...(cloudflareToken !== undefined ? { cloudflareToken: cloudflareToken ? "changed" : "removed" } : {}),
    });
  }

  saveFirewall(raw: unknown, actorId: number): void {
    const next = FirewallSettingsSchema.parse(raw);
    if (next.enabled && (!next.host || !next.certName)) throw badRequest("Fill in the firewall address and the certificate name first.");
    const before = this.firewall();
    if (before.host !== next.host) this.d.settings.set("tls.firewallState", { fingerprint: null, admin: null, apiKey: null });
    this.d.settings.set("tls.firewall", next);
    this.d.audit.record(actorId, "tls.firewall", null, { enabled: next.enabled, host: next.host, certName: next.certName, commit: next.commit });
  }

  // ------------------------------------------------------------- firewall connection

  /** Step 1: what certificate the firewall shows, for the admin to compare with the firewall's own. */
  async probe(): Promise<string> {
    const host = this.firewall().host;
    if (!host) throw badRequest("Save the firewall's address first.");
    return (this.d.probe ?? probeFingerprint)(host);
  }

  /** Step 2: trust that fingerprint, and swap the admin's username and password for an API key (the password isn't stored). */
  async connect(fingerprint: string, user: string, password: string, actorId: number): Promise<{ hostname: string | null; version: string | null }> {
    const host = this.firewall().host;
    if (!host) throw badRequest("Save the firewall's address first.");
    if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(fingerprint)) throw badRequest("That isn't a SHA-256 fingerprint.");
    const pan = new PaloAlto(host, fingerprint, this.d.panRequest ?? panRequest);
    let key: string;
    try {
      key = await pan.keygen(user, password);
    } catch (e) {
      throw badRequest(`The firewall said: ${(e as Error).message}`);
    }
    const info = await pan.systemInfo(key);
    this.d.settings.set("tls.firewallState", { fingerprint: fingerprint.toUpperCase(), admin: user, apiKey: this.d.box.sealOptional(key) });
    this.d.audit.record(actorId, "tls.firewall.connect", null, { host, admin: user, hostname: info.hostname, version: info.version });
    return info;
  }

  forgetFirewall(actorId: number): void {
    this.d.settings.set("tls.firewallState", { fingerprint: null, admin: null, apiKey: null });
    this.d.audit.record(actorId, "tls.firewall.forget", null, {});
  }

  // ------------------------------------------------------------- renewing and pushing

  private exclusive(fn: () => Promise<void>): Promise<void> {
    if (this.busy) throw badRequest("Already working on the certificate. Wait a moment.");
    this.busy = fn().finally(() => (this.busy = null));
    return this.busy;
  }

  /** Gets a new certificate now (also used by the renewal timer). */
  renew(actorId: number | null, why = "by hand"): Promise<void> {
    return this.exclusive(async () => {
      const h = this.https();
      const token = this.cloudflareToken();
      try {
        if (!h.domain || !h.email) throw new Error("Fill in the domain and email first.");
        if (!token) throw new Error("Add a Cloudflare API token first.");
        const files = await (this.d.issue ?? issueCertificate)({
          domain: h.domain,
          email: h.email,
          staging: h.staging,
          cloudflareToken: token,
          store: this.d.store,
          fetchFn: this.d.fetchFn,
        });
        this.cert = files;
        const info = describeCert(files.cert);
        this.lastRenew = {
          at: new Date(this.now()).toISOString(),
          ok: true,
          message: `Valid until ${info.notAfter.slice(0, 10)}${info.staging ? " (test certificate)" : ""}.`,
        };
        this.d.audit.record(actorId, "tls.renewed", null, { domain: h.domain, notAfter: info.notAfter, staging: info.staging, why });
        await this.onCertificate(files).catch(() => undefined);
      } catch (e) {
        this.lastRenew = { at: new Date(this.now()).toISOString(), ok: false, message: (e as Error).message };
        this.d.audit.record(actorId, "tls.renew-failed", null, { domain: h.domain, reason: (e as Error).message, why });
        throw badRequest(`Couldn't get a certificate: ${(e as Error).message}`);
      }
      if (this.firewall().enabled) await this.pushNow(actorId).catch(() => undefined);
    });
  }

  /** Sends the current certificate to the firewall (and commits, if set to). */
  push(actorId: number | null): Promise<void> {
    return this.exclusive(() => this.pushNow(actorId));
  }

  private async pushNow(actorId: number | null): Promise<void> {
    const fw = this.firewall();
    const st = this.fwState();
    const key = this.apiKey();
    try {
      if (!this.cert) throw new Error("There's no certificate yet.");
      if (!fw.host || !st.fingerprint || !key || !st.admin) throw new Error("Connect to the firewall first.");
      const pan = new PaloAlto(fw.host, st.fingerprint, this.d.panRequest ?? panRequest);
      await pan.importKeypair(key, fw.certName, this.cert.cert, this.cert.key);
      let msg = `Imported as "${fw.certName}".`;
      if (fw.commit) msg += ` ${await pan.commit(key, st.admin, this.d.sleep)}`;
      else msg += " Not committed (commit by hand).";
      this.lastPush = { at: new Date(this.now()).toISOString(), ok: true, message: msg };
      this.d.audit.record(actorId, "tls.pushed", null, { host: fw.host, certName: fw.certName, committed: fw.commit });
    } catch (e) {
      this.lastPush = { at: new Date(this.now()).toISOString(), ok: false, message: (e as Error).message };
      this.d.audit.record(actorId, "tls.push-failed", null, { host: fw.host, reason: (e as Error).message });
      throw badRequest(`Couldn't send the certificate to the firewall: ${(e as Error).message}`);
    }
  }

  /** Renews when the certificate is missing or has fewer than 30 days left. Runs every 6 hours. */
  async check(): Promise<void> {
    const h = this.https();
    if (!h.enabled || this.busy || !h.domain || !this.cloudflareToken()) return;
    const info = this.certInfo();
    const daysLeft = info ? (Date.parse(info.notAfter) - this.now()) / 86_400_000 : -1;
    const wrongDomain = info?.domain !== h.domain || info?.staging !== h.staging;
    if (daysLeft > RENEW_DAYS && !wrongDomain) return;
    await this.renew(null, info ? (wrongDomain ? "domain changed" : `${Math.floor(daysLeft)} days left`) : "no certificate yet").catch(() => undefined);
  }

  start(): void {
    if (this.timer) return;
    setTimeout(() => void this.check(), 30_000).unref();
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
