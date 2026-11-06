/**
 * A minimal reader for Valve's KeyValues text format (VDF), enough for
 * SteamCMD's app_info_print output and appmanifest files.
 */
export type Vdf = { [key: string]: string | Vdf };

export function parseVdf(text: string): Vdf {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])|\/\/[^\n]*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1] !== undefined) tokens.push(`"${m[1]}`);
    else if (m[2]) tokens.push(m[2]);
  }
  let i = 0;
  const readObject = (): Vdf => {
    const obj: Vdf = {};
    while (i < tokens.length) {
      const t = tokens[i++]!;
      if (t === "}") return obj;
      if (t === "{") continue; // stray brace
      const key = t.slice(1);
      const next = tokens[i];
      if (next === "{") {
        i++;
        obj[key] = readObject();
      } else if (next !== undefined && next.startsWith('"')) {
        i++;
        obj[key] = next.slice(1);
      }
    }
    return obj;
  };
  return readObject();
}

function child(v: string | Vdf | undefined, key: string): string | Vdf | undefined {
  if (!v || typeof v === "string") return undefined;
  const found = Object.keys(v).find((k) => k.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : v[found];
}

/** The public branch's build from SteamCMD `app_info_print 730` output. */
export function latestPublicBuild(appInfoOutput: string, appId = "730"): { buildId: string; updatedAt: string | null } {
  const start = appInfoOutput.indexOf(`"${appId}"`);
  if (start < 0) throw new Error("SteamCMD returned no app info for CS2.");
  const root = parseVdf(appInfoOutput.slice(start));
  const pub = child(child(child(child(root, appId), "depots"), "branches"), "public");
  const buildId = child(pub, "buildid");
  if (typeof buildId !== "string" || !/^\d+$/.test(buildId)) throw new Error("SteamCMD's app info has no public build ID.");
  const t = child(pub, "timeupdated");
  return { buildId, updatedAt: typeof t === "string" && /^\d+$/.test(t) ? new Date(Number(t) * 1000).toISOString() : null };
}

/** The build an install has, from steamapps/appmanifest_730.acf. */
export function manifestBuild(acf: string): string | null {
  const b = child(child(parseVdf(acf), "AppState"), "buildid");
  return typeof b === "string" && /^\d+$/.test(b) ? b : null;
}
