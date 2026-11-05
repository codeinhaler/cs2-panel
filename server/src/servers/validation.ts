import { z } from "zod";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;
/** A CS2 server may open auxiliary ports right next to its game port. */
export const PORT_MARGIN = 5;

/** Derives a slug from a display name: "Retakes #1" → "retakes-1". */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return s || "server";
}

/**
 * Checks a port against the other servers' ports. Returns a user-facing
 * problem, or null if it's fine. (Whether the host has it bound is checked
 * separately, since that needs the host.)
 */
export function portProblem(port: number, otherPorts: { port: number; name: string }[]): string | null {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return `Port must be a whole number between ${MIN_PORT} and ${MAX_PORT}.`;
  }
  for (const o of otherPorts) {
    if (Math.abs(o.port - port) <= PORT_MARGIN) {
      return o.port === port
        ? `Port ${port} is already used by "${o.name}".`
        : `Port ${port} is too close to "${o.name}" on ${o.port}. Keep at least ${PORT_MARGIN + 1} ports between servers.`;
    }
  }
  return null;
}

// Values that end up in launch arguments or cfg files are restricted to safe characters.
const mapName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_\-/]{1,64}$/, "Map names can only contain letters, numbers, _, - and /.");
const displayName = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(64)
  .regex(/^[^"\\;\r\n]*$/, 'Name can\'t contain " \\ ; or line breaks.');
const svPassword = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_\-.!@#$%^&*()+=]*$/, "Password can only contain letters, numbers and simple symbols (no spaces or quotes).");
const gslt = z
  .string()
  .trim()
  .regex(/^[A-Fa-f0-9]{0,64}$/, "A GSLT token is a string of hex characters from Steam's game server account page.");
export const extraArgs = z
  .string()
  .max(500)
  .regex(/^[A-Za-z0-9_+\-.:/ =,]*$/, "Extra arguments can only contain letters, numbers, spaces and + - _ . : / = ,");

export const CreateServerSchema = z.object({
  name: displayName,
  slug: z.string().regex(SLUG_RE, "Short name: lowercase letters, numbers and dashes, max 32 characters.").optional(),
  presetId: z.number().int(),
  map: mapName.optional(),
  maxPlayers: z.number().int().min(1).max(64).optional(),
  port: z.number().int(),
  cpu: z.number().int().min(0).max(255).optional(),
  gsltToken: gslt.optional().default(""),
  password: svPassword.optional().default(""),
  autostart: z.boolean().default(true),
  startNow: z.boolean().default(false),
  extraArgs: extraArgs.optional().default(""),
});
export type CreateServerInput = z.infer<typeof CreateServerSchema>;

export const UpdateServerSchema = z.object({
  name: displayName.optional(),
  presetId: z.number().int().optional(),
  applyPresetConfigs: z.boolean().optional(),
  map: mapName.optional(),
  maxPlayers: z.number().int().min(1).max(64).optional(),
  port: z.number().int().optional(),
  cpu: z.number().int().min(0).max(255).optional(),
  gsltToken: gslt.optional(),
  password: svPassword.optional(),
  autostart: z.boolean().optional(),
  extraArgs: extraArgs.optional(),
});
export type UpdateServerInput = z.infer<typeof UpdateServerSchema>;

export const DuplicateServerSchema = z.object({
  name: displayName,
  slug: z.string().regex(SLUG_RE).optional(),
  port: z.number().int(),
  gsltToken: gslt.optional().default(""),
});
export type DuplicateServerInput = z.infer<typeof DuplicateServerSchema>;
