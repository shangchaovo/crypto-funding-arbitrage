// ============================================================================
// 本地全量抓数 → data/rates.json(替代从未跑起来的 GitHub Action)
//   背景:公共站 crypto-funding-arbitrage.pages.dev 的兜底缓存依赖提交进仓库的
//   data/rates.json。原 GitHub Action 因 token 缺 workflow 权限推不上去,从未运行,
//   缓存一度停在 7 周前,实时拉取一抖动就全标「陈旧」。
//   本脚本在本机(24h 常驻)经本地代理抓全量合约,由 launchd 每 10min 触发,
//   再由 scripts/update-rates-cron.sh 视变更 commit+push。
//   适配器逻辑镜像 js/api.js(同一批全量端点 + OKX 逐币主流币),保持兜底与实时同构。
// ============================================================================
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "data", "rates.json");
const PROXY = process.env.FUNDING_PROXY || "http://127.0.0.1:1082";
const MIN_ROWS = 500; //  sanity 下限:全量应有几千行,低于此视为抓取异常,保留旧文件

// 与 js/api.js 一致的主流币清单(仅用于 OKX 逐币精编;全量端点不过滤币种)
const MAJORS = [
  "BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "TRX", "LINK",
  "DOT", "LTC", "BCH", "UNI", "ATOM", "ETC", "FIL", "APT", "ARB", "OP",
  "SUI", "NEAR", "AAVE", "INJ", "TIA", "SEI", "WLD", "ORDI", "PEPE", "SHIB",
  "TON", "HBAR", "ICP", "FET", "GALA", "DYDX", "STRK", "WIF", "JUP", "BONK",
  "FLOKI", "ENA", "PENDLE", "ONDO", "RENDER", "TAO", "MKR", "LDO", "IMX", "STX",
];

const FUNDING_INTERVAL_HOURS = {
  binance: 8, okx: 8, bybit: 8, gate: 8, mexc: 8, bitget: 8, hyperliquid: 1, dydx: 1,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toNumber = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
function toTimestamp(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 10_000_000_000 ? n * 1000 : n;
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : null;
}

// 与 js/api.js 完全一致的归一化(把各种合约命名收敛为基础币)
function normalizeSymbol(symbol) {
  if (!symbol) return "";
  let s = String(symbol).toUpperCase().trim();
  s = s
    .replace(/[-_]?USDT[-_]?SWAP$/i, "")
    .replace(/[-_]?USDT[-_]?PERP(ETUAL)?$/i, "")
    .replace(/[-_]?USD[-_]?PERP(ETUAL)?$/i, "")
    .replace(/[-_]?USDT$/i, "")
    .replace(/[-_]?USD$/i, "")
    .replace(/[-_]?PERP(ETUAL)?$/i, "")
    .replace(/[-_]SWAP$/i, "");
  return s;
}
function isDeliveryFuture(rawSymbol) {
  const s = String(rawSymbol || "");
  return /[-_]\d{8}$/.test(s) || /[-_]\d{2}[A-Z]{3}\d{2}$/.test(s);
}
function normalizeRate(input) {
  const fundingRate = toNumber(input.fundingRate ?? input.rate ?? input.rate8h ?? input.rawRate);
  if (!input || !input.symbol || !input.exchange || fundingRate === null) return null;
  const exchange = String(input.exchange).toLowerCase();
  return {
    symbol: normalizeSymbol(input.symbol),
    exchange,
    fundingRate,
    intervalHours: toNumber(input.intervalHours) || FUNDING_INTERVAL_HOURS[exchange] || 8,
    markPrice: toNumber(input.markPrice ?? input.price ?? input.oraclePrice),
    indexPrice: toNumber(input.indexPrice ?? input.index),
    nextFundingTime: toTimestamp(input.nextFundingTime ?? input.nextFundingAt),
    volume24h: toNumber(input.volume24h ?? input.quoteVolume ?? input.usdtVolume),
    openInterest: toNumber(input.openInterest ?? input.oi ?? input.holdVol),
    fetchedAt: input.fetchedAt || new Date().toISOString(),
  };
}

// 系统 curl 经本地代理(显式 --proxy 覆盖 ALL_PROXY);Node fetch 在本网络不稳
function curlJson(url, { method = "GET", headers = {}, body, maxTimeSec = 20, connectSec = 8 } = {}) {
  const args = ["-L", "--fail-with-body", "-sS",
    "--proxy", PROXY,
    "--connect-timeout", String(connectSec),
    "--max-time", String(maxTimeSec)];
  if (method === "POST") args.push("-X", "POST");
  Object.entries(headers).forEach(([k, v]) => args.push("-H", `${k}: ${v}`));
  if (body) args.push("--data", body);
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile("curl", args, { maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) => {
      if (err) return reject(new Error(stderr || out || err.message));
      try { resolve(out ? JSON.parse(out) : null); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
    });
  });
}
async function fetchWithRetry(url, opts = {}, attempts = 2) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try { return await curlJson(url, opts); } catch (e) { last = e; if (i < attempts) await sleep(800); }
  }
  throw last;
}
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

