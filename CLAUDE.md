# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**统一多板块加密终端**(`crypto-funding-arbitrage.pages.dev`):单页应用,4 个即插即用板块——💰 资金费率套利(现货-永续 + 跨所)、🔥 Meme 异动、📉 主力清算热图、🧱 期权 Wall。覆盖 gate/mexc/bitget/okx/hyperliquid/dydx **全量合约(~3000 行)**;Binance/Bybit 被地区封锁(451/403),适配器保留但默认跳过。

无构建系统、无框架、无包管理器:纯 Vanilla JS(ES Modules)+ HTML + CSS + 极简 Node 静态服务器。主题为**浅色「瓷感」**(白卡 + 浅冷灰页面 + 柔和分层投影 + 低饱和多色),曾是深色终端,2026-08-23 改版。

## Running

```bash
node server.js                    # 开发,默认端口 8765(注意:8765 常被别的本地看板占用)
PORT=8779 node server.js          # 自定义端口
```

**生产**(launchd 常驻,`com.local.funding-dashboard`,PORT=8768):
```bash
launchctl kickstart -k gui/$(id -u)/com.local.funding-dashboard   # 硬重启
tail -f logs/server.out.log logs/server.err.log
```

## 部署(最重要的非显而易见点)

**这个 Pages 项目是 direct-upload(Wrangler 直传),从未连接 GitHub。** 所以:

> **`git push` 不会更新线上站点。** 改完代码/数据后,必须跑部署脚本才会生效:

```bash
source ~/.config/cloudflare/env        # 提供 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
sh scripts/deploy-cloudflare-pages.sh  # 拷 index.html + assets/css/data/js/functions 到临时目录,wrangler pages deploy
```

部署脚本只上传公共资产(自动排除 `.git`/`scripts`/`logs`/`launchd`)。`git push` 到 `shangchaovo/crypto-funding-arbitrage`(私有)只做**备份**,不影响线上。Cloudflare 凭据在 `~/.config/cloudflare/env`,account `***REMOVED***`。

## 数据保鲜(为何不再是 GitHub Actions)

公共站兜底缓存 `data/rates.json` 需保持 <15min(否则全标「陈旧」)。原 GitHub Action(`fetch-rates.yml`)因 **gh token 缺 `workflow` scope 推不上去**(`.github/` 已 gitignore),从未运行;且 direct-upload 下就算能跑也只更新 repo、不更新线上。

现由本机 launchd 替代:**`com.local.funding-rates-updater`(每 10min)** → `scripts/update-rates-cron.sh`:
1. `scripts/refresh-rates-local.js` 经本地代理全量抓 6 所(镜像 `js/api.js` 适配器),写 `data/rates.json`,全挂则保留旧文件;
2. 有变更则 `deploy-cloudflare-pages.sh` 上线 + `git push` 备份。日志 `logs/rates-updater.log`。

`scripts/fetch-rates.js` 是**旧的 GitHub Action 版**(只 40 币、缺 gate/mexc),已被 `refresh-rates-local.js` 取代,别再改它。

## Data Architecture

浏览器取数三级(`js/api.js:fetchRates`),**永不回退到模拟数据**:

1. **实时直连(主路径)**:`fetchDirect` 并行抓各所,单所失败不拖垮整体(`withExchangeTimeout` 15s 盖帽 + `onPartial` 快档先渲染首屏,OKX 逐币是慢档后并入)。
2. **CORS 代理**(`apiUrl()`):非 `data/` 的 https 请求一律走 `/proxy?url=…`——公网由 **`functions/proxy.js`(Pages Function,Cloudflare 边缘取数,不被墙)** 处理;本地由 **`server.js` 的 `/proxy`** 处理(用系统 `curl` 而非 Node fetch,绕开本环境 HTTPS/TLS 问题;显式 `--proxy` 覆盖继承的 `ALL_PROXY`)。白名单在 `config/exchanges.json`,改交易所要**同步改 `functions/proxy.js` 顶部的 `ALLOWED_HOSTS`**。
3. **兜底缓存**:`data/rates.json`(launchd 每 10min 刷新)。仅当 <5min 才直接用(`LOCAL_CACHE_MAX_AGE_MS`);实时全挂时合并旧真实行并标 `fallback`。

**费率归一**:所有费率折算成 8h 等价(`rate8h = fundingRate × 8/intervalHours`,在 `arbitrage.js`;hyperliquid/dydx 是 1h,其余 8h)。

