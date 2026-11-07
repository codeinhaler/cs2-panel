/** A pretend Steam Workshop API for tests. */
const ITEMS: Record<string, Record<string, unknown>> = {
  "3070288532": { result: 1, consumer_app_id: 730, creator_app_id: 730, title: "Lego 2", file_size: 31457280, visibility: 0, banned: 0 },
  "3094994703": { result: 1, consumer_app_id: 730, title: "cs_mansion from CS 1.6 (CS2 version)", file_size: 30947000, visibility: 0, banned: 1, ban_reason: "" },
  "125499818": { result: 1, consumer_app_id: 730, creator_app_id: 766, title: "Old school maps", file_size: 0, visibility: 0, banned: 0 },
  "4000000001": { result: 1, consumer_app_id: 4000, title: "A Garry's Mod map", file_size: 100, visibility: 0, banned: 0 },
  "777": { result: 1, consumer_app_id: 730, title: "Secret map", file_size: 100, visibility: 2, banned: 0 },
};
const COLLECTIONS: Record<string, string[]> = { "125499818": ["3070288532", "3070212345", "3070299999"] };

/** Answers Steam Workshop API calls; returns null for anything else. */
export async function fakeSteamWorkshop(input: string | URL | Request, init?: RequestInit): Promise<Response | null> {
  const url = String(input);
  if (!url.includes("api.steampowered.com/ISteamRemoteStorage/")) return null;
  const id = new URLSearchParams(String(init?.body ?? "")).get("publishedfileids[0]") ?? "";
  if (url.includes("GetPublishedFileDetails")) {
    const d = ITEMS[id] ?? { result: 9 };
    return Response.json({ response: { result: 1, resultcount: 1, publishedfiledetails: [{ publishedfileid: id, ...d }] } });
  }
  const children = COLLECTIONS[id];
  return Response.json({
    response: {
      result: 1,
      resultcount: 1,
      collectiondetails: [children ? { publishedfileid: id, result: 1, children: children.map((c, i) => ({ publishedfileid: c, sortorder: i, filetype: 0 })) } : { publishedfileid: id, result: 9 }],
    },
  });
}
