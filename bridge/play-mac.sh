#!/bin/bash
# Start the bridge (in a Terminal window, unless it already runs), then open the
# game launcher, so the bridge is up before the game starts and the launcher
# still logs you in. `npm run app` wraps this in "WoW AI.app" for the Dock.
#
#   WOWAI_LAUNCHER  the app to open after the bridge (default: the World of
#                   Warcraft launcher next to the client in config.json, else
#                   /Applications/World of Warcraft/World of Warcraft Launcher.app)
set -u
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if ! pgrep -f "$REPO/bridge/supervisor.js" >/dev/null && ! pgrep -f "node bridge/supervisor.js" >/dev/null; then
  osascript - "$REPO" <<'OSA'
on run argv
  set repo to item 1 of argv
  tell application "Terminal"
    do script "cd " & quoted form of repo & " && npm start"
    activate
  end tell
end run
OSA
  # Give the bridge a moment to restore the signal files before the game launches.
  for _ in $(seq 1 20); do
    pgrep -f "bridge/bridge.js" >/dev/null && break
    sleep 0.5
  done
  sleep 2
fi

LAUNCHER="${WOWAI_LAUNCHER:-}"
if [ -z "$LAUNCHER" ]; then
  ADDONS="$(node -e 'try{console.log(require(process.argv[1]).addonDir||"")}catch{}' "$REPO/bridge/config.json")"
  if [ -n "$ADDONS" ]; then
    # .../World of Warcraft/_forever_/Interface/AddOns -> .../World of Warcraft
    CAND="$(dirname "$(dirname "$(dirname "$ADDONS")")")/World of Warcraft Launcher.app"
    [ -d "$CAND" ] && LAUNCHER="$CAND"
  fi
fi
LAUNCHER="${LAUNCHER:-/Applications/World of Warcraft/World of Warcraft Launcher.app}"
open "$LAUNCHER"
