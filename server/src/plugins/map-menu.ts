import { promises as fs } from "node:fs";
import path from "node:path";
import { badRequest } from "../errors.js";
import type { ConfigService } from "../servers/configs.js";
import type { ServerRecord } from "../servers/store.js";
import { catalogEntry } from "./catalog.js";
import type { MapMenuConfig } from "./moderation.js";
import type { PluginService } from "./service.js";

export interface MapMenu {
  maps: string[];
  workshop: { name: string; id: string }[];
}

const MAP_RE = /^[A-Za-z0-9_\-]{1,64}$/;
const WORKSHOP_ID_RE = /^\d{1,20}$/;

/**
 * Edits the map list of a moderation plugin's in-game change-map menu
 * (CS2-SimpleAdmin's DefaultMaps/WorkshopMaps). Saved through ConfigService, so
 * it shows up in the config history like any other edit.
 */
export class MapMenuService {
  constructor(
    private readonly configs: ConfigService,
    private readonly plugins: PluginService,
    /** The shared CS2 install (holds game/csgo/maps). */
    private readonly baseDir: string,
  ) {}

  /** Playable maps in the CS2 install, from game/csgo/maps/*.vpk. */
  async installedMaps(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(path.join(this.baseDir, "game", "csgo", "maps"));
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".vpk"))
      .map((n) => n.slice(0, -4))
      .filter((n) => /^(de|cs|ar|gd|dm|aim|awp)_[a-z0-9_]+$/i.test(n) && !/_(vanity|preview)$/i.test(n))
      .sort();
  }

  private configFor(serverId: number): { plugin: string; cfg: MapMenuConfig } | null {
    for (const id of this.plugins.installedIds(serverId)) {
      const e = catalogEntry(id);
      if (e?.moderation?.mapMenu) return { plugin: e.name, cfg: e.moderation.mapMenu };
    }
    return null;
  }

  private async load(s: ServerRecord) {
    const found = this.configFor(s.id);
    if (!found) throw badRequest("No plugin with a map menu is installed on this server.");
    const current = await this.configs.readCurrent(s, found.cfg.file);
    if (!current) return { ...found, json: null };
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(current.content) as Record<string, unknown>;
    } catch {
      throw badRequest(`${found.plugin}'s config file isn't valid JSON. Fix it on the Config files tab first.`);
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw badRequest(`${found.plugin}'s config file has an unexpected layout.`);
    return { ...found, json };
  }

  /** null = the plugin hasn't written its config yet (it does on its first start). */
  async get(s: ServerRecord): Promise<(MapMenu & { file: string }) | null> {
    const { cfg, json } = await this.load(s);
    if (!json) return null;
    const rawMaps = json[cfg.mapsKey];
    const rawWs = json[cfg.workshopKey];
    const maps = Array.isArray(rawMaps) ? rawMaps.filter((m): m is string => typeof m === "string") : [];
    const workshop =
      rawWs && typeof rawWs === "object" && !Array.isArray(rawWs)
        ? Object.entries(rawWs as Record<string, unknown>).map(([name, id]) => ({ name, id: id == null ? "" : String(id) }))
        : [];
    return { maps, workshop, file: cfg.file };
  }

  async set(s: ServerRecord, menu: MapMenu, actorId: number): Promise<{ changed: boolean; file: string }> {
    const maps: string[] = [];
    for (const raw of menu.maps) {
      const m = raw.trim();
      if (!MAP_RE.test(m)) throw badRequest(`"${raw}" isn't a valid map name (like de_mirage).`);
      if (!maps.includes(m)) maps.push(m);
    }
    const workshop: Record<string, number> = {};
    for (const w of menu.workshop) {
      const name = w.name.trim();
      const id = w.id.trim();
      if (!MAP_RE.test(name)) throw badRequest(`"${w.name}" isn't a valid map name.`);
      if (!WORKSHOP_ID_RE.test(id)) throw badRequest(`Workshop ID for ${name} should be the number from its Workshop page.`);
      workshop[name] = Number(id);
    }
    const { plugin, cfg, json } = await this.load(s);
    if (!json) throw badRequest(`${plugin} hasn't created its config file yet. Start the server once, then try again.`);
    json[cfg.mapsKey] = maps;
    json[cfg.workshopKey] = workshop;
    const { changed } = await this.configs.save(s, cfg.file, JSON.stringify(json, null, 4) + "\n", actorId, "Change-map menu edited from the panel");
    return { changed, file: cfg.file };
  }
}
