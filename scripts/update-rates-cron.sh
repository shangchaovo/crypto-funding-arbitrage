#!/bin/bash
# ============================================================================
# funding-arb 公共站兜底缓存更新器(launchd 每 10min 触发)
#   本机全量抓数 → data/rates.json → 有变更才 commit + push(触发 Pages 重建)。
#   替代从未运行的 GitHub Action(token 缺 workflow 权限推不上 yml)。
#   抓数失败 / 无变更 / push 失败都只记日志,不污染环境,下轮再来。
# ============================================================================
set -u
export PATH="/opt/homebrew/bin:__HOME__/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="__HOME__"
REPO="__HOME__/funding-arb-build"
cd "$REPO" || exit 1

# 只在本分支干净跟踪时动 data/rates.json;其它未提交改动一概不碰
node scripts/refresh-rates-local.js || { echo "$(date '+%F %T') fetch failed, skip"; exit 0; }

git add data/rates.json
if git diff --cached --quiet -- data/rates.json; then
  echo "$(date '+%F %T') no change"
  exit 0
fi

git -c user.name="shangchaovo" -c user.email="shangchaoxie888@gmail.com" \
  commit -q -m "chore: update funding rates (local prefetch)" || { echo "$(date '+%F %T') commit failed"; exit 0; }

if git push origin main >/dev/null 2>&1; then
  echo "$(date '+%F %T') pushed"
else
  echo "$(date '+%F %T') push failed (保留本地提交,下轮重试 push)"
fi
exit 0
