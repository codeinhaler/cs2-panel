/**
 * What a server starts on. Stored in the server's map field as text:
 *   de_dust2                    a map in the CS2 install
 *   workshop:3070288532         one Steam Workshop map
 *   collection:125499818        a Workshop collection (its maps become the rotation)
 *   collection:125499818/3070288532   the same, starting on that map
 */
export type MapSpec =
  | { kind: "stock"; map: string }
  | { kind: "workshop"; id: string }
  | { kind: "collection"; id: string; startId: string | null };

const STOCK_RE = /^[A-Za-z0-9_\-/]{1,64}$/;
const ID = "(\\d{1,20})";
const WORKSHOP_RE = new RegExp(`^workshop:${ID}$`);
const COLLECTION_RE = new RegExp(`^collection:${ID}(?:/${ID})?$`);

export function parseMapSpec(value: string): MapSpec | null {
  const v = value.trim();
  let m = WORKSHOP_RE.exec(v);
  if (m) return { kind: "workshop", id: m[1]! };
  m = COLLECTION_RE.exec(v);
  if (m) return { kind: "collection", id: m[1]!, startId: m[2] ?? null };
  if (STOCK_RE.test(v) && !v.includes(":")) return { kind: "stock", map: v };
  return null;
}

/** Launch arguments that load the map. */
export function mapLaunchArgs(spec: MapSpec): string[] {
  switch (spec.kind) {
    case "stock":
      return ["+map", spec.map];
    case "workshop":
      return ["+host_workshop_map", spec.id];
    case "collection":
      return ["+host_workshop_collection", spec.id, ...(spec.startId ? ["+host_workshop_start_map", spec.startId] : [])];
  }
}

/** Short text for lists, e.g. "Workshop map 3070288532". */
export function describeMapSpec(value: string): string {
  const spec = parseMapSpec(value);
  if (!spec) return value;
  if (spec.kind === "stock") return spec.map;
  if (spec.kind === "workshop") return `Workshop map ${spec.id}`;
  return `Workshop collection ${spec.id}`;
}
