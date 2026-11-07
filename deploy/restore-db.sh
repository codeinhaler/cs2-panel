#!/usr/bin/env bash
# Restores the panel's own database (users, bans, presets, history) from a backup.
#
#   sudo /opt/cs2-panel/deploy/restore-db.sh                 # list the backups
#   sudo /opt/cs2-panel/deploy/restore-db.sh panel-20261108-043000.db
#
# The panel stops for a moment. The current database is kept as panel.db.before-restore-<time>.
set -euo pipefail

DATA_DIR="/var/lib/cs2-panel"
BACKUPS="$DATA_DIR/backups"
DB="$DATA_DIR/panel.db"

[[ $EUID -eq 0 ]] || { echo "Run this with sudo." >&2; exit 1; }

if [[ $# -eq 0 ]]; then
  echo "Panel database backups (newest last):"
  ls -1 "$BACKUPS"/panel-*.db 2>/dev/null | xargs -r -n1 basename || true
  echo
  echo "Restore one with: sudo $0 <file name>"
  exit 0
fi

file="$1"
[[ "$file" =~ ^panel-[0-9]{8}-[0-9]{6}\.db$ ]] || { echo "That isn't a panel backup file name (panel-YYYYMMDD-HHMMSS.db)." >&2; exit 1; }
src="$BACKUPS/$file"
[[ -f "$src" ]] || { echo "No backup called $file in $BACKUPS." >&2; exit 1; }

stamp="$(date +%Y%m%d-%H%M%S)"
echo "==> Stopping the panel"
systemctl stop cs2-panel.service
echo "==> Keeping the current database as panel.db.before-restore-$stamp"
for f in "$DB" "$DB-wal" "$DB-shm"; do
  [[ -f "$f" ]] && mv "$f" "${f/panel.db/panel.db.before-restore-$stamp}"
done
install -o cs2panel -g cs2panel -m 0640 "$src" "$DB"
echo "==> Starting the panel"
systemctl start cs2-panel.service
echo "==> Restored the panel's database from $file"
