# Shared functions for install.sh and update.sh. Sourced, not executed.
# shellcheck shell=bash

GITHUB_REPO="${CS2PANEL_REPO:-codeinhaler/cs2-panel}"
TOKEN_FILE="/etc/cs2-panel/github-token"
PANEL_DIR="/opt/cs2-panel"
ASSET_NAME="cs2-panel-linux-x64.tar.gz"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mxx\033[0m %s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ $EUID -eq 0 ]] || die "Run this script as root (e.g. with sudo)."
}

# Reads the GitHub token used to download releases from the private repo.
# Prompts for it and stores it (root-only) if it isn't saved yet.
github_token() {
  if [[ ! -s "$TOKEN_FILE" ]]; then
    echo >&2
    echo "The repository is private, so a GitHub token is needed to download releases." >&2
    echo "Create a fine-grained token at https://github.com/settings/personal-access-tokens" >&2
    echo "  - Repository access: only $GITHUB_REPO" >&2
    echo "  - Permissions: Contents = Read-only" >&2
    local token
    read -r -s -p "Paste the token: " token </dev/tty
    echo >&2
    [[ -n "$token" ]] || die "No token given."
    install -d -m 0750 /etc/cs2-panel
    (umask 077 && printf '%s\n' "$token" >"$TOKEN_FILE")
  fi
  tr -d '[:space:]' <"$TOKEN_FILE"
}

# download_release <tag|latest> <output file>
download_release() {
  local tag="$1" out="$2" token api release asset_url
  token="$(github_token)"
  if [[ "$tag" == "latest" ]]; then
    api="https://api.github.com/repos/$GITHUB_REPO/releases/latest"
  else
    api="https://api.github.com/repos/$GITHUB_REPO/releases/tags/$tag"
  fi
  release="$(curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" "$api")" ||
    die "Could not read release '$tag' from GitHub. Check the token and that a release exists."
  asset_url="$(jq -r --arg n "$ASSET_NAME" '.assets[] | select(.name == $n) | .url' <<<"$release")"
  [[ -n "$asset_url" && "$asset_url" != "null" ]] || die "Release '$tag' has no $ASSET_NAME asset."
  log "Downloading $(jq -r .tag_name <<<"$release")"
  curl -fL --progress-bar -H "Authorization: Bearer $token" -H "Accept: application/octet-stream" \
    -o "$out" "$asset_url" || die "Download failed."
}

# install_panel_files <tarball>
# Unpacks a release into $PANEL_DIR, keeping the previous version as $PANEL_DIR.prev.
install_panel_files() {
  local tarball="$1" staging
  staging="$(mktemp -d)"
  tar -xzf "$tarball" -C "$staging"
  [[ -f "$staging/cs2-panel/server.mjs" ]] || die "Tarball does not look like a cs2-panel release."
  rm -rf "$PANEL_DIR.prev"
  [[ -d "$PANEL_DIR" ]] && mv "$PANEL_DIR" "$PANEL_DIR.prev"
  mv "$staging/cs2-panel" "$PANEL_DIR"
  rmdir "$staging"
  chown -R root:root "$PANEL_DIR"
  chmod -R go-w "$PANEL_DIR"
}

# install_host_files <dir containing cs2ctl, systemd/, sudoers.d/>
install_host_files() {
  local src="$1"
  install -d -m 0755 /usr/local/lib/cs2-panel
  install -m 0755 -o root -g root "$src/cs2ctl" /usr/local/lib/cs2-panel/cs2ctl
  install -m 0644 "$src"/systemd/*.service /etc/systemd/system/
  local tmp
  tmp="$(mktemp)"
  cp "$src/sudoers.d/cs2-panel" "$tmp"
  visudo -cqf "$tmp" || die "sudoers file failed validation"
  install -m 0440 -o root -g root "$tmp" /etc/sudoers.d/cs2-panel
  rm -f "$tmp"
  systemctl daemon-reload
}
