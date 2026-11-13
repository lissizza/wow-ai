#!/bin/bash
# Start the bridge (in a Terminal window, unless it already runs), then bring up
# the Battle.net app, so the bridge is up before the game starts and Battle.net
# still logs you in. `npm run app` wraps this in "WoW AI.app" for the Dock.
#
# Not "World of Warcraft Launcher.app" in the game folder: that is Blizzard's
# installer stub (net.battle.bootstrapper). It downloads a new Battle.net agent
# and shows the retail "Install World of Warcraft" window instead of the launcher.
#
#   WOWAI_LAUNCHER  the app to open after the bridge (default: Battle.net, by its
#                   bundle id: started if needed, else brought to the front)
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

if [ -n "${WOWAI_LAUNCHER:-}" ]; then
  open "$WOWAI_LAUNCHER"
else
  open -b net.battle.app
fi
