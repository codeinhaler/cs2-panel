/** The SearchPaths line that makes CS2 load Metamod:Source. */
export const METAMOD_LINE = "Game\tcsgo/addons/metamod";

export function hasMetamodPath(gameinfo: string): boolean {
  return /^\s*Game\s+csgo\/addons\/metamod\s*$/m.test(gameinfo);
}

/**
 * Adds the Metamod search path to gameinfo.gi, directly above the first
 * `Game csgo` entry inside SearchPaths (Metamod's documented placement).
 * Returns the text unchanged if it's already there.
 */
export function patchGameinfo(gameinfo: string): string {
  if (hasMetamodPath(gameinfo)) return gameinfo;
  const eol = gameinfo.includes("\r\n") ? "\r\n" : "\n";
  const lines = gameinfo.split(/\r?\n/);

  const start = lines.findIndex((l) => /^\s*SearchPaths\s*$/.test(l));
  if (start < 0) throw new Error("gameinfo.gi has no SearchPaths block");

  // Find the block's opening brace and closing brace.
  let open = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\{\s*$/.test(lines[i]!)) {
      open = i;
      break;
    }
    if (lines[i]!.trim() !== "") break;
  }
  if (open < 0) throw new Error("gameinfo.gi SearchPaths block is malformed");

  let insertAt = -1;
  for (let i = open + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*\}\s*$/.test(l)) break;
    if (/^\s*Game\s+csgo\s*(\/\/.*)?$/.test(l)) {
      insertAt = i;
      break;
    }
  }

  if (insertAt >= 0) {
    const indent = /^(\s*)/.exec(lines[insertAt]!)![1];
    lines.splice(insertAt, 0, indent + METAMOD_LINE);
  } else {
    const indent = /^(\s*)/.exec(lines[open]!)![1] + "\t";
    lines.splice(open + 1, 0, indent + METAMOD_LINE);
  }
  return lines.join(eol);
}

/** Reads key=value pairs from steam.inf. */
export function parseSteamInf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
