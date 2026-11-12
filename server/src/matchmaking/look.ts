import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { badRequest } from "../errors.js";

/**
 * How the matchmaking site looks: a theme, optional colour changes on top of
 * it, and an uploaded icon and banner.
 */

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colours must look like #a1b2c3.");
export const COLOR_KEYS = ["paper", "panel", "ink", "accent", "teamA", "teamB"] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];
export type Colors = Record<ColorKey, string>;

export interface Theme {
  id: string;
  label: string;
  /** "auto" follows the device's light/dark setting and can't be recoloured. */
  mode: "auto" | "light" | "dark";
  colors: Colors | null;
}

export const THEMES: Theme[] = [
  { id: "default", label: "Default", mode: "auto", colors: null },
  {
    id: "light",
    label: "Light",
    mode: "light",
    colors: { paper: "#eef1f4", panel: "#ffffff", ink: "#18212b", accent: "#1f5fbf", teamA: "#1f5fbf", teamB: "#c76a1a" },
  },
  {
    id: "night",
    label: "Night",
    mode: "dark",
    colors: { paper: "#0e1116", panel: "#171c23", ink: "#e6eaef", accent: "#4da3ff", teamA: "#4da3ff", teamB: "#ff9f43" },
  },
  {
    id: "purple",
    label: "Purple",
    mode: "dark",
    colors: { paper: "#160a2a", panel: "#22113d", ink: "#f3ecff", accent: "#b84dff", teamA: "#8f7dff", teamB: "#ff4fa8" },
  },
  {
    id: "amber",
    label: "Amber",
    mode: "dark",
    colors: { paper: "#0f1216", panel: "#161b22", ink: "#e8ecf1", accent: "#f5a524", teamA: "#7cc4ff", teamB: "#ff7a59" },
  },
  {
    id: "forest",
    label: "Forest",
    mode: "light",
    colors: { paper: "#edf2ec", panel: "#ffffff", ink: "#1b2a20", accent: "#2f7d4a", teamA: "#2f7d4a", teamB: "#b5651d" },
  },
];

/** Page layouts for the site: the original one, and the status board (checklist + lobby table). */
export const LAYOUTS = [
  { id: "classic", label: "Classic", hint: "The original layout: lobby cards one under the other." },
  { id: "board", label: "Status board", hint: 'A "Ready to play?" checklist next to a table of all lobbies, then live matches and casual servers.' },
] as const;
export type LayoutId = (typeof LAYOUTS)[number]["id"];

export const LookSchema = z.object({
  layout: z.enum(["classic", "board"]).default("classic"),
  theme: z.string().refine((id) => THEMES.some((t) => t.id === id), "Unknown theme."),
  /** Changes on top of the theme's colours. */
  colors: z.object(Object.fromEntries(COLOR_KEYS.map((k) => [k, Hex.optional()])) as Record<ColorKey, z.ZodOptional<typeof Hex>>).default({}),
});
export type Look = z.infer<typeof LookSchema>;
export const DEFAULT_LOOK: Look = { layout: "classic", theme: "default", colors: {} };

