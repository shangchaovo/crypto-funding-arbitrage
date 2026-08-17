#!/bin/zsh
set -euo pipefail

LABEL="com.local.funding-dashboard"
DOMAIN="gui/$(id -u)"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
fi

rm -f "$PLIST_TARGET"

echo "Uninstalled $LABEL"
