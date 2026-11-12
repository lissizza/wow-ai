#!/bin/bash
# Builds ~/Applications/WoW AI.app: double-click (or keep in the Dock) to start
# the bridge and then the game launcher (bridge/play-mac.sh).
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/WoW AI.app"
mkdir -p "$HOME/Applications"
rm -rf "$APP"
osacompile -o "$APP" -e "do shell script quoted form of \"$REPO/bridge/play-mac.sh\""
echo "Made $APP"
