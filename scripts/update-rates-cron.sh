#!/bin/bash
# ============================================================================
# funding-arb 公共站数据保鲜(launchd 每 10min 触发)
#   本机全量抓数 → data/rates.json → 有变更则【wrangler 部署上线 + git 备份】。
#   注意:该 Pages 项目是 direct-upload(未连 GitHub),git push 不会更新线上,
#   必须 wrangler pages deploy 才生效。替代从未运行的 GitHub Action(token 缺
#   workflow 权限推不上 yml)。抓数失败 / 无变更 / 部署失败都只记日志,下轮再来。
# ============================================================================
set -u
export PATH="/opt/homebrew/bin:__HOME__/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="__HOME__"
REPO="__HOME__/funding-arb-build"
cd "$REPO" || exit 1

TS() { date '+%F %T'; }

# 1) 全量抓数(经本地代理;失败保留旧文件并退出,下轮再来)
if ! node scripts/refresh-rates-local.js; then
  echo "$(TS) fetch failed, skip"
  exit 0
fi

# 2) rates.json 相对上次提交有变更才继续(避免空转)
if git diff --quiet -- data/rates.json && git diff --cached --quiet -- data/rates.json; then
  echo "$(TS) no change"
  exit 0
fi

# 3) 部署上线(direct-upload 站点,这是让公网生效的唯一途径)
if [ -f "$HOME/.config/cloudflare/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.config/cloudflare/env"
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
fi
if sh scripts/deploy-cloudflare-pages.sh >/dev/null 2>&1; then
  echo "$(TS) deployed"
else
  echo "$(TS) deploy failed"
fi

# 4) git 备份(尽力而为,失败不影响线上)
git add data/rates.json scripts/refresh-rates-local.js 2>/dev/null
if ! git diff --cached --quiet; then
  git -c user.name="shangchaovo" -c user.email="shangchaoxie888@gmail.com" \
    commit -q -m "chore: update funding rates (local prefetch)" 2>/dev/null
  git push origin main >/dev/null 2>&1 && echo "$(TS) pushed backup" || echo "$(TS) backup push failed"
fi
exit 0
