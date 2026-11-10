import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Schema migrations. Append new entries; never edit an applied one.
 * The index (1-based) is stored in PRAGMA user_version.
 */
const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    steam_id      TEXT NOT NULL UNIQUE,
    display_name  TEXT,
    avatar_url    TEXT,
    role          TEXT NOT NULL CHECK (role IN ('owner','admin','moderator')),
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    created_by    INTEGER REFERENCES users(id),
    last_login_at TEXT
  );

  CREATE TABLE sessions (
    token_hash    TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );

  CREATE TABLE presets (
    id            INTEGER PRIMARY KEY,
    key           TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    builtin       INTEGER NOT NULL DEFAULT 0,
    game_type     INTEGER NOT NULL,
    game_mode     INTEGER NOT NULL,
    default_map   TEXT NOT NULL,
    max_players   INTEGER NOT NULL,
    config_files  TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE servers (
    id                 INTEGER PRIMARY KEY,
    slug               TEXT NOT NULL,
    name               TEXT NOT NULL,
    preset_id          INTEGER REFERENCES presets(id),
    port               INTEGER NOT NULL,
    cpu                INTEGER NOT NULL,
    map                TEXT NOT NULL,
    game_type          INTEGER NOT NULL,
    game_mode          INTEGER NOT NULL,
    max_players        INTEGER NOT NULL,
    sv_password_enc    TEXT,
    gslt_enc           TEXT,
    rcon_password_enc  TEXT NOT NULL,
    bridge_token_enc   TEXT NOT NULL,
    extra_args         TEXT NOT NULL DEFAULT '',
    autostart          INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at         TEXT
  );
  CREATE UNIQUE INDEX servers_slug_active ON servers(slug) WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX servers_port_active ON servers(port) WHERE deleted_at IS NULL;

  CREATE TABLE config_files (
    id         INTEGER PRIMARY KEY,
    server_id  INTEGER NOT NULL REFERENCES servers(id),
    path       TEXT NOT NULL,
    UNIQUE (server_id, path)
  );

  CREATE TABLE config_revisions (
    id              INTEGER PRIMARY KEY,
    config_file_id  INTEGER NOT NULL REFERENCES config_files(id),
    content         TEXT,
    sha256          TEXT,
    author_id       INTEGER REFERENCES users(id),
    comment         TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX config_revisions_file ON config_revisions(config_file_id, id);

  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id),
    action      TEXT NOT NULL,
    server_id   INTEGER REFERENCES servers(id),
    details     TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX audit_log_created ON audit_log(id DESC);

  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  `,
  /* 2: plugins installed per server */ `
  CREATE TABLE plugin_installs (
    id            INTEGER PRIMARY KEY,
    server_id     INTEGER NOT NULL REFERENCES servers(id),
    plugin_id     TEXT NOT NULL,
    name          TEXT NOT NULL,
    version       TEXT NOT NULL,
    asset         TEXT NOT NULL,
    files         TEXT NOT NULL DEFAULT '[]',
    installed_at  TEXT NOT NULL DEFAULT (datetime('now')),
    installed_by  INTEGER REFERENCES users(id),
    removed_at    TEXT
  );
  CREATE INDEX plugin_installs_server ON plugin_installs(server_id, plugin_id, id);
  `,
  /* 3: per-user display preferences */ `
  ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';
  `,
  /* 4: who was on which server, when */ `
  CREATE TABLE player_sessions (
    id               INTEGER PRIMARY KEY,
    server_id        INTEGER NOT NULL REFERENCES servers(id),
    user_id          INTEGER NOT NULL,
    name             TEXT NOT NULL,
    steam_id         TEXT,
    connected_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
    disconnected_at  TEXT
  );
  CREATE INDEX player_sessions_open ON player_sessions(server_id, disconnected_at);
  CREATE INDEX player_sessions_seen ON player_sessions(last_seen_at DESC);
  CREATE INDEX player_sessions_steam ON player_sessions(steam_id);
  `,
  /* 5: bans owned by the panel, enforced by the bridge plugin on every server */ `
  CREATE TABLE bans (
    id             INTEGER PRIMARY KEY,
    steam_id       TEXT NOT NULL,
    name           TEXT,
    reason         TEXT NOT NULL,
    created_by     INTEGER REFERENCES users(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    server_id      INTEGER REFERENCES servers(id),
    expires_at     TEXT,
    revoked_by     INTEGER REFERENCES users(id),
    revoked_at     TEXT,
    revoke_reason  TEXT
  );
  CREATE INDEX bans_steam ON bans(steam_id);
  `,
  /* 6: per-server automation (scheduled restarts) */ `
  ALTER TABLE servers ADD COLUMN schedule TEXT NOT NULL DEFAULT '{}';
  `,
  /* 7: configs to run on every map start; custom presets */ `
  ALTER TABLE servers ADD COLUMN exec_configs TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE presets ADD COLUMN exec_configs TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE presets ADD COLUMN created_by INTEGER REFERENCES users(id);
  ALTER TABLE presets ADD COLUMN updated_at TEXT;
  `,
  /* 8: performance monitor and warnings */ `
  CREATE TABLE metrics (
    ts          INTEGER NOT NULL,           -- ms since epoch
    scope       INTEGER NOT NULL,           -- 0 = the machine, otherwise a server id
    res         INTEGER NOT NULL DEFAULT 0, -- 0 = one sample a minute, 1 = hourly average
    cpu         REAL,                       -- servers: % of one core; machine: % of all cores
    cpu_max     REAL,
    mem         INTEGER,
    mem_total   INTEGER,
    players     INTEGER,
    bots        INTEGER,
    disk_used   INTEGER,
    disk_total  INTEGER,
    net_rx      REAL,                       -- bytes per second
    net_tx      REAL
  );
  CREATE INDEX metrics_scope ON metrics(scope, res, ts);

  CREATE TABLE alerts (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL,
    server_id    INTEGER REFERENCES servers(id),
    message      TEXT NOT NULL,
    details      TEXT NOT NULL DEFAULT '{}',
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at  TEXT
  );
  CREATE INDEX alerts_open ON alerts(resolved_at);
  `,
  /* 9: matchmaking site for players */ `
  CREATE TABLE mm_players (
    steam_id         TEXT PRIMARY KEY,
    name             TEXT,
    avatar_url       TEXT,
    self_rating      INTEGER,   -- Premier rating the player typed in
    override_rating  INTEGER,   -- set by a panel admin; wins over everything
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at     TEXT
  );

  CREATE TABLE mm_sessions (
    token_hash    TEXT PRIMARY KEY,
    steam_id      TEXT NOT NULL REFERENCES mm_players(steam_id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );

  -- Ratings are deliberately not stored here: Leetify's rules say not to keep their data.
  CREATE TABLE mm_matches (
    id          INTEGER PRIMARY KEY,
    server_id   INTEGER REFERENCES servers(id) ON DELETE SET NULL,
    map         TEXT,
    team_a      TEXT NOT NULL,           -- JSON [{steamId, name}]
    team_b      TEXT NOT NULL,
    score_a     INTEGER,
    score_b     INTEGER,
    status      TEXT NOT NULL,           -- veto, side, starting, live, over, cancelled, abandoned
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT
  );
  `,
  /* 10: matchmaking lobbies (Competitive, Wingman, 1v1) */ `
  ALTER TABLE mm_matches ADD COLUMN mode TEXT NOT NULL DEFAULT 'competitive';
  `,
  /* 11: map cycle for Casual servers, run by the bridge */ `
  ALTER TABLE servers ADD COLUMN map_cycle TEXT;
  `,
  /* 12: match servers waiting to be cleaned up after a match (survives restarts) */ `
  CREATE TABLE mm_cleanup (
    server_id INTEGER PRIMARY KEY,
    reason TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Runs fn inside a transaction. Not reentrant. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