/** The theme's colours with the changes applied, or null for the default theme. */
export function resolveColors(look: Pick<Look, "theme" | "colors">): { mode: "light" | "dark"; colors: Colors } | null {
  const theme = THEMES.find((t) => t.id === look.theme) ?? THEMES[0]!;
  if (!theme.colors || theme.mode === "auto") return null;
  const colors = { ...theme.colors };
  for (const k of COLOR_KEYS) {
    const v = look.colors[k];
    if (v) colors[k] = v.toLowerCase();
  }
  return { mode: theme.mode, colors };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Text colour that reads on top of a colour. */
export const inkOn = (hex: string) => (luminance(hex) > 0.4 ? "#111418" : "#ffffff");

const STATUS = {
  light: { run: "#12805c", fail: "#c2372b", busy: "#b7791f", idle: "#8a96a3" },
  dark: { run: "#3cc496", fail: "#ef7468", busy: "#e2a94b", idle: "#67727f" },
};

/** CSS custom properties for a theme; the panel's and the player page's styles read these. */
export function themeVars(mode: "light" | "dark", c: Colors): Record<string, string> {
  const st = STATUS[mode];
  return {
    "color-scheme": mode,
    "--paper": c.paper,
    "--panel": c.panel,
    "--panel-sunk": `color-mix(in srgb, ${c.panel} 70%, ${c.paper})`,
    "--ink": c.ink,
    "--ink-soft": `color-mix(in srgb, ${c.ink} 74%, ${c.panel})`,
    "--ink-faint": `color-mix(in srgb, ${c.ink} 52%, ${c.panel})`,
    "--line": `color-mix(in srgb, ${c.ink} 20%, ${c.panel})`,
    "--line-soft": `color-mix(in srgb, ${c.ink} 11%, ${c.panel})`,
    "--accent": c.accent,
    "--accent-ink": inkOn(c.accent),
    "--accent-soft": `color-mix(in srgb, ${c.accent} 16%, ${c.panel})`,
    "--team-a": c.teamA,
    "--team-b": c.teamB,
    "--run": st.run,
    "--run-soft": `color-mix(in srgb, ${st.run} 16%, ${c.panel})`,
    "--fail": st.fail,
    "--fail-soft": `color-mix(in srgb, ${st.fail} 16%, ${c.panel})`,
    "--busy": st.busy,
    "--busy-soft": `color-mix(in srgb, ${st.busy} 16%, ${c.panel})`,
    "--idle": st.idle,
  };
}

/** A style block for the player page, or "" for the default theme. */
export function themeCss(look: Pick<Look, "theme" | "colors">): string {
  const r = resolveColors(look);
  if (!r) return "";
  const body = Object.entries(themeVars(r.mode, r.colors))
    .map(([k, v]) => `${k}:${v};`)
    .join("");
  // html:root beats the stylesheets' own :root, light or dark.
  return `html:root{${body}}`;
}

// ------------------------------------------------------------- images

export type ImageKind = "icon" | "banner";
const LIMITS: Record<ImageKind, number> = { icon: 512 * 1024, banner: 3 * 1024 * 1024 };
const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
type Ext = keyof typeof TYPES;

/** Works out the type from the file's first bytes, not from what the browser claims. SVG isn't accepted (it can carry scripts). */
export function imageType(buf: Buffer): Ext | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

export class SiteImages {
  constructor(private readonly dir: string) {}

  private async existing(kind: ImageKind): Promise<{ file: string; ext: Ext } | null> {
    for (const ext of Object.keys(TYPES) as Ext[]) {
      const file = path.join(this.dir, `${kind}.${ext}`);
      try {
        await fs.access(file);
        return { file, ext };
      } catch {
        /* next */
      }
    }
    return null;
  }

  async save(kind: ImageKind, buf: Buffer): Promise<void> {
    if (buf.length > LIMITS[kind]) throw badRequest(`The ${kind} can be at most ${Math.round(LIMITS[kind] / 1024)} KB.`);
    const ext = imageType(buf);
    if (!ext) throw badRequest("Upload a PNG, JPG or WebP image.");
    await fs.mkdir(this.dir, { recursive: true });
    await this.remove(kind);
    const file = path.join(this.dir, `${kind}.${ext}`);
    await fs.writeFile(`${file}.tmp`, buf, { mode: 0o644 });
    await fs.rename(`${file}.tmp`, file);
  }

  async remove(kind: ImageKind): Promise<void> {
    for (const ext of Object.keys(TYPES)) await fs.rm(path.join(this.dir, `${kind}.${ext}`), { force: true });
  }

  async read(kind: ImageKind): Promise<{ data: Buffer; type: string } | null> {
    const found = await this.existing(kind);
    if (!found) return null;
    return { data: await fs.readFile(found.file), type: TYPES[found.ext] };
  }

  /** A version per image (its change time), for cache-busting URLs; null when there's none. */
  async versions(): Promise<Record<ImageKind, number | null>> {
    const out: Record<ImageKind, number | null> = { icon: null, banner: null };
    for (const kind of ["icon", "banner"] as const) {
      const found = await this.existing(kind);
      if (found) out[kind] = Math.floor((await fs.stat(found.file)).mtimeMs);
    }
    return out;
  }
}
