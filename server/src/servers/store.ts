import type { Db } from "../db.js";
import type { SecretBox } from "../crypto.js";

/** A server as stored, with secrets decrypted. Never send this to the browser as-is. */
export interface ServerRecord {
  id: number;
  slug: string;
  name: string;
  presetId: number | null;
  port: number;
  /** The first (or only) CPU; kept for older code and the API. */
  cpu: number;
  /** The CPU list ("2,14"), normalised. Null: just `cpu` (servers from before CPU lists). */
  cpuSet: string | null;
  /** auto: picked by the CPU policy; manual: set by hand (all servers from before count as manual). */
  cpuMode: "auto" | "manual";
  map: string;
  gameType: number;
  gameMode: number;
  maxPlayers: number;
  password: string | null;
  gsltToken: string | null;
  rconPassword: string;
  bridgeToken: string;
  extraArgs: string;
  autostart: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ServerRow {
  id: number;
  slug: string;
  name: string;
  preset_id: number | null;
  port: number;
  cpu: number;
  cpu_set: string | null;
  cpu_mode: string;
  map: string;
  game_type: number;
  game_mode: number;
  max_players: number;
  sv_password_enc: string | null;
  gslt_enc: string | null;
  rcon_password_enc: string;
  bridge_token_enc: string;
  extra_args: string;
  autostart: number;
  created_at: string;
  updated_at: string;
}

export type NewServer = Omit<ServerRecord, "id" | "createdAt" | "updatedAt">;

export class ServerStore {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  private toRecord(r: ServerRow): ServerRecord {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      presetId: r.preset_id,
      port: r.port,
      cpu: r.cpu,
      cpuSet: r.cpu_set,
      cpuMode: r.cpu_mode === "auto" ? "auto" : "manual",
      map: r.map,
      gameType: r.game_type,
      gameMode: r.game_mode,
      maxPlayers: r.max_players,
      password: this.box.openOptional(r.sv_password_enc),
      gsltToken: this.box.openOptional(r.gslt_enc),
      rconPassword: this.box.open(r.rcon_password_enc),
      bridgeToken: this.box.open(r.bridge_token_enc),
      extraArgs: r.extra_args,
      autostart: r.autostart === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(): ServerRecord[] {
    const rows = this.db.prepare("SELECT * FROM servers WHERE deleted_at IS NULL ORDER BY port").all() as unknown as ServerRow[];
    return rows.map((r) => this.toRecord(r));
  }

  byId(id: number): ServerRecord | null {
    const row = this.db.prepare("SELECT * FROM servers WHERE id = ? AND deleted_at IS NULL").get(id) as ServerRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  slugTaken(slug: string): boolean {
    return this.db.prepare("SELECT 1 FROM servers WHERE slug = ? AND deleted_at IS NULL").get(slug) !== undefined;
  }

  insert(s: NewServer): number {
    const r = this.db
      .prepare(
        `INSERT INTO servers (slug, name, preset_id, port, cpu, cpu_set, cpu_mode, map, game_type, game_mode, max_players,
          sv_password_enc, gslt_enc, rcon_password_enc, bridge_token_enc, extra_args, autostart)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.slug,
        s.name,
        s.presetId,
        s.port,
        s.cpu,
        s.cpuSet ?? null,
        s.cpuMode ?? "manual",
        s.map,
        s.gameType,
        s.gameMode,
        s.maxPlayers,
        this.box.sealOptional(s.password),
        this.box.sealOptional(s.gsltToken),
        this.box.seal(s.rconPassword),
        this.box.seal(s.bridgeToken),
        s.extraArgs,
        s.autostart ? 1 : 0,
      );
    return Number(r.lastInsertRowid);
  }

  update(s: ServerRecord): void {
    this.db
      .prepare(
        `UPDATE servers SET name = ?, preset_id = ?, port = ?, cpu = ?, cpu_set = ?, cpu_mode = ?, map = ?, game_type = ?, game_mode = ?,
           max_players = ?, sv_password_enc = ?, gslt_enc = ?, extra_args = ?, autostart = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        s.name,
        s.presetId,
        s.port,
        s.cpu,
        s.cpuSet ?? null,
        s.cpuMode ?? "manual",
        s.map,
        s.gameType,
        s.gameMode,
        s.maxPlayers,
        this.box.sealOptional(s.password),
        this.box.sealOptional(s.gsltToken),
        s.extraArgs,
        s.autostart ? 1 : 0,
        s.id,
      );
  }

  markDeleted(id: number): void {
    this.db.prepare("UPDATE servers SET deleted_at = datetime('now') WHERE id = ?").run(id);
  }

  /** Hard delete, only for rolling back a create that never finished. */
  purge(id: number): void {
    this.db.prepare("DELETE FROM servers WHERE id = ?").run(id);
  }
}
