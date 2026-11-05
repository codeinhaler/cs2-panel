#!/usr/bin/env bash
# cs2-panel first-time installer for Debian 13.
#
#   sudo ./install.sh                      Download and install the latest release
#   sudo ./install.sh --from-file X.tgz    Install from a release tarball you already have
#   sudo ./install.sh --skip-cs2           Don't download CS2 now (do it later from the panel)
#
# Safe to re-run: existing users, directories, config and CS2 files are kept.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$SCRIPT_DIR/lib.sh"

FROM_FILE=""
SKIP_CS2=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-file)
      FROM_FILE="${2:-}"
      shift 2
      ;;
    --skip-cs2)
      SKIP_CS2=1
      shift
      ;;
    -h | --help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

require_root
grep -q '^ID=debian' /etc/os-release || warn "This installer is written for Debian; continuing anyway."
[[ "$(uname -m)" == "x86_64" ]] || die "CS2 dedicated servers need x86_64."

CS2_ROOT="/srv/cs2"
CONFIG_DIR="/etc/cs2-panel"
DATA_DIR="/var/lib/cs2-panel"

# ---------------------------------------------------------------- packages
log "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar jq util-linux sudo lib32gcc-s1 lib32stdc++6 >/dev/null

# ---------------------------------------------------------------- users
log "Creating users"
getent group cs2 >/dev/null || groupadd --system cs2
id cs2 &>/dev/null || useradd --system --gid cs2 --create-home --home-dir /home/cs2 --shell /usr/sbin/nologin cs2
id cs2panel &>/dev/null || useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin cs2panel
usermod -aG cs2,systemd-journal cs2panel

# ---------------------------------------------------------------- directories
log "Creating directories"
install -d -o cs2 -g cs2 -m 2775 "$CS2_ROOT" "$CS2_ROOT/base" "$CS2_ROOT/instances" "$CS2_ROOT/backups" "$CS2_ROOT/backups/deleted"
install -d -o cs2 -g cs2 -m 0755 "$CS2_ROOT/steamcmd"
install -d -o root -g cs2panel -m 0750 "$CONFIG_DIR"
install -d -o cs2panel -g cs2panel -m 0750 "$CONFIG_DIR/instances"
install -d -o cs2panel -g cs2panel -m 0750 "$DATA_DIR"

# ---------------------------------------------------------------- steamcmd
if [[ ! -x "$CS2_ROOT/steamcmd/steamcmd.sh" ]]; then
  log "Downloading SteamCMD"
  curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz |
    runuser -u cs2 -- tar -xz -C "$CS2_ROOT/steamcmd"
  log "Letting SteamCMD update itself"
  runuser -u cs2 -- "$CS2_ROOT/steamcmd/steamcmd.sh" +quit || true
fi

# ---------------------------------------------------------------- panel files
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [[ -n "$FROM_FILE" ]]; then
  [[ -f "$FROM_FILE" ]] || die "No such file: $FROM_FILE"
  TARBALL="$FROM_FILE"
else
  TARBALL="$WORK/$ASSET_NAME"
  download_release latest "$TARBALL"
fi
log "Installing panel to $PANEL_DIR"
install_panel_files "$TARBALL"

log "Installing helper, systemd units and sudoers rule"
install_host_files "$PANEL_DIR/deploy"

# ---------------------------------------------------------------- config
if [[ ! -f "$CONFIG_DIR/panel.json" ]]; then
  echo
  echo "Your SteamID64 becomes the panel's Owner account."
  echo "Find it at https://steamid.io (17 digits, starts with 7656119)."
  OWNER=""
  while [[ ! "$OWNER" =~ ^7656119[0-9]{10}$ ]]; do
    read -r -p "Owner SteamID64: " OWNER </dev/tty
  done
  read -r -p "Panel port [8080]: " PORT </dev/tty
  PORT="${PORT:-8080}"
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "Invalid port."
  SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  jq -n --arg owner "$OWNER" --argjson port "$PORT" --arg secret "$SECRET" '{
    host: "0.0.0.0",
    port: $port,
    ownerSteamId: $owner,
    secretKey: $secret,
    dataDir: "/var/lib/cs2-panel",
    cs2Root: "/srv/cs2",
    instanceEnvDir: "/etc/cs2-panel/instances",
    cs2ctl: "/usr/local/lib/cs2-panel/cs2ctl"
  }' >"$CONFIG_DIR/panel.json"
  chown root:cs2panel "$CONFIG_DIR/panel.json"
  chmod 0640 "$CONFIG_DIR/panel.json"
else
  log "Keeping existing $CONFIG_DIR/panel.json"
fi

# ---------------------------------------------------------------- CS2
if [[ $SKIP_CS2 -eq 0 && ! -f "$CS2_ROOT/base/game/csgo/steam.inf" ]]; then
  log "Downloading CS2 (about 60 GB — this takes a while)"
  /usr/local/lib/cs2-panel/cs2ctl steam-update validate
elif [[ $SKIP_CS2 -eq 1 ]]; then
  warn "Skipped CS2 download. Run it later from the panel's Game update page."
fi

# ---------------------------------------------------------------- start
log "Starting the panel"
systemctl enable --now cs2-panel.service
systemctl restart cs2-panel.service

PORT="$(jq -r .port "$CONFIG_DIR/panel.json")"
IP="$(hostname -I | awk '{print $1}')"
echo
log "Done. Open http://$IP:$PORT and sign in with Steam."
echo "   Updates later: sudo $PANEL_DIR/deploy/update.sh"