// ── 全量适配器(镜像 js/api.js;binance/bybit 地区封锁,此处直接省略)────────────
const EXCHANGES = {
  gate: async () => {
    const p = await fetchWithRetry("https://api.gateio.ws/api/v4/futures/usdt/tickers");
    return (Array.isArray(p) ? p : [])
      .filter((i) => i && i.contract && i.contract.endsWith("_USDT") && !isDeliveryFuture(i.contract))
      .map((i) => normalizeRate({ symbol: i.contract, exchange: "gate", fundingRate: i.funding_rate, markPrice: i.mark_price, indexPrice: i.index_price, volume24h: i.volume_24h_quote ?? i.volume_24h, intervalHours: 8 }))
      .filter(Boolean);
  },
  mexc: async () => {
    const p = await fetchWithRetry("https://contract.mexc.com/api/v1/contract/ticker");
    return (((p && p.data) || []))
      .filter((i) => i && i.symbol && i.symbol.endsWith("_USDT"))
      .map((i) => normalizeRate({ symbol: i.symbol, exchange: "mexc", fundingRate: i.fundingRate, markPrice: i.fairPrice ?? i.lastPrice, indexPrice: i.indexPrice, volume24h: i.amount24, openInterest: i.holdVol, intervalHours: 8 }))
      .filter(Boolean);
  },
  bitget: async () => {
    const p = await fetchWithRetry("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES");
    return (((p && p.data) || []))
      .filter((i) => i && i.symbol && i.symbol.endsWith("USDT") && !isDeliveryFuture(i.symbol))
      .map((i) => normalizeRate({ symbol: i.symbol, exchange: "bitget", fundingRate: i.fundingRate, markPrice: i.markPrice, indexPrice: i.indexPrice, volume24h: i.usdtVolume ?? i.quoteVolume, openInterest: i.holdingAmount, intervalHours: 8 }))
      .filter(Boolean);
  },
  hyperliquid: async () => {
    const p = await fetchWithRetry("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }) });
    const universe = (p && p[0] && p[0].universe) || [];
    const contexts = (p && p[1]) || [];
    return universe.map((asset, idx) => {
      const c = contexts[idx] || {};
      if (asset.isDelisted) return null;
      return normalizeRate({ symbol: asset.name, exchange: "hyperliquid", fundingRate: c.funding, markPrice: c.markPx, indexPrice: c.oraclePx, openInterest: c.openInterest, volume24h: c.dayNtlVlm, intervalHours: 1 });
    }).filter(Boolean);
  },
  dydx: async () => {
    const p = await fetchWithRetry("https://indexer.dydx.trade/v4/perpetualMarkets");
    const markets = (p && p.markets) || {};
    return Object.values(markets)
      .filter((m) => m && m.status === "ACTIVE")
      .map((m) => normalizeRate({ symbol: m.ticker, exchange: "dydx", fundingRate: m.nextFundingRate, markPrice: m.oraclePrice, openInterest: m.openInterest, volume24h: m.volume24H, intervalHours: 1 }))
      .filter(Boolean);
  },
  // OKX 无全量 funding 端点,逐币精编主流币(币种与 gate/mexc/bitget 高度重叠,慢也不阻塞)
  okx: async () => {
    const mark = await fetchWithRetry("https://www.okx.com/api/v5/public/mark-price?instType=SWAP", { connectSec: 6, maxTimeSec: 12 }, 1);
    const marks = new Map(((mark && mark.data) || []).map((i) => [i.instId, toNumber(i.markPx)]));
    const rows = [];
    const groups = chunk(MAJORS, 10);
    for (const group of groups) {
      const batch = await Promise.all(group.map(async (symbol) => {
        try {
          const instId = `${symbol}-USDT-SWAP`;
          const p = await fetchWithRetry(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`, { connectSec: 5, maxTimeSec: 8 }, 1);
          const item = p && p.data && p.data[0];
          return item ? normalizeRate({ symbol, exchange: "okx", fundingRate: item.fundingRate, markPrice: marks.get(instId), nextFundingTime: item.nextFundingTime, intervalHours: 8 }) : null;
        } catch { return null; }
      }));
      rows.push(...batch.filter(Boolean));
      if (group !== groups[groups.length - 1]) await sleep(200);
    }
    return rows;
  },
};

// 单所墙钟超时,防某家挂起阻塞整体
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("exchange-timeout")), ms))]);
}

// 按 exchange:symbol 去重,保留 24h 量最大的一条(与 js/api.js dedupeRates 一致)
function dedupeRates(rates) {
  const best = new Map();
  (rates || []).forEach((r) => {
    if (!r || !r.symbol || !r.exchange) return;
    const key = `${r.exchange}:${r.symbol}`;
    const ex = best.get(key);
    if (!ex || (Number(r.volume24h) || 0) > (Number(ex.volume24h) || 0)) best.set(key, r);
  });
  return Array.from(best.values());
}

async function main() {
  let previous = null;
  if (fs.existsSync(OUTPUT)) {
    try { previous = JSON.parse(fs.readFileSync(OUTPUT, "utf8")); } catch { previous = null; }
  }

  const exchangeStatus = {};
  const settled = await Promise.all(Object.entries(EXCHANGES).map(async ([id, fetcher]) => {
    try {
      const rows = await withTimeout(fetcher(), 30_000);
      exchangeStatus[id] = { status: rows.length ? "ok" : "error", error: rows.length ? "" : "No rows" };
      return rows;
    } catch (e) {
      exchangeStatus[id] = { status: "error", error: String((e && e.message) || e) };
      return [];
    }
  }));

  let rates = dedupeRates(settled.flat());

  // 单所全挂时,保留其上一份真实缓存行(标记 fallback),不用模拟数据补位
  const liveEx = new Set(rates.map((r) => r.exchange));
  if (previous && Array.isArray(previous.rates)) {
    Object.keys(EXCHANGES).forEach((ex) => {
      if (exchangeStatus[ex].status === "ok" || liveEx.has(ex)) return;
      const stale = previous.rates.filter((r) => r.exchange === ex);
      if (stale.length) { rates = rates.concat(stale); exchangeStatus[ex] = { status: "fallback", error: "Using previous cached rows" }; }
    });
  }

  if (rates.length < MIN_ROWS) {
    console.warn(`[refresh-rates] only ${rates.length} rows (< ${MIN_ROWS}), keeping existing rates.json`);
    process.exit(0); // 不覆盖旧缓存
  }

  const payload = { fetchedAt: new Date().toISOString(), source: "prefetch-local", exchangeStatus, rates };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  const ok = Object.values(exchangeStatus).filter((s) => s.status === "ok").map((_, i) => Object.keys(exchangeStatus)[i]);
  console.log(`[refresh-rates] wrote ${rates.length} rows; ok=${ok.join(",") || "none"}`);
}

main().catch((e) => { console.error("[refresh-rates] fatal:", e); process.exit(1); });
