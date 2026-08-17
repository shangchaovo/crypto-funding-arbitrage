// ============================================================================
// 数据层:交易所适配器(永续资金费 + 现货价)
// 设计:全部实时拉取(保证时效),单交易所失败不拖垮整体,诚实标记每家状态。
// 覆盖面:放开旧版 40 币硬编码上限,摄取每家返回的全部 USDT 永续(3000+ 合约)。
// Binance/Bybit 本机与 Cloudflare 边缘实测均被地区封锁(451/403)——适配器保留,
// 默认标记 region-blocked 跳过;后续换到可达节点后,从 REGION_BLOCKED 移除即可重开。
// ============================================================================

const EXCHANGE_ORDER = ["gate", "mexc", "bitget", "okx", "hyperliquid", "dydx", "binance", "bybit"];

const EXCHANGE_NAMES = {
  binance: "Binance",
  okx: "OKX",
  bybit: "Bybit",
  gate: "Gate.io",
  mexc: "MEXC",
  bitget: "Bitget",
  hyperliquid: "Hyperliquid",
  dydx: "dYdX",
};

// 地区封锁(实测):这两家在本机与边缘都不可达。保留适配器以便未来换节点重开。
const REGION_BLOCKED = new Set(["binance", "bybit"]);

// 各交易所资金费结算周期(小时),用于把原始费率归一化成 8h 等价,再年化。
// 多数 USDT 永续为 8h;Hyperliquid / dYdX 为 1h。(个别热门币会被临时调成 1h/4h,见 normalizeRate 注释)
const FUNDING_INTERVAL_HOURS = {
  binance: 8, okx: 8, bybit: 8, gate: 8, mexc: 8, bitget: 8, hyperliquid: 1, dydx: 1,
};

// 主流币:仅用于 OKX 逐币精编(它没有全量 funding 端点,447 个逐币太慢)与排序置顶,不过滤其它币种。
const MAJORS = [
  "BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "TRX", "LINK",
  "DOT", "LTC", "BCH", "UNI", "ATOM", "ETC", "FIL", "APT", "ARB", "OP",
  "SUI", "NEAR", "AAVE", "INJ", "TIA", "SEI", "WLD", "ORDI", "PEPE", "SHIB",
  "TON", "HBAR", "ICP", "FET", "GALA", "DYDX", "STRK", "WIF", "JUP", "BONK",
  "FLOKI", "ENA", "PENDLE", "ONDO", "RENDER", "TAO", "MKR", "LDO", "IMX", "STX",
];

