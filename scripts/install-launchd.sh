#!/bin/zsh
set -euo pipefail

# 安装/重装两个 launchd job:本地看板(8768 常驻) + 费率刷新(每 10min)。
# launchd/*.plist.template 里的 __HOME__ 在装载时渲染成本机家目录,模板本身可公开。

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"
LABELS=(com.local.funding-dashboard com.local.funding-rates-updater)

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"

# 8768 若被手动起的 node server.js 占用,先让位
EXISTING_PID="$(lsof -tiTCP:8768 -sTCP:LISTEN | head -1 || true)"
if [[ -n "$EXISTING_PID" ]]; then
  kill "$EXISTING_PID" || true
fi

for LABEL in "${LABELS[@]}"; do
  TEMPLATE="$ROOT/launchd/$LABEL.plist.template"
  TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
  sed "s|__HOME__|$HOME|g" "$TEMPLATE" > "$TARGET"
  plutil -lint "$TARGET"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL"
  fi
  launchctl bootstrap "$DOMAIN" "$TARGET"
  launchctl enable "$DOMAIN/$LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"
  echo "Installed $LABEL"
done

echo "Open http://localhost:8768"
