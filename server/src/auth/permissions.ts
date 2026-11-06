export type Role = "owner" | "admin" | "moderator";

export const PERMISSIONS = [
  "view",
  "players.moderate",
  "rcon",
  "server.control",
  "config.edit",
  "plugins.manage",
  "plugins.upload",
  "game.update",
  "server.manage",
  "preset.manage",
  "server.delete",
  "server.rawargs",
  "users.manage",
  "gameadmins.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: [
    "view",
    "players.moderate",
    "rcon",
    "server.control",
    "config.edit",
    "plugins.manage",
    "game.update",
    "server.manage",
    "preset.manage",
  ],
  moderator: ["view", "players.moderate"],
};

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
