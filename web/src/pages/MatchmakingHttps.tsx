import { useEffect, useState } from "react";
import { useAction, useApp, usePolling } from "../app-context";
import { formatDateTime } from "../format";

interface Outcome {
  at: string;
  ok: boolean;
  message: string;
}

interface TlsStatus {
  https: { enabled: boolean; domain: string; email: string; staging: boolean };
  cloudflareTokenSet: boolean;
  cert: { domain: string | null; issuer: string; notBefore: string; notAfter: string; staging: boolean } | null;
  active: boolean;
  lastRenew: Outcome | null;
  firewall: { enabled: boolean; host: string; certName: string; commit: boolean };
  firewallFingerprint: string | null;
  firewallAdmin: string | null;
  firewallKeySet: boolean;
  lastPush: Outcome | null;
  working: boolean;
  site?: { listening: boolean; port: number | null; https: boolean; error: string | null };
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

function OutcomeLine({ label, o }: { label: string; o: Outcome | null }) {
  if (!o) return null;
  return (
    <p className={`notice ${o.ok ? "ok" : "error"}`} style={{ margin: "10px 0 0" }}>
      {label} {formatDateTime(new Date(o.at))}: {o.message}
    </p>
  );
}

/** HTTPS for the matchmaking site (Let's Encrypt via Cloudflare) and sending the certificate to a Palo Alto. */
export function HttpsSettings({ manage }: { manage: boolean }) {
  const { toast } = useApp();
  const { busy, run } = useAction();
  const { data, refresh } = usePolling(() => call<TlsStatus>("GET", "/api/tls"), 5000);
  const [h, setH] = useState<TlsStatus["https"] | null>(null);
  const [fw, setFw] = useState<TlsStatus["firewall"] | null>(null);
  const [token, setToken] = useState("");
  const [probe, setProbe] = useState<string | null>(null);
  const [login, setLogin] = useState({ user: "", password: "" });

  useEffect(() => {
    if (data && !h) setH(data.https);
    if (data && !fw) setFw(data.firewall);
  }, [data, h, fw]);
  if (!data || !h || !fw) return null;

  const saveHttps = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => call<TlsStatus>("PUT", "/api/tls/https", { settings: h, ...(token ? { cloudflareToken: token } : {}) }), "HTTPS settings saved.");
    if (r) {
      setToken("");
      setH(r.https);
      void refresh();
    }
  };
  const renew = async () => {
    toast("Asking Let's Encrypt. This takes a minute or two while the DNS record spreads.", "info");
    if (await run(() => call<TlsStatus>("POST", "/api/tls/renew"), "Certificate ready.")) void refresh();
  };
  const saveFw = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => call<TlsStatus>("PUT", "/api/tls/firewall", { settings: fw }), "Firewall settings saved.");
    if (r) {
      setFw(r.firewall);
      void refresh();
    }
  };
  const checkFw = async () => {
    const r = await run(() => call<{ fingerprint: string }>("POST", "/api/tls/firewall/probe"));
    if (r) setProbe(r.fingerprint);
  };
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() =>
      call<TlsStatus & { info: { hostname: string | null; version: string | null } }>("POST", "/api/tls/firewall/connect", { fingerprint: probe, ...login }),
    );
    if (r) {
      toast(`Connected to ${r.info.hostname ?? "the firewall"}${r.info.version ? ` (PAN-OS ${r.info.version})` : ""}.`, "ok");
      setProbe(null);
      setLogin({ user: "", password: "" });
      void refresh();
    }
  };
  const forget = async () => {
    if (await run(() => call("POST", "/api/tls/firewall/forget"), "Firewall connection removed.")) void refresh();
  };
  const push = async () => {
    if (await run(() => call("POST", "/api/tls/firewall/push"), "Certificate sent to the firewall.")) void refresh();
  };

  const hDirty = JSON.stringify(h) !== JSON.stringify(data.https) || !!token;
  const fwDirty = JSON.stringify(fw) !== JSON.stringify(data.firewall);
  const daysLeft = data.cert ? Math.floor((Date.parse(data.cert.notAfter) - Date.now()) / 86_400_000) : null;

  return (
    <>
      <form className="panel" onSubmit={saveHttps}>
        <h2 style={{ marginBottom: 6 }}>HTTPS</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Serves the site on <b>https://{h.domain || "your domain"}</b> (port 443) with a free Let's Encrypt certificate, and sends plain http on port 80 to it.
          The certificate is proven with a DNS record at Cloudflare and renewed automatically when fewer than 30 days are left. Point the domain's A record at
          your public IP, and forward TCP 443 and 80 to this server.
        </p>
        {data.site?.https && (
          <p className="notice ok" style={{ marginTop: 0 }}>
            The site is on HTTPS:{" "}
            <a href={`https://${data.https.domain}`} target="_blank" rel="noreferrer">
              https://{data.https.domain}
            </a>
          </p>
        )}
        {data.https.enabled && !data.active && (
          <p className="notice warn" style={{ marginTop: 0 }}>
            HTTPS is switched on, but there's no certificate for {data.https.domain} yet, so the site still runs on plain http. Press "Get certificate now".
          </p>
        )}
        <div className="form-grid">
          <label className="check wide">
            <input type="checkbox" checked={h.enabled} onChange={(e) => setH({ ...h, enabled: e.target.checked })} disabled={!manage} />
            <span>
              <b>Serve the site on HTTPS</b>
            </span>
          </label>
          <label className="field">
            <span>Domain</span>
            <input value={h.domain} onChange={(e) => setH({ ...h, domain: e.target.value })} placeholder="en.fredagsspiller.dk" disabled={!manage} />
          </label>
          <label className="field">
            <span>Email for Let's Encrypt</span>
            <input type="email" value={h.email} onChange={(e) => setH({ ...h, email: e.target.value })} placeholder="you@example.com" disabled={!manage} />
            <small>Let's Encrypt writes here only if renewing keeps failing.</small>
          </label>
          <label className="field">
            <span>Cloudflare API token</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={data.cloudflareTokenSet ? "Token saved (type to replace)" : "Paste a token"}
              disabled={!manage}
            />
            <small>
              Create it in Cloudflare under My Profile → API Tokens with the "Edit zone DNS" template, limited to{" "}
              {h.domain ? h.domain.split(".").slice(-2).join(".") : "your zone"}.
            </small>
          </label>
          <label className="check wide">
            <input type="checkbox" checked={h.staging} onChange={(e) => setH({ ...h, staging: e.target.checked })} disabled={!manage} />
            <span>
              Use Let's Encrypt's test certificates
              <br />
              <span className="hint">For trying the setup without hitting Let's Encrypt's limits. Browsers don't trust these; untick it for the real one.</span>
            </span>
          </label>
        </div>
        {manage && (
          <div className="row-actions" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy || !hDirty}>
              Save
            </button>
            <button type="button" className="btn" disabled={busy || data.working || hDirty || !data.https.domain || !data.cloudflareTokenSet} onClick={renew}>
              {data.working ? "Working…" : data.cert ? "Renew certificate now" : "Get certificate now"}
            </button>
          </div>
        )}
        {data.cert && (
          <p className="hint" style={{ marginBottom: 0 }}>
            Certificate for <b>{data.cert.domain}</b> from {data.cert.issuer}
            {data.cert.staging && " (test certificate)"}, valid until {formatDateTime(new Date(data.cert.notAfter))}
            {daysLeft !== null && ` (${daysLeft} days)`}.
          </p>
        )}
        <OutcomeLine label="Last renewal" o={data.lastRenew} />
      </form>

      <div className="panel">
        <h2 style={{ marginBottom: 6 }}>Palo Alto firewall</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Every new certificate and its key are imported on the firewall under the name below (replacing the old one) and committed, so inbound SSL inspection
          keeps working. Use that certificate name in your inbound decryption rule. The panel talks to the firewall's management address over your network.
        </p>
        <form onSubmit={saveFw}>
          <div className="form-grid">
            <label className="check wide">
              <input type="checkbox" checked={fw.enabled} onChange={(e) => setFw({ ...fw, enabled: e.target.checked })} disabled={!manage} />
              <span>
                <b>Send new certificates to the firewall</b>
              </span>
            </label>
            <label className="field">
              <span>Management address</span>
              <input value={fw.host} onChange={(e) => setFw({ ...fw, host: e.target.value })} placeholder="192.168.1.1" disabled={!manage} />
            </label>
            <label className="field">
              <span>Certificate name on the firewall</span>
              <input value={fw.certName} onChange={(e) => setFw({ ...fw, certName: e.target.value })} maxLength={31} disabled={!manage} />
            </label>
            <label className="check wide">
              <input type="checkbox" checked={fw.commit} onChange={(e) => setFw({ ...fw, commit: e.target.checked })} disabled={!manage} />
              <span>
                Commit after importing
                <br />
                <span className="hint">Only this admin's changes are committed, so other people's unfinished changes aren't pushed.</span>
              </span>
            </label>
          </div>
          {manage && (
            <div className="row-actions" style={{ marginTop: 12 }}>
              <button className="btn primary" disabled={busy || !fwDirty}>
                Save
              </button>
            </div>
          )}
        </form>

        <h3 style={{ margin: "18px 0 6px" }}>Connection</h3>
        {data.firewallKeySet && data.firewallFingerprint ? (
          <>
            <p style={{ margin: 0 }}>
              Connected to {data.firewall.host} as <b>{data.firewallAdmin}</b>.
            </p>
            <p className="hint" style={{ margin: "4px 0 0", wordBreak: "break-all" }}>
              Trusted firewall certificate: {data.firewallFingerprint}
            </p>
            {manage && (
              <div className="row-actions" style={{ marginTop: 10 }}>
                <button className="btn" disabled={busy || data.working || !data.cert} onClick={push}>
                  Send certificate now
                </button>
                <button className="btn ghost danger" disabled={busy} onClick={forget}>
                  Disconnect
                </button>
              </div>
            )}
          </>
        ) : !data.firewall.host ? (
          <p className="hint">Save the firewall's address first.</p>
        ) : !probe ? (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              First the panel checks which certificate the firewall shows, so you can confirm it's really your firewall. Then you log in once with a firewall
              admin that may use the XML API (import and commit); the panel keeps only an API key, never the password.
            </p>
            {manage && (
              <button className="btn" disabled={busy || fwDirty} onClick={checkFw}>
                Check the firewall's certificate
              </button>
            )}
          </>
        ) : (
          <form onSubmit={connect}>
            <p style={{ margin: "0 0 4px" }}>{data.firewall.host} shows a certificate with this SHA-256 fingerprint:</p>
            <code className="mm-fingerprint">{probe}</code>
            <p className="hint">
              Compare it with the firewall's own: Device → Certificate Management → Certificates, open the web interface certificate (or check the padlock in
              your browser on the firewall's login page). Only continue if they match.
            </p>
            <div className="form-grid">
              <label className="field">
                <span>Firewall admin</span>
                <input value={login.user} onChange={(e) => setLogin({ ...login, user: e.target.value })} autoComplete="off" />
              </label>
              <label className="field">
                <span>Password</span>
                <input type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} autoComplete="off" />
              </label>
            </div>
            <div className="row-actions" style={{ marginTop: 12 }}>
              <button className="btn primary" disabled={busy || !login.user || !login.password}>
                It matches: connect
              </button>
              <button type="button" className="btn ghost" onClick={() => setProbe(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <OutcomeLine label="Last sent" o={data.lastPush} />
      </div>
    </>
  );
}
