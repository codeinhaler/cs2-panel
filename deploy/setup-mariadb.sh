#!/usr/bin/env bash
# Sets up a local MariaDB database for plugins that share data between
# servers (CS2-SimpleAdmin keeps its bans, admins and mutes there), and tells
# the panel how to reach it. Run once:
#
#   sudo /opt/cs2-panel/deploy/setup-mariadb.sh
#
# Safe to re-run: an existing setup is left alone. MariaDB listens on
# 127.0.0.1 only, so nothing is exposed to the network.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$SCRIPT_DIR/lib.sh"
require_root

CONFIG=/etc/cs2-panel/panel.json
DB_NAME=cs2_simpleadmin
DB_USER=cs2sa

[[ -f "$CONFIG" ]] || die "$CONFIG not found. Install the panel first."

if jq -e '.mysql' "$CONFIG" >/dev/null 2>&1; then
  log "The panel already has a database configured ($(jq -r '.mysql.database' "$CONFIG")). Nothing to do."
  exit 0
fi

log "Installing MariaDB"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq mariadb-server >/dev/null
systemctl enable --now mariadb >/dev/null

PASSWORD="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

log "Creating database $DB_NAME and user $DB_USER"
mariadb <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$PASSWORD';
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$PASSWORD';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$PASSWORD';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

log "Saving the connection settings for the panel"
tmp="$(mktemp)"
jq --arg u "$DB_USER" --arg p "$PASSWORD" --arg d "$DB_NAME" \
  '.mysql = {host: "127.0.0.1", port: 3306, user: $u, password: $p, database: $d}' "$CONFIG" >"$tmp"
install -m 0640 -o root -g cs2panel "$tmp" "$CONFIG"
rm -f "$tmp"

systemctl restart cs2-panel.service
log "Done. Plugins installed from now on use this database."
echo "   If CS2-SimpleAdmin is already installed on a server, reinstall it from the server's Plugins tab"
echo "   so its config points at the database."
