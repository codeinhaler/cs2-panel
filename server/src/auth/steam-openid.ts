/**
 * "Sign in through Steam" — OpenID 2.0 against steamcommunity.com.
 * Steam only proves which SteamID the browser belongs to; whether that
 * SteamID may use the panel is decided by the users table.
 */

const OP_ENDPOINT = "https://steamcommunity.com/openid/login";
const NS = "http://specs.openid.net/auth/2.0";
const IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select";
const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/;

export function buildLoginUrl(baseUrl: string): string {
  const params = new URLSearchParams({
    "openid.ns": NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": `${baseUrl}/api/auth/steam/callback`,
    "openid.realm": baseUrl,
    "openid.identity": IDENTIFIER_SELECT,
    "openid.claimed_id": IDENTIFIER_SELECT,
  });
  return `${OP_ENDPOINT}?${params.toString()}`;
}

type FetchFn = typeof fetch;

/** Nonces already used, so a captured callback URL can't be replayed. */
const seenNonces = new Map<string, number>();
const NONCE_TTL_MS = 10 * 60 * 1000;

function rememberNonce(nonce: string, now: number): boolean {
  for (const [n, t] of seenNonces) if (now - t > NONCE_TTL_MS) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now);
  return true;
}

/**
 * Verifies the callback query and returns the SteamID64, or throws with a
 * user-facing reason.
 */
export async function verifyCallback(
  query: Record<string, string | undefined>,
  baseUrl: string,
  fetchFn: FetchFn = fetch,
  now: number = Date.now(),
): Promise<string> {
  if (query["openid.mode"] !== "id_res") throw new Error("Steam login was cancelled or failed.");
  if (query["openid.op_endpoint"] !== OP_ENDPOINT) throw new Error("Unexpected OpenID provider.");

  const expectedReturn = `${baseUrl}/api/auth/steam/callback`;
  const returnTo = query["openid.return_to"] ?? "";
  if (returnTo.split("?")[0] !== expectedReturn) throw new Error("Login response was for a different address.");

  const claimed = query["openid.claimed_id"] ?? "";
  const match = CLAIMED_ID_RE.exec(claimed);
  if (!match || query["openid.identity"] !== claimed) throw new Error("Steam returned an unexpected identity.");

  const nonce = query["openid.response_nonce"];
  if (!nonce) throw new Error("Login response had no nonce.");
  const nonceTime = Date.parse(nonce.slice(0, 20));
  if (!Number.isFinite(nonceTime) || Math.abs(now - nonceTime) > NONCE_TTL_MS) throw new Error("Login response expired. Try again.");

  // Ask Steam to confirm the signature.
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (k.startsWith("openid.") && v !== undefined) body.set(k, v);
  body.set("openid.mode", "check_authentication");
  const res = await fetchFn(OP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok || !/^is_valid\s*:\s*true\s*$/m.test(text)) throw new Error("Steam could not confirm the login.");

  if (!rememberNonce(nonce, now)) throw new Error("This login link was already used.");
  return match[1]!;
}
