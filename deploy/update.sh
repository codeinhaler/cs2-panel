#!/usr/bin/env bash
# Update cs2-panel to the latest (or a given) release. Game servers keep running.
#
#   sudo /opt/cs2-panel/deploy/update.sh              Latest release
#   sudo /opt/cs2-panel/deploy/update.sh v0.2.0       A specific release
#   sudo /opt/cs2-panel/deploy/update.sh --from-file X.tar.gz
#   sudo /opt/cs2-panel/deploy/update.sh --rollback   Go back to the previous version

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$SCRIPT_DIR/lib.sh"
require_root

# Copy ourselves out of $PANEL_DIR first, since that directory gets replaced.
if [[ "$SCRIPT_DIR" == "$PANEL_DIR"* && -z "${CS2PANEL_UPDATE_REEXEC:-}" ]]; then
  tmp="$(mktemp -d)"
  cp "$SCRIPT_DIR/update.sh" "$SCRIPT_DIR/lib.sh" "$tmp/"
  CS2PANEL_UPDATE_REEXEC=1 exec bash "$tmp/update.sh" "$@"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "${1:-}" in
  --rollback)
    [[ -d "$PANEL_DIR.prev" ]] || die "No previous version to roll back to."
    log "Rolling back"
    systemctl stop cs2-panel.service
    mv "$PANEL_DIR" "$WORK/current"
    mv "$PANEL_DIR.prev" "$PANEL_DIR"
    mv "$WORK/current" "$PANEL_DIR.prev"
    systemctl start cs2-panel.service
    log "Rolled back to $(cat "$PANEL_DIR/VERSION" 2>/dev/null || echo 'previous version')"
    exit 0
    ;;
  --from-file)
    TARBALL="${2:-}"
    [[ -f "$TARBALL" ]] || die "No such file: $TARBALL"
    ;;
  *)
    TARBALL="$WORK/$ASSET_NAME"
    download_release "${1:-latest}" "$TARBALL"
    ;;
esac

# Libraries newer panel versions rely on (unzip for plugin archives, ICU for CounterStrikeSharp).
apt-get update -qq || true
install_runtime_deps

log "Backing up the database"
DB=/var/lib/cs2-panel/panel.db
[[ -f "$DB" ]] && runuser -u cs2panel -- cp "$DB" "$DB.pre-update"

log "Installing"
systemctl stop cs2-panel.service
install_panel_files "$TARBALL"
install_host_files "$PANEL_DIR/deploy"
systemctl start cs2-panel.service
log "Now running $(cat "$PANEL_DIR/VERSION" 2>/dev/null || echo 'new version'). Undo with: $0 --rollback"