**时效诚实 / 置信分级**(`arbitrage.js`):每条数据自带 `fetchedAt`,**>15min(`FRESH_MS`)即标 `stale` → 置信「陈旧」**;另有伪套利识别(恰好为零、卡 +0.01% 上限窄带)。设置里可「隐藏低置信」。

## Frontend Architecture

**外壳 + 即插即用板块**(`js/app.js` 的 `BOARD_DEFS` 注册一个 `create` 工厂即接入):

| 层 | 文件 | 职责 |
|---|---|---|
| 外壳 | `js/app.js` | hash 路由(`#/funding|meme|liquidation|options`)、板块生命周期、刷新编排(各板块 `autoMs` 自动轮询,页面不可见暂停)、设置抽屉、历史图 Modal、盈亏模拟、快捷键(1-4 切板块/R 刷新/Shift+S 设置) |
| 共享 | `js/ui.js` | `h()` hyperscript、格式化(`fmtPct`/`fmtApr`/`fmtUsdCompact`…)、`toast`、徽章(`confBadge`/`chainBadge`/`stageBadge`/`safetyBadge`)、`volGauge`/`momentumBar`、`symAvatar`、骨架屏、CSV 导出 |
| 资金费率 | `js/api.js`(数据)+ `js/boards/funding.js`(UI) | 8 所适配器、归一化、去重;三个子视图(现货-永续/跨所/全量矩阵) |
| 其余板块 | `js/{meme,liquidation,options}.js`(数据)+ `js/boards/{meme,liquidation,options}.js`(UI) | 同名数据层与 UI 层分离 |

**状态与渲染**:`js/boards/*.js` 各自持有局部 `state`,数据变更后显式 `renderAll()`;无响应式框架。大表格**截断显示**(套利表前 400、全量矩阵前 500),不再是旧版的虚拟滚动。

**板块秒回**:`switchBoard` 保住实例与数据;`mount` 三级——会话内已有数据直接渲染(超龄才后台静默刷),冷载才骨架+强刷。Meme 另有 localStorage 持久快照(`memeBoardCacheV1`)。

**历史走势图**:双击表格行 → `history.js` 用 IndexedDB(`fundingHistory`)存每币快照,画 24h SVG 折线。`CHART_COLORS` 是浅色主题可读配色(OKX 用深石板灰,近白线在白底会看不见)。

## Conventions

- **ES Modules**:每个数据/共享文件 `export const Xxx = {...}`;板块 `export function createXxxBoard(ctx)`。`index.html` 只以 `type="module"` 载 `app.js`。
- **缓存戳(易踩坑)**:**所有模块 import 都带 `?v=YYYYMMDD`(连 `app.js` 内部的 `./api.js?v=…` 等也一样)。改任何 JS/CSS 必须全项目统一 bump 这个戳**,否则老用户浏览器吃缓存的旧模块。当前戳 `20260823`。
- **主题**:改配色只动 `css/styles.css` 的 `:root` 令牌(表面/文字/点缀/投影)。徽章用「彩字 + 淡彩底 + 细描边」;绿=正/多、红=负/空语义全站统一。
- **交易所顺序**:`EXCHANGE_ORDER = ["gate","mexc","bitget","okx","hyperliquid","dydx","binance","bybit"]`(`api.js`),用于表头/状态条/图例。
- **百分比两路格式化**:资金费率是分数(用 `fmtPct` ×100);meme 的 `chg` 已是百分数(用 `fmtPctPoint` 不 ×100)。混用会 ×100 错误。

## Testing

无统一 runner,是 scripts/ 下的确定性单测(mock 浏览器全局跑真实模块):

```bash
node scripts/test-meme-progressive.mjs   # Meme 渐进渲染 + 貔貅防线回归(改 meme 数据层必跑,18 断言)
node scripts/test-arbitrage.mjs          # 套利纯函数断言(可选安全网)
python3 scripts/test-cloudflare-deployment.py  # 部署后线上校验
```

**貔貅/rug 防线是用户硬性安全要求**:Meme 板块宁可标「检测中」也绝不把未检测的 token 标「安全」;`fetchSecurity` 的已检判定看 `_secChecked` 标记(不看 `risk`),别改回去(见 test-meme-progressive.mjs 防的回归)。
