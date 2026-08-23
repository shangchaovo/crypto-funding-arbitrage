#!/bin/zsh
set -euo pipefail

DOMAIN="gui/$(id -u)"
for LABEL in com.local.funding-dashboard com.local.funding-rates-updater; do
  TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL"
  fi
  rm -f "$TARGET"
  echo "Uninstalled $LABEL"
done
