const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUTPUT = path.join(DATA_DIR, "rates.json");

const FUNDING_SYMBOLS = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "BNB",
  "DOGE",
  "ADA",
  "AVAX",
  "TRX",
  "LINK",
  "DOT",
  "MATIC",
  "LTC",
  "BCH",
  "UNI",
  "ATOM",
  "ETC",
  "FIL",
  "APT",
  "ARB",
  "OP",
  "SUI",
  "NEAR",
  "AAVE",
  "INJ",
  "TIA",
  "SEI",
  "WLD",
  "ORDI",
  "PEPE",
  "SHIB",
  "TON",
  "HBAR",
  "ICP",
  "RUNE",
  "MKR",
  "FET",
  "GALA",
  "DYDX",
  "STRK",
];

const EXCHANGE_NAMES = {
  binance: "Binance",
  okx: "OKX",
  bybit: "Bybit",
  dydx: "dYdX",
  hyperliquid: "Hyperliquid",
  bitget: "Bitget",
};

const BYBIT_REST_BASES = [
  "https://api.bybit.com",
  "https://api.bytick.com",
  "https://api.bybit.eu",
  "https://api.byhkbit.com",
  "https://api.bybit-tr.com",
  "https://api.bybit.kz",
]; // 优化: Bybit 主域可能按地区/CDN 403，Actions/本地抓取按多个官方/区域域名尝试

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number < 10_000_000_000 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(symbol) {
  if (!symbol) return "";
  return String(symbol)
    .toUpperCase()
    .replace("-USDT-SWAP", "")
    .replace("USDT", "")
    .replace("-USD", "")
    .replace("-PERP", "")
    .replace("PERP", "");
}

function normalizeRate(input) {
  const fundingRate = toNumber(input.fundingRate ?? input.rate ?? input.rate8h ?? input.rawRate);
  if (!input || !input.symbol || !input.exchange || fundingRate === null) return null;
  return {
    symbol: normalizeSymbol(input.symbol),
    exchange: String(input.exchange).toLowerCase(),
    fundingRate,
    markPrice: toNumber(input.markPrice ?? input.price ?? input.oraclePrice),
    nextFundingTime: toTimestamp(input.nextFundingTime ?? input.nextFundingAt),
    intervalHours: toNumber(input.intervalHours) || 8,
    fetchedAt: input.fetchedAt || new Date().toISOString(),
  };
}

async function fetchJsonOnce(url, options = {}) {
  const args = ["-L", "--fail-with-body", "--max-time", String(Math.ceil((options.readTimeoutMs || 20_000) / 1000)), "-sS"];
  if (options.method === "POST") args.push("-X", "POST");
  Object.entries(options.headers || {}).forEach(([key, value]) => args.push("-H", `${key}: ${value}`));
  if (options.body) args.push("--data", options.body);
  args.push(url);

  const stdout = await new Promise((resolve, reject) => {
    execFile("curl", args, { maxBuffer: 50 * 1024 * 1024 }, (error, out, stderr) => {
      if (error) {
        reject(new Error(stderr || out || error.message));
        return;
      }
      resolve(out);
    });
  }); // 优化: Node fetch 在当前网络下失败，预抓取脚本改用系统 curl 获取真实数据
  return stdout ? JSON.parse(stdout) : null;
}

async function fetchWithRetry(url, options = {}) {
  const attempts = options.attempts || 2;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJsonOnce(url, options); // 优化: Node 端统一重试和超时策略
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(options.retryDelayMs || 1_000);
    }
  }
  throw lastError;
}