const LOCAL_CACHE_MAX_AGE_MS = 5 * 60_000; // 预取缓存门槛:超过 5 分钟就放弃缓存去直连
const BYBIT_REST_BASES = [
  "https://api.bybit.com",
  "https://api.bytick.com",
  "https://api.bybit.eu",
  "https://api.byhkbit.com",
  "https://api.bybit-tr.com",
  "https://api.bybit.kz",
]; // Bybit 主域常按地区 403,按官方/区域域名顺序尝试(默认仍被 region-blocked 跳过)

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isLocalhost() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function apiUrl(url, { direct = false } = {}) {
  if (!/^https?:\/\//i.test(url)) return url; // 本地 data/*.json 不走 CORS 代理
  // 本地由 server.js 代理,公网由 Cloudflare Pages Function 代理;direct=1 跳过代理直连兜底
  if (direct) return isLocalhost() ? `/proxy?url=${encodeURIComponent(url)}&direct=1` : url;
  return `/proxy?url=${encodeURIComponent(url)}`;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) {
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// 归一化币种为基础币:处理 BTC-USDT-SWAP / BTC_USDT / BTCUSDT / BTC-USD / BTCPERP 等各种命名
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

// 交割合约(非永续)识别:BTC_USDT_20240927 / BTC-27SEP24 等带日期后缀的,过滤掉
function isDeliveryFuture(rawSymbol) {
  const s = String(rawSymbol || "");
  return /[-_]\d{8}$/.test(s) || /[-_]\d{2}[A-Z]{3}\d{2}$/.test(s);
}

// 单条资金费率归一化。rate8h 由 arbitrage.js 用 intervalHours 统一折算(此处不重复算)。
function normalizeRate(input) {
  if (!input || !input.symbol || !input.exchange) return null;
  const fundingRate = toNumber(input.fundingRate ?? input.rate ?? input.rate8h ?? input.rawRate);
  if (fundingRate === null) return null;
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

async function readResponseWithTimeout(response, timeoutMs = 15_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`Read timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([response.text().then((text) => (text ? JSON.parse(text) : null)), timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchJsonOnce(url, options = {}) {
  const doFetch = async (direct) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), options.connectTimeoutMs || 6_000);
    try {
      const response = await fetch(apiUrl(url, { direct }), {
        method: options.method || "GET",
        headers: options.headers || undefined,
        body: options.body || undefined,
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await readResponseWithTimeout(response, options.readTimeoutMs || 15_000);
    } catch (error) {
      window.clearTimeout(timer);
      throw error;
    }
  };
  try {
    return await doFetch(false); // 先走代理
  } catch (proxyError) {
    if (options.direct) throw proxyError;
    try {
      return await doFetch(true); // 代理失败回退直连兜底
    } catch (directError) {
      throw proxyError;
    }
  }
}

async function fetchWithRetry(url, options = {}) {
  const attempts = options.attempts || 2;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJsonOnce(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(options.retryDelayMs || 1_000);
      }
    }
  }
  throw lastError;
}

async function fetchFirstAvailableJson(urls, options = {}) {
  let lastError;
  for (const url of urls) {
    try {
      return await fetchWithRetry(url, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function makeStatus(status, error) {
  return { status, error: error ? String(error.message || error) : "" };
}

// 单交易所墙钟超时:防止某家(如逐币的 OKX)阻塞整体 Promise.all。
// 快速交易所(gate/mexc/bitget/hl/dydx)1-3s 返回,慢的被盖帽后标记 error,其余正常上板。
const PER_EXCHANGE_TIMEOUT_MS = 15000;
function withExchangeTimeout(promise, ms = PER_EXCHANGE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("exchange-timeout")), ms)),
  ]);
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// ── 永续资金费适配器(全量,不过滤币种)────────────────────────────────────
const EXCHANGES = {
  gate: {
    async fetch() {
      const payload = await fetchWithRetry("https://api.gateio.ws/api/v4/futures/usdt/tickers");
      return (Array.isArray(payload) ? payload : [])
        .filter((item) => item && item.contract && item.contract.endsWith("_USDT") && !isDeliveryFuture(item.contract))
        .map((item) =>
          normalizeRate({
            symbol: item.contract,
            exchange: "gate",
            fundingRate: item.funding_rate,
            markPrice: item.mark_price,
            indexPrice: item.index_price,
            volume24h: item.volume_24h_quote ?? item.volume_24h,
            intervalHours: 8,
          }),
        )
        .filter(Boolean);
    },
  },

  mexc: {
    async fetch() {
      const payload = await fetchWithRetry("https://contract.mexc.com/api/v1/contract/ticker");
      const rows = (payload && payload.data) || [];
      return rows
        .filter((item) => item && item.symbol && item.symbol.endsWith("_USDT"))
        .map((item) =>
          normalizeRate({
            symbol: item.symbol,
            exchange: "mexc",
            fundingRate: item.fundingRate,
            markPrice: item.fairPrice ?? item.lastPrice,
            indexPrice: item.indexPrice,
            volume24h: item.amount24,
            openInterest: item.holdVol,
            intervalHours: 8,
          }),
        )
        .filter(Boolean);
    },
  },

  bitget: {
    async fetch() {
      const payload = await fetchWithRetry("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES");
      return ((payload && payload.data) || [])
        .filter((item) => item && item.symbol && item.symbol.endsWith("USDT") && !isDeliveryFuture(item.symbol))
        .map((item) =>
          normalizeRate({
            symbol: item.symbol,
            exchange: "bitget",
            fundingRate: item.fundingRate,
            markPrice: item.markPrice,
            indexPrice: item.indexPrice,
            volume24h: item.usdtVolume ?? item.quoteVolume,
            openInterest: item.holdingAmount,
            intervalHours: 8,
          }),
        )
        .filter(Boolean);
    },
  },

  hyperliquid: {
    async fetch() {
      const payload = await fetchWithRetry("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      });
      const universe = (payload && payload[0] && payload[0].universe) || [];
      const contexts = (payload && payload[1]) || [];
      return universe
        .map((asset, index) => {
          const ctx = contexts[index] || {};
          if (asset.isDelisted) return null;
          return normalizeRate({
            symbol: asset.name,
            exchange: "hyperliquid",
            fundingRate: ctx.funding,
            markPrice: ctx.markPx,
            indexPrice: ctx.oraclePx,
            openInterest: ctx.openInterest,
            volume24h: ctx.dayNtlVlm,
            intervalHours: 1,
          });
        })
        .filter(Boolean);
    },
  },

  dydx: {
    async fetch() {
      const payload = await fetchWithRetry("https://indexer.dydx.trade/v4/perpetualMarkets");
      const markets = (payload && payload.markets) || {};
      return Object.values(markets)
        .filter((market) => market && market.status === "ACTIVE")
        .map((market) =>
          normalizeRate({
            symbol: market.ticker,
            exchange: "dydx",
            fundingRate: market.nextFundingRate,
            markPrice: market.oraclePrice,
            openInterest: market.openInterest,
            volume24h: market.volume24H,
            intervalHours: 1,
          }),
        )
        .filter(Boolean);
    },
  },

  okx: {
    // OKX 无全量 funding 端点,需逐币;为控制请求量只精编主流币(其余币种由 gate/mexc/bitget 覆盖)。
    // 逐币接口风控+代理下偏慢,故收紧超时快速失败——它的币种与 gate/mexc/bitget 高度重叠,慢也不阻塞上板。
    async fetch() {
      const markPayload = await fetchWithRetry(
        "https://www.okx.com/api/v5/public/mark-price?instType=SWAP",
        { attempts: 1, connectTimeoutMs: 2500, readTimeoutMs: 5000 },
      );
      const marks = new Map((markPayload.data || []).map((item) => [item.instId, toNumber(item.markPx)]));
      const results = [];
      // 保留分批+批间 sleep 的限速保护(OKX 对逐币 funding 接口有风控)
      const symbolChunks = chunk(MAJORS, 10);
      for (const group of symbolChunks) {
        const groupRows = await Promise.all(
          group.map(async (symbol) => {
            try {
              const instId = `${symbol}-USDT-SWAP`;
              const payload = await fetchWithRetry(
                `https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`,
                { attempts: 1, connectTimeoutMs: 2000, readTimeoutMs: 3500 },
              );
              const item = payload.data && payload.data[0];
              return item
                ? normalizeRate({
                    symbol,
                    exchange: "okx",
                    fundingRate: item.fundingRate,
                    markPrice: marks.get(instId),
                    nextFundingTime: item.nextFundingTime,
                    intervalHours: 8,
                  })
                : null;
            } catch (error) {
              return null; // 单币失败静默(避免刷屏),由整体状态体现
            }
          }),
        );
        results.push(...groupRows.filter(Boolean));
        if (group !== symbolChunks[symbolChunks.length - 1]) {
          await sleep(200);
        }
      }
      return results;
    },
  },

  // ── 以下两家地区封锁,适配器保留供未来重开(默认被 REGION_BLOCKED 跳过)─────────
  binance: {
    async fetch() {
      const payload = await fetchWithRetry("https://fapi.binance.com/fapi/v1/premiumIndex");
      return (Array.isArray(payload) ? payload : [])
        .filter((item) => item && item.symbol && /USDT$/.test(item.symbol))
        .map((item) =>
          normalizeRate({
            symbol: item.symbol,
            exchange: "binance",
            fundingRate: item.lastFundingRate,
            markPrice: item.markPrice,
            indexPrice: item.indexPrice,
            nextFundingTime: item.nextFundingTime,
            intervalHours: 8,
          }),
        )
        .filter(Boolean);
    },
  },

  bybit: {
    async fetch() {
      const endpoint = "/v5/market/tickers?category=linear";
      const payload = await fetchFirstAvailableJson(
        BYBIT_REST_BASES.map((base) => `${base}${endpoint}`),
        { attempts: 1, connectTimeoutMs: 2500, readTimeoutMs: 5000 },
      );
      return (((payload.result || {}).list) || [])
        .filter((item) => item && item.symbol && /USDT$/.test(item.symbol))
        .map((item) =>
          normalizeRate({
            symbol: item.symbol,
            exchange: "bybit",
            fundingRate: item.fundingRate,
            markPrice: item.markPrice,
            indexPrice: item.indexPrice,
            nextFundingTime: item.nextFundingTime,
            intervalHours: 8,
          }),
        )
        .filter(Boolean);
    },
  },
};

// ── 现货价适配器(供现货-永续套利的基差与"可买现货"判断)─────────────────────
const SPOT_ADAPTERS = {
  gate: async () => {
    const payload = await fetchWithRetry("https://api.gateio.ws/api/v4/spot/tickers");
    return (Array.isArray(payload) ? payload : [])
      .map((item) => ({ symbol: normalizeSymbol(item.currency_pair), exchange: "gate", spotPrice: toNumber(item.last) }))
      .filter((row) => row.symbol && row.spotPrice);
  },
  mexc: async () => {
    const payload = await fetchWithRetry("https://api.mexc.com/api/v3/ticker/price");
    return (Array.isArray(payload) ? payload : [])
      .map((item) => ({ symbol: normalizeSymbol(item.symbol), exchange: "mexc", spotPrice: toNumber(item.price) }))
      .filter((row) => row.symbol && row.spotPrice);
  },
  bitget: async () => {
    const payload = await fetchWithRetry("https://api.bitget.com/api/v2/spot/market/tickers");
    return ((payload && payload.data) || [])
      .map((item) => ({ symbol: normalizeSymbol(item.symbol), exchange: "bitget", spotPrice: toNumber(item.lastPr) }))
      .filter((row) => row.symbol && row.spotPrice);
  },
  okx: async () => {
    const payload = await fetchWithRetry("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
    return ((payload && payload.data) || [])
      .map((item) => ({ symbol: normalizeSymbol(item.instId), exchange: "okx", spotPrice: toNumber(item.last) }))
      .filter((row) => row.symbol && row.spotPrice);
  },
};

async function fetchSpots() {
  const spotStatus = {};
  const settled = await Promise.all(
    Object.entries(SPOT_ADAPTERS).map(async ([id, adapter]) => {
      try {
        const rows = await withExchangeTimeout(adapter(), 10000); // 单所现货 10s 盖帽,防 OKX 挂起阻塞全部
        spotStatus[id] = makeStatus(rows.length ? "ok" : "error", rows.length ? "" : "No rows");
        return rows;
      } catch (error) {
        spotStatus[id] = makeStatus("error", error);
        return [];
      }
    }),
  );
  return { spots: settled.flat(), spotStatus, fetchedAt: new Date().toISOString() };
}

// 按 (exchange, symbol) 去重:同一交易所有时返回多条同基币合约,保留 24h 成交量最大的一条
function dedupeRates(rates) {
  const best = new Map();
  (rates || []).forEach((rate) => {
    if (!rate || !rate.symbol || !rate.exchange) return;
    const key = `${rate.exchange}:${rate.symbol}`;
    const existing = best.get(key);
    if (!existing || (Number(rate.volume24h) || 0) > (Number(existing.volume24h) || 0)) {
      best.set(key, rate);
    }
  });
  return Array.from(best.values());
}

// ── 聚合入口 ─────────────────────────────────────────────────────────────
// 慢速档:逐币的 OKX(代理下偏慢)。其余都是单请求全量端点(快,~1-3s)。
// 通过 onPartial 回调实现渐进式首屏:快档一落地就先渲染,慢档(OKX)完成后再并入。
const SLOW_TIER = new Set(["okx"]);

async function fetchDirect(options = {}) {
  const { onPartial } = options;
  const exchangeStatus = {};
  const perExchange = new Map(); // id -> rates[]

  const runOne = async (id) => {
    const adapter = EXCHANGES[id];
    if (REGION_BLOCKED.has(id)) {
      exchangeStatus[id] = makeStatus("region-blocked", "地区限制,本机/边缘不可达;适配器已保留,换节点可重开");
      perExchange.set(id, []);
      return;
    }
    try {
      const rates = await withExchangeTimeout(adapter.fetch());
      exchangeStatus[id] = makeStatus(rates.length ? "ok" : "error", rates.length ? "" : "No rows");
      perExchange.set(id, rates);
    } catch (error) {
      exchangeStatus[id] = makeStatus("error", error);
      perExchange.set(id, []);
    }
  };

  const allIds = Object.keys(EXCHANGES);
  const fastIds = allIds.filter((id) => !SLOW_TIER.has(id));
  const slowIds = allIds.filter((id) => SLOW_TIER.has(id));

  const fastPromise = Promise.all(fastIds.map(runOne));
  const slowPromise = Promise.all(slowIds.map(runOne));

  // 快档落地即回一版(首屏秒开)
  if (typeof onPartial === "function") {
    fastPromise.then(() => {
      const rates = dedupeRates(fastIds.flatMap((id) => perExchange.get(id) || []));
      if (rates.length) {
        onPartial({
          fetchedAt: new Date().toISOString(),
          source: "direct-partial",
          exchangeStatus: { ...exchangeStatus },
          rates,
        });
      }
    }).catch((e) => console.error("onPartial render error", e));
  }

  await Promise.all([fastPromise, slowPromise]);
  const rates = dedupeRates(Array.from(perExchange.values()).flat());
  if (!rates.length) {
    throw new Error("All exchange requests failed");
  }
  return {
    fetchedAt: new Date().toISOString(),
    source: "direct",
    exchangeStatus,
    rates,
  };
}

// ── 预取缓存(data/rates.json,仅作首屏种子/兜底;GitHub Actions 已停,正常走实时)──
function validateRatesPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("rates.json is not an object");
  }
  const rawRates = Array.isArray(payload.rates) ? payload.rates : Array.isArray(payload.data) ? payload.data : null;
  if (!rawRates) {
    throw new Error("rates.json missing rates array");
  }
  const rates = rawRates.map(normalizeRate).filter(Boolean);
  if (!rates.length) {
    throw new Error("rates.json has no valid rate rows");
  }
  return {
    fetchedAt: payload.fetchedAt || payload.timestamp || new Date().toISOString(),
    source: payload.source || "prefetch",
    exchangeStatus: payload.exchangeStatus || {},
    rates,
  };
}

async function fetchFromJson() {
  const payload = await fetchWithRetry("data/rates.json", { attempts: 1 });
  return validateRatesPayload(payload);
}

function cacheAgeMs(payload) {
  const fetchedAt = Date.parse(payload && payload.fetchedAt);
  return Number.isFinite(fetchedAt) ? Date.now() - fetchedAt : Infinity;
}

function isFreshLocalCache(payload) {
  return cacheAgeMs(payload) <= LOCAL_CACHE_MAX_AGE_MS;
}

function fetchUnavailable(error) {
  const exchangeStatus = {};
  Object.keys(EXCHANGE_NAMES).forEach((id) => {
    exchangeStatus[id] = makeStatus("error", error || "No real data available");
  });
  return {
    fetchedAt: new Date().toISOString(),
    source: "unavailable",
    exchangeStatus,
    rates: [],
  };
}

async function fetchRates(options = {}) {
  const forceDirect = options.forceDirect || options.force; // 兼容 force 别名
  let cached = null;
  let jsonError = null;

  try {
    cached = await fetchFromJson();
  } catch (error) {
    jsonError = error;
  }

  if (cached && !forceDirect && cacheAgeMs(cached) <= LOCAL_CACHE_MAX_AGE_MS) {
    return { ...cached, source: "prefetch" }; // 仅当预取缓存足够新鲜时才直接用;否则 fall through 去实时
  }

  try {
    const direct = await fetchDirect({ onPartial: options.onPartial });
    if (cached) {
      // 单个交易所失败时,保留其旧真实缓存行(不用模拟数据补位),并标记 fallback
      const directExchanges = new Set(direct.rates.map((rate) => rate.exchange));
      const staleRows = cached.rates.filter((rate) => {
        const status = direct.exchangeStatus[rate.exchange];
        return status && status.status === "error" && !directExchanges.has(rate.exchange);
      });
      if (staleRows.length) {
        staleRows.forEach((rate) => {
          direct.exchangeStatus[rate.exchange] = makeStatus("fallback", "Using stale prefetch rows");
        });
        return { ...direct, rates: direct.rates.concat(staleRows), jsonError: jsonError && jsonError.message };
      }
    }
    return { ...direct, jsonError: jsonError && jsonError.message };
  } catch (directError) {
    if (cached) {
      return {
        ...cached,
        source: "stale-prefetch",
        cacheAgeMs: cacheAgeMs(cached),
        directError: directError.message,
      };
    }
    return fetchUnavailable(directError);
  }
}

export const FundingAPI = {
  EXCHANGE_ORDER,
  EXCHANGE_NAMES,
  REGION_BLOCKED,
  FUNDING_INTERVAL_HOURS,
  MAJORS,
  EXCHANGES,
  SPOT_ADAPTERS,
  apiUrl,
  fetchRates,
  fetchSpots,
  fetchDirect,
  fetchFromJson,
  fetchWithRetry,
  normalizeRate,
  normalizeSymbol,
  validateRatesPayload,
  isFreshLocalCache,
};
