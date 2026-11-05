import type { Profile } from "./users.js";

type FetchFn = typeof fetch;

const ID64_RE = /^7656119\d{10}$/;

/**
 * Turns what an admin pastes into a SteamID64. Accepts:
 *   76561198000000000
 *   https://steamcommunity.com/profiles/76561198000000000
 *   https://steamcommunity.com/id/somename   (looked up via Steam)
 */
export async function resolveSteamId(input: string, fetchFn: FetchFn = fetch): Promise<string> {
  const value = input.trim();
  if (ID64_RE.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error("Enter a SteamID64 or a Steam profile URL.");
  }
  if (url.hostname !== "steamcommunity.com" && url.hostname !== "www.steamcommunity.com") {
    throw new Error("Enter a SteamID64 or a steamcommunity.com profile URL.");
  }
  const [, kind, ident] = url.pathname.split("/");
  if (kind === "profiles" && ident && ID64_RE.test(ident)) return ident;
  if (kind === "id" && ident && /^[A-Za-z0-9_-]{2,64}$/.test(ident)) {
    const xml = await fetchXml(`https://steamcommunity.com/id/${ident}/?xml=1`, fetchFn);
    const id = xmlTag(xml, "steamID64");
    if (id && ID64_RE.test(id)) return id;
    throw new Error("Couldn't find that Steam profile.");
  }
  throw new Error("Enter a SteamID64 or a Steam profile URL.");
}

/** Best-effort profile name and avatar. Returns {} if Steam doesn't answer. */
export async function fetchProfile(steamId: string, fetchFn: FetchFn = fetch): Promise<Profile> {
  try {
    const xml = await fetchXml(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, fetchFn);
    return { name: xmlTag(xml, "steamID"), avatarUrl: xmlTag(xml, "avatarMedium") };
  } catch {
    return {};
  }
}

async function fetchXml(url: string, fetchFn: FetchFn): Promise<string> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Steam answered ${res.status}`);
  return res.text();
}

export function xmlTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`).exec(xml);
  const v = (m?.[1] ?? m?.[2])?.trim();
  return v ? v : null;
}