async function fetchFirstAvailableJson(urls, options = {}) {
  let lastError;
  for (const url of urls) {
    try {
      return await fetchWithRetry(url, options); // 优化: Bybit 多域名逐个尝试，避免单域名 403 直接丢失数据
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function usdtSymbol(symbol) {
  return `${symbol}USDT`;
}

function okxSymbol(symbol) {
  return `${symbol}-USDT-SWAP`;
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

const EXCHANGES = {
  binance: async () => {
    const payload = await fetchWithRetry("https://fapi.binance.com/fapi/v1/premiumIndex");
    const wanted = new Set(FUNDING_SYMBOLS.map(usdtSymbol));
    return (Array.isArray(payload) ? payload : [])
      .filter((item) => wanted.has(item.symbol))
      .map((item) =>
        normalizeRate({
          symbol: item.symbol,
          exchange: "binance",
          fundingRate: item.lastFundingRate,
          markPrice: item.markPrice,
          nextFundingTime: item.nextFundingTime,
          intervalHours: 8,
        }),
      )
      .filter(Boolean);
  },
  okx: async () => {
    const markPayload = await fetchWithRetry("https://www.okx.com/api/v5/public/mark-price?instType=SWAP");
    const marks = new Map((markPayload.data || []).map((item) => [item.instId, toNumber(item.markPx)]));
    const rows = [];
    const symbolChunks = chunk(FUNDING_SYMBOLS.slice(0, 40), 10);
    for (const group of symbolChunks) {
      const batch = await Promise.all(
        group.map(async (symbol) => {
          try {
            const instId = okxSymbol(symbol);
            const payload = await fetchWithRetry(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`);
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
            console.warn(`OKX ${symbol} funding request failed: ${error.message || error}`); // 优化: OKX 单币种失败不拖垮整批
            return null;
          }
        }),
      );
      rows.push(...batch.filter(Boolean));
      if (group !== symbolChunks[symbolChunks.length - 1]) await sleep(250); // 优化: OKX Node 端同样 10 个一批
    }
    return rows;
  },
  bybit: async () => {
    const endpoint = "/v5/market/tickers?category=linear";
    const payload = await fetchFirstAvailableJson(BYBIT_REST_BASES.map((base) => `${base}${endpoint}`)); // 优化: 与前端一致，Bybit REST 自动尝试备用域名
    const wanted = new Set(FUNDING_SYMBOLS.map(usdtSymbol));
    return (((payload.result || {}).list || [])).filter((item) => wanted.has(item.symbol)).map((item) =>
      normalizeRate({
        symbol: item.symbol,
        exchange: "bybit",
        fundingRate: item.fundingRate,
        markPrice: item.markPrice,
        nextFundingTime: item.nextFundingTime,
        intervalHours: 8,
      }),
    ).filter(Boolean);
  },
  dydx: async () => {
    const payload = await fetchWithRetry("https://indexer.dydx.trade/v4/perpetualMarkets");
    return Object.values(payload.markets || {})
      .filter((market) => FUNDING_SYMBOLS.includes(normalizeSymbol(market.ticker || market.market || market.id)))
      .map((market) =>
        normalizeRate({
          symbol: normalizeSymbol(market.ticker || market.market || market.id),
          exchange: "dydx",
          fundingRate: market.nextFundingRate, // 优化: 去掉 atomicResolution 兜底（tick 指数非费率），与前端 api.js 保持一致
          markPrice: market.oraclePrice,
          nextFundingTime: null, // 优化: 不伪造下次结算时间
          intervalHours: 1,
        }),
      )
      .filter(Boolean);
  },
  hyperliquid: async () => {
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
        if (!FUNDING_SYMBOLS.includes(normalizeSymbol(asset.name))) return null;
        return normalizeRate({
          symbol: asset.name,
          exchange: "hyperliquid",
          fundingRate: ctx.funding,
          markPrice: ctx.markPx,
          nextFundingTime: null, // 优化: 不伪造下次结算时间
          intervalHours: 1,
        });
      })
      .filter(Boolean);
  },
  bitget: async () => {
    const payload = await fetchWithRetry("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES");
    const wanted = new Set(FUNDING_SYMBOLS.map(usdtSymbol));
    return (payload.data || [])
      .filter((item) => wanted.has(item.symbol))
      .map((item) =>
        normalizeRate({
          symbol: item.symbol,
          exchange: "bitget",
          fundingRate: item.fundingRate,
          markPrice: item.markPrice,
          nextFundingTime: item.nextFundingTime,
          intervalHours: 8,
        }),
      )
      .filter(Boolean);
  },
};

async function main() {
  let previousPayload = null;
  if (fs.existsSync(OUTPUT)) {
    try {
      previousPayload = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
    } catch (error) {
      previousPayload = null;
    }
  }
  const exchangeStatus = {};
  const settled = await Promise.all(
    Object.entries(EXCHANGES).map(async ([id, fetcher]) => {
      try {
        const rates = await fetcher();
        exchangeStatus[id] = { status: rates.length ? "ok" : "error", error: rates.length ? "" : "No rows" };
        return rates;
      } catch (error) {
        exchangeStatus[id] = { status: "error", error: String(error.message || error) };
        return [];
      }
    }),
  );

  const rates = settled.flat();
  const liveExchanges = new Set(rates.map((rate) => rate.exchange));
  if (previousPayload && Array.isArray(previousPayload.rates)) {
    Object.entries(exchangeStatus).forEach(([exchange, status]) => {
      if (status.status !== "error" || liveExchanges.has(exchange)) return;
      const staleRows = previousPayload.rates.filter((rate) => rate.exchange === exchange);
      if (!staleRows.length) return;
      rates.push(...staleRows);
      exchangeStatus[exchange] = { status: "fallback", error: "Using previous cached rows" }; // 优化: Bybit 被地区拦截时保留最后一次真实数据，不用模拟数据补齐
    });
  }
  if (!rates.length && fs.existsSync(OUTPUT)) {
    console.warn("No valid rates fetched; keeping existing data/rates.json"); // 优化: 全部失败时不覆盖旧缓存
    process.exit(0);
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: "prefetch",
    symbols: FUNDING_SYMBOLS,
    exchangeStatus,
    rates,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${rates.length} rows to ${path.relative(ROOT, OUTPUT)}`);

  const okCount = Object.values(exchangeStatus).filter((item) => item.status === "ok").length;
  if (!rates.length || okCount === 0) {
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode || 0)) // 优化: 避免 Node fetch keep-alive 句柄导致 Actions 挂起
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
