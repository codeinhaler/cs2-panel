#!/usr/bin/env bash
# Builds the companion plugin and packs it the way CounterStrikeSharp expects.
#   bridge/package.sh <output.zip>
set -euo pipefail
out="$(realpath -m "${1:?usage: package.sh <output.zip>}")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
dotnet publish "$here/Cs2PanelBridge/Cs2PanelBridge.csproj" -c Release -o "$work/build" --nologo
mkdir -p "$work/pkg/counterstrikesharp/plugins/Cs2PanelBridge"
cp "$work/build/Cs2PanelBridge.dll" "$work/pkg/counterstrikesharp/plugins/Cs2PanelBridge/"
rm -f "$out"
(cd "$work/pkg" && zip -qr "$out" .)
echo "built $out"
