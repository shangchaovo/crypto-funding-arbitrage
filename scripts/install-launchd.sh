#!/bin/zsh
set -euo pipefail

ROOT="__HOME__/Documents/crypto资金套利"
LABEL="com.local.funding-dashboard"
DOMAIN="gui/$(id -u)"
PLIST_SOURCE="$ROOT/launchd/$LABEL.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$ROOT/logs"

cp "$PLIST_SOURCE" "$PLIST_TARGET"
plutil -lint "$PLIST_TARGET"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
fi

EXISTING_PID="$(lsof -tiTCP:8768 -sTCP:LISTEN | head -1 || true)"
if [[ -n "$EXISTING_PID" ]]; then
  kill "$EXISTING_PID"
fi

launchctl bootstrap "$DOMAIN" "$PLIST_TARGET"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed $LABEL"
echo "Open http://localhost:8768"
