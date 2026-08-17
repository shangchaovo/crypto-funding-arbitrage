// ============================================================================
// 板块③:主力清算热图 — 数据 + 模型(纯 JS,无依赖)
//   数据源:OKX 公开永续端点(标记价/持仓量/资金费/K线/多空比/订单簿),经 /proxy。
//   模型:公开 K 线入场分布 + OI + 杠杆层(5/10/25/50/100x) + 多空权重
//        + 订单簿/技术位修正 → 各价格区间的"估算清算密度"。
//   ⚠️ 重要:这是公开行情/OI 推导的概率密度估算,非 CoinGlass 逐价格点真实清算数据。
// ============================================================================
import { FundingAPI } from "./api.js?v=20260817e";

const { apiUrl, fetchWithRetry } = FundingAPI;

const OKX = "https://www.okx.com";
// 杠杆层名义持仓权重:零售永续名义集中在 5-25x(低杠杆占大头、强平价更远形成外围墙),
// 高杠杆(50/100x)名义占比小但强平价贴近现价、贡献近端密集区。合计 = 1.00。
const LEVERAGE_WEIGHTS = { 5: 0.18, 10: 0.32, 25: 0.30, 50: 0.14, 100: 0.06 };
const MAINTENANCE_BUFFER = 0.004;
const KLINE_LIMIT = 200;

// 支持的币种(OKX USDT 永续)
export const SYMBOLS = [
  { id: "BTC", instId: "BTC-USDT-SWAP", ccy: "BTC", emoji: "🟠" },
  { id: "ETH", instId: "ETH-USDT-SWAP", ccy: "ETH", emoji: "🟣" },
  { id: "SOL", instId: "SOL-USDT-SWAP", ccy: "SOL", emoji: "🟢" },
  { id: "DOGE", instId: "DOGE-USDT-SWAP", ccy: "DOGE", emoji: "🐶" },
  { id: "XRP", instId: "XRP-USDT-SWAP", ccy: "XRP", emoji: "💧" },
];

const CROWDED_LABELS = { LONG: "🟢 多头拥挤", SHORT: "🔴 空头拥挤", BALANCED: "⚖️ 多空均衡" };
const RISK_LABELS = { UP: "↑ 上方收割(猎空)", DOWN: "↓ 下方收割(猎多)", NEUTRAL: "→ 均衡" };

// ── 工具 ─────────────────────────────────────────────────────────────────
const safeFloat = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function okxGet(path) {
  await okxThrottle();
  const data = await fetchWithRetry(`${OKX}${path}`, { attempts: 3, connectTimeoutMs: 6000, readTimeoutMs: 12000, retryDelayMs: 700 });
  if (!data || data.code !== "0") throw new Error(data?.msg || `OKX ${path} 返回异常`);
  return data.data;
}

// OKX 公开端点限流:同 IP 约 20 req/2s。三币种各 ~6 个调用,不节流会被 429。
let _okxLastAt = 0;
const OKX_MIN_GAP_MS = 130;
async function okxThrottle() {
  const now = Date.now();
  const wait = _okxLastAt + OKX_MIN_GAP_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _okxLastAt = Date.now();
}

// ── OKX 数据获取 ──────────────────────────────────────────────────────────
async function fetchContractSnapshot(instId) {
  const [tick, oi, fund] = await Promise.all([
    okxGet(`/api/v5/market/ticker?instId=${instId}`).catch(() => null),
    okxGet(`/api/v5/public/open-interest?instId=${instId}`).catch(() => null),
    okxGet(`/api/v5/public/funding-rate?instId=${instId}`).catch(() => null),
  ]);
  const t = (tick || [])[0];
  if (!t) throw new Error("OKX ticker 为空");
  const o = (oi || [])[0] || {};
  const f = (fund || [])[0] || {};
  const mark = safeFloat(t.last);
  const oiUsd = safeFloat(o.oiUsd) || safeFloat(o.oiCcy) * mark;
  return {
    markPrice: mark,
    open24h: safeFloat(t.open24h, mark),
    high24h: safeFloat(t.high24h, mark),
    low24h: safeFloat(t.low24h, mark),
    openInterest: safeFloat(o.oiCcy) || safeFloat(o.oi),
    oiValueUsd: oiUsd,
    fundingRate: safeFloat(f.fundingRate),
    volume24h: safeFloat(t.volCcy24h) * mark || safeFloat(t.vol24h),
  };
}

async function fetchKlines(instId, bar = "1H", limit = KLINE_LIMIT) {
  const rows = await okxGet(`/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
  // OKX 返回 newest-first;模型依赖该顺序(recent = 前 N 根)。
  return (rows || []).map((d) => ({
    timestamp: safeFloat(d[0]), open: safeFloat(d[1]), high: safeFloat(d[2]),
    low: safeFloat(d[3]), close: safeFloat(d[4]), volume: safeFloat(d[5]),
  })).filter((k) => k.high && k.low);
}

async function fetchLongShortRatio(ccy) {
  try {
    const rows = await okxGet(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=5m`);
    const latest = (rows || [])[0];
    const r = safeFloat(latest && latest[1]);
    if (r > 0) {
      const longAccount = r / (1 + r);
      return { longAccount, shortAccount: 1 - longAccount, longShortRatio: r };
    }
  } catch (e) { /* fall through */ }
  return null;
}

async function fetchOrderBook(instId, sz = 400) {
  try {
    const rows = await okxGet(`/api/v5/market/books?instId=${instId}&sz=${Math.min(sz, 400)}`);
    const row = (rows || [])[0] || {};
    return {
      bids: (row.bids || []).map((x) => ({ price: safeFloat(x[0]), size: safeFloat(x[1]) })).filter((b) => b.price && b.size),
      asks: (row.asks || []).map((x) => ({ price: safeFloat(x[0]), size: safeFloat(x[1]) })).filter((a) => a.price && a.size),
    };
  } catch (e) {
    return { bids: [], asks: [] };
  }
}

// ── 波动率 / 价格网格 ─────────────────────────────────────────────────────
function realizedVolatility(klines, limit = 100) {
  const count = Math.min(klines.length, limit) - 1;
  if (count <= 0) return 0.01;
  const returns = [];
  for (let i = 1; i <= count; i += 1) {
    const prev = klines[i - 1].close;
    const cur = klines[i].close;
    if (prev) returns.push(((cur - prev) / prev) ** 2);
  }
  return returns.length ? Math.sqrt(returns.reduce((a, b) => a + b, 0) / returns.length) : 0.01;
}

function priceGrid(currentPrice, lowerPct, upperPct, step = 0.005) {
  const start = currentPrice * (1 + lowerPct);
  const end = currentPrice * (1 + upperPct);
  if (start <= 0 || end <= start) return [];
  const bins = Math.max(20, Math.floor((upperPct - lowerPct) / step));
  const width = (end - start) / bins;
  return Array.from({ length: bins }, (_, i) => ({
    priceLow: start + i * width,
    priceHigh: start + (i + 1) * width,
    price: start + (i + 0.5) * width,
  }));
}

function findBinIndex(grid, price) {
  if (!grid.length || price < grid[0].priceLow || price > grid[grid.length - 1].priceHigh) return null;
  const width = grid[0].priceHigh - grid[0].priceLow;
  if (width <= 0) return null;
  const idx = Math.floor((price - grid[0].priceLow) / width);
  return clamp(idx, 0, grid.length - 1);
}

// 把每根 K 线成交量按 high-low 区间分配到相交价格网格(实体区加权 1.35)。
function buildEntryProfile(klines, grid) {
  const profile = new Array(grid.length).fill(0);
  if (!klines.length || !grid.length) return profile;
  for (const k of klines) {
    const low = Math.max(k.low, grid[0].priceLow);
    const high = Math.min(k.high, grid[grid.length - 1].priceHigh);
    const volume = k.volume;
    if (high < low || volume <= 0) continue;
    if (high === low) {
      const idx = findBinIndex(grid, high);
      if (idx !== null) profile[idx] += volume;
      continue;
    }
    const candleRange = high - low;
    const bodyLow = Math.max(Math.min(k.open, k.close), low);
    const bodyHigh = Math.min(Math.max(k.open, k.close), high);
    let totalWeight = 0;
    const weights = grid.map((b) => {
      const overlap = Math.max(0, Math.min(high, b.priceHigh) - Math.max(low, b.priceLow));
      if (overlap <= 0) return 0;
      let weight = overlap / candleRange;
      const bodyOverlap = Math.max(0, Math.min(bodyHigh, b.priceHigh) - Math.max(bodyLow, b.priceLow));
      if (bodyOverlap > 0 && bodyHigh > bodyLow) weight *= 1.35;
      totalWeight += weight;
      return weight;
    });
    if (totalWeight <= 0) continue;
    weights.forEach((w, i) => { if (w) profile[i] += (volume * w) / totalWeight; });
  }
  return profile;
}

// ── 技术位(支撑/阻力 + 成交量集群 + 斐波那契)────────────────────────────
function findLocalExtrema(klines) {
  const highs = [];
  const lows = [];
  for (let i = 2; i < klines.length - 2; i += 1) {
    if (klines[i].high > Math.max(klines[i - 1].high, klines[i - 2].high, klines[i + 1].high, klines[i + 2].high)) {
      highs.push({ price: klines[i].high, volume: klines[i].volume });
    }
    if (klines[i].low < Math.min(klines[i - 1].low, klines[i - 2].low, klines[i + 1].low, klines[i + 2].low)) {
      lows.push({ price: klines[i].low, volume: klines[i].volume });
    }
  }
  return { highs, lows };
}

function clusterLevels(levels, tolerance = 0.015) {
  if (!levels.length) return [];
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clusters = [[sorted[0]]];
  for (const lv of sorted.slice(1)) {
    const last = clusters[clusters.length - 1];
    const avg = last.reduce((s, x) => s + x.price, 0) / last.length;
    if (Math.abs(lv.price - avg) / avg < tolerance) last.push(lv);
    else clusters.push([lv]);
  }
  return clusters.map((c) => ({
    price: c.reduce((s, x) => s + x.price, 0) / c.length,
    volume: c.reduce((s, x) => s + x.volume, 0),
    count: c.length,
  }));
}

function findSupportResistance(klines, currentPrice, lookback = 50) {
  if (klines.length < 10) return { support: [], resistance: [] };
  const recent = klines.slice(0, lookback);
  const s = findLocalExtrema(recent);
  const m = findLocalExtrema(klines);
  const resistance = clusterLevels([...s.highs, ...m.highs], 0.012);
  const support = clusterLevels([...s.lows, ...m.lows], 0.012);
  const score = (lv) => (1 / (Math.abs(lv.price - currentPrice) / currentPrice + 0.001)) * Math.log(lv.volume + 1);
  const above = resistance.filter((r) => r.price > currentPrice).sort((a, b) => score(b) - score(a)).slice(0, 8);
  const below = support.filter((x) => x.price < currentPrice).sort((a, b) => score(b) - score(a)).slice(0, 8);
  return {
    resistance: above.sort((a, b) => a.price - b.price),
    support: below.sort((a, b) => b.price - a.price),
  };
}

function findFibonacciLevels(klines, currentPrice) {
  if (klines.length < 20) return [];
  const recent = klines.slice(0, 24);
  const swingLow = Math.min(...recent.map((k) => k.low));
  const swingHigh = Math.max(...recent.map((k) => k.high));
  if (swingHigh <= swingLow) return [];
  const band = swingHigh - swingLow;
  const levels = [];
  for (const ext of [1.272, 1.414, 1.618, 2.0, 2.618]) {
    const price = swingHigh + band * (ext - 1);
    if (price > currentPrice) levels.push({ price, volume: band * 1000, fib: ext, type: "fib_extension" });
  }
  for (const ret of [0.786, 0.618, 0.5, 0.382, 0.236]) {
    const price = swingHigh - band * ret;
    if (price < currentPrice) levels.push({ price, volume: band * 1000 * (1 - ret), fib: ret, type: "fib_retracement" });
  }
  return levels;
}

function findVolumeClusters(klines, currentPrice, numBins = 30) {
  if (!klines.length) return [];
  const low = Math.min(...klines.map((k) => k.low));
  const high = Math.max(...klines.map((k) => k.high));
  const binSize = (high - low) / numBins;
  if (binSize === 0) return [];
  const profile = new Map();
  for (const k of klines) {
    const mid = (k.high + k.low) / 2;
    const idx = Math.floor((mid - low) / binSize);
    const price = low + idx * binSize + binSize / 2;
    profile.set(price, (profile.get(price) || 0) + k.volume);
  }
  return [...profile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([price, volume]) => ({ price, volume, type: "volume_cluster" }));
}

function findVolumeProfile(klines, numBins = 50) {
  if (!klines.length) return null;
  const low = Math.min(...klines.map((k) => k.low));
  const high = Math.max(...klines.map((k) => k.high));
  const binSize = (high - low) / numBins;
  if (binSize === 0) return null;
  const profile = new Map();
  for (const k of klines) {
    const mid = (k.high + k.low) / 2;
    const priceLow = low + Math.floor((mid - low) / binSize) * binSize;
    profile.set(priceLow, (profile.get(priceLow) || 0) + k.volume);
  }
  const sorted = [...profile.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return null;
  const [priceLow, volume] = sorted[0];
  return { priceLow, priceHigh: priceLow + binSize, priceMid: priceLow + binSize / 2, volume };
}

function technicalBoosts(grid, currentPrice, sr, volumeClusters) {
  const boosts = new Array(grid.length).fill(1);
  const levels = [...(sr.support || []), ...(sr.resistance || []), ...(volumeClusters || [])];
  for (const level of levels) {
    if (!level.price) continue;
    grid.forEach((b, i) => {
      const dist = Math.abs(b.price - level.price) / currentPrice;
      if (dist < 0.01) boosts[i] += 0.25 * (1 - dist / 0.01);
    });
  }
  return boosts;
}

// ── 订单簿深度(流动性墙加权)─────────────────────────────────────────────
function analyzeOrderBookDepth(orderBook, currentPrice, stepPct = 0.01, maxDistancePct = 0.15) {
  const { bids = [], asks = [] } = orderBook || {};
  if (!currentPrice) return { buckets: [], maxNotional: 0 };
  const bucketCount = Math.floor(maxDistancePct / stepPct);
  const buckets = new Map();
  for (let i = -bucketCount; i <= bucketCount; i += 1) {
    if (i !== 0) buckets.set(i, { index: i, bucketPct: i * stepPct * 100, totalNotional: 0 });
  }
  const bucketIndex = (price) => {
    const pct = (price - currentPrice) / currentPrice;
    if (Math.abs(pct) > maxDistancePct) return null;
    const idx = pct > 0 ? Math.ceil(pct / stepPct) : Math.floor(pct / stepPct);
    return buckets.has(idx) ? idx : null;
  };
  for (const b of bids) {
    const idx = bucketIndex(b.price);
    if (idx !== null) buckets.get(idx).totalNotional += b.size * b.price;
  }
  for (const a of asks) {
    const idx = bucketIndex(a.price);
    if (idx !== null) buckets.get(idx).totalNotional += a.size * a.price;
  }
  const rows = [...buckets.values()];
  const maxNotional = Math.max(0, ...rows.map((r) => r.totalNotional));
  return { buckets: rows, maxNotional };
}

function orderBookBoosts(grid, currentPrice, liquidityMap) {
  const boosts = new Array(grid.length).fill(0);
  const buckets = (liquidityMap && liquidityMap.buckets) || [];
  if (!buckets.length || !liquidityMap.maxNotional) return boosts;
  grid.forEach((b, i) => {
    const pct = ((b.price - currentPrice) / currentPrice) * 100;
    let nearest = buckets[0];
    for (const bk of buckets) if (Math.abs(bk.bucketPct - pct) < Math.abs(nearest.bucketPct - pct)) nearest = bk;
    boosts[i] = (nearest.totalNotional / liquidityMap.maxNotional) * 0.30;
  });
  return boosts;
}

// ── 核心:连续清算密度估算 ─────────────────────────────────────────────────
function estimateLiquidationDensity({
  currentPrice, oi, volatility, priceRange = null, step = 0.005, klines = [],
  longRatio = 0.5, fundingRate = 0, supportResistance = null, volumeClusters = null, liquidityMap = null,
}) {
  if (currentPrice <= 0) return [];
  const span = Math.max(0.12, 3 * Math.max(volatility, 0.005));
  const [lowerPct, upperPct] = priceRange || [-span, span];
  const grid = priceGrid(currentPrice, lowerPct, upperPct, step);
  if (!grid.length) return [];

  const entryProfile = buildEntryProfile(klines, grid);
  if (!entryProfile.some((v) => v > 0)) {
    const center = findBinIndex(grid, currentPrice);
    if (center !== null) entryProfile[center] = 1;
  }
  const profileTotal = entryProfile.reduce((a, b) => a + b, 0) || 1;
  const oiScale = Math.max(oi, 1);

  const fundingBias = clamp(fundingRate * 600, -0.18, 0.18);
  const longSideWeight = clamp(0.5 + (longRatio - 0.5) * 0.75 + fundingBias, 0.20, 0.80);
  const shortSideWeight = 1 - longSideWeight;
  const techBoost = technicalBoosts(grid, currentPrice, supportResistance || {}, volumeClusters || []);
  const obBoost = orderBookBoosts(grid, currentPrice, liquidityMap || {});

  const leverageScores = grid.map(() => Object.fromEntries(Object.keys(LEVERAGE_WEIGHTS).map((k) => [k, 0])));
  const longScores = new Array(grid.length).fill(0);
  const shortScores = new Array(grid.length).fill(0);

  entryProfile.forEach((entryVolume, entryIdx) => {
    if (entryVolume <= 0) return;
    const entryPrice = grid[entryIdx].price;
    const baseScore = (entryVolume / profileTotal) * oiScale;
    for (const [levStr, levWeight] of Object.entries(LEVERAGE_WEIGHTS)) {
      const leverage = Number(levStr);
      const longLiqPrice = entryPrice * (1 - 1 / leverage + MAINTENANCE_BUFFER);
      const shortLiqPrice = entryPrice * (1 + 1 / leverage - MAINTENANCE_BUFFER);
      const longIdx = findBinIndex(grid, longLiqPrice);
      const shortIdx = findBinIndex(grid, shortLiqPrice);
      if (longIdx !== null) {
        const score = baseScore * levWeight * longSideWeight;
        longScores[longIdx] += score;
        leverageScores[longIdx][levStr] += score;
      }
      if (shortIdx !== null) {
        const score = baseScore * levWeight * shortSideWeight;
        shortScores[shortIdx] += score;
        leverageScores[shortIdx][levStr] += score;
      }
    }
  });

  const bins = grid.map((b, i) => {
    const boostedLong = longScores[i] * techBoost[i] * (1 + obBoost[i]);
    const boostedShort = shortScores[i] * techBoost[i] * (1 + obBoost[i]);
    return {
      price: b.price, priceLow: b.priceLow, priceHigh: b.priceHigh,
      distancePct: (Math.abs(b.price - currentPrice) / currentPrice) * 100,
      side: b.price >= currentPrice ? "upper" : "lower",
      density: boostedLong + boostedShort,
      intensity: 0,
      longLiqScore: boostedLong,
      shortLiqScore: boostedShort,
      leverageScores: leverageScores[i],
    };
  });
  const maxDensity = Math.max(0, ...bins.map((b) => b.density));
  bins.forEach((b) => { b.intensity = maxDensity ? b.density / maxDensity : 0; });
  return bins;
}

function zonesFromDensity(densityBins, currentPrice, side, limit = 8) {
  const candidates = densityBins.filter((b) => b.side === side && b.density > 0);
  if (!candidates.length) return [];
  const maxIntensity = Math.max(...candidates.map((b) => b.intensity));
  const threshold = Math.max(0.10, maxIntensity * 0.35);
  let hot = candidates.filter((b) => b.intensity >= threshold);
  if (hot.length < Math.min(3, candidates.length)) {
    hot = [...candidates].sort((a, b) => b.density - a.density).slice(0, Math.max(limit, 3));
  }
  hot = [...hot].sort((a, b) => a.price - b.price);

  const clusters = [];
  for (const b of hot) {
    if (!clusters.length || b.priceLow > clusters[clusters.length - 1][clusters[clusters.length - 1].length - 1].priceHigh * 1.0001) {
      clusters.push([b]);
    } else {
      clusters[clusters.length - 1].push(b);
    }
  }
  const zones = clusters.map((cluster) => {
    const total = cluster.reduce((s, b) => s + b.density, 0) || 1;
    const price = cluster.reduce((s, b) => s + b.price * b.density, 0) / total;
    const intensity = Math.max(...cluster.map((b) => b.intensity));
    return {
      price,
      priceLow: Math.min(...cluster.map((b) => b.priceLow)),
      priceHigh: Math.max(...cluster.map((b) => b.priceHigh)),
      distancePct: (Math.abs(price - currentPrice) / currentPrice) * 100,
      concentrationScore: total,
      intensity,
      confidence: Math.min(1, 0.35 + intensity * 0.65),
      side,
    };
  }).sort((a, b) => b.concentrationScore - a.concentrationScore);
  return zones.slice(0, limit);
}

// ── 单币种完整分析 ────────────────────────────────────────────────────────
async function analyzeSymbol(sym) {
  const [snapshot, klines, lsRatio, orderBook] = await Promise.all([
    fetchContractSnapshot(sym.instId),
    fetchKlines(sym.instId).catch(() => []),
    fetchLongShortRatio(sym.ccy),
    fetchOrderBook(sym.instId),
  ]);

  const price = snapshot.markPrice;
  if (!klines.length) throw new Error(`${sym.id} K线为空`);

  const longRatio = clamp(lsRatio ? lsRatio.longAccount : 0.5, 0.05, 0.95);
  const lsRatioVal = longRatio < 1 ? longRatio / (1 - longRatio) : 1;
  const crowdedSide = lsRatioVal > 1.5 ? "LONG" : lsRatioVal < 0.67 ? "SHORT" : "BALANCED";

  const volatility = realizedVolatility(klines);
  const sr = findSupportResistance(klines, price, 200);
  const fibLevels = findFibonacciLevels(klines, price);
  const volClusters = findVolumeClusters(klines, price, 30);
  const poc = findVolumeProfile(klines, 50);
  const liquidityMap = analyzeOrderBookDepth(orderBook, price);

  const density = estimateLiquidationDensity({
    currentPrice: price, oi: snapshot.oiValueUsd || snapshot.openInterest * price, volatility,
    priceRange: [-0.20, 0.20], step: 0.008, klines,
    longRatio, fundingRate: snapshot.fundingRate,
    supportResistance: sr, volumeClusters: [...volClusters, ...fibLevels], liquidityMap,
  });

  const upperZones = zonesFromDensity(density, price, "upper", 8);
  const lowerZones = zonesFromDensity(density, price, "lower", 8);
  const upperLiquidity = upperZones.reduce((s, z) => s + z.concentrationScore, 0);
  const lowerLiquidity = lowerZones.reduce((s, z) => s + z.concentrationScore, 0);
  const riskDir = upperLiquidity > lowerLiquidity * 1.3 ? "UP" : lowerLiquidity > upperLiquidity * 1.3 ? "DOWN" : "NEUTRAL";

  let confidence = 0.35;
  confidence += 0.24; // OKX 单源快照 + OI
  confidence += klines.length >= 80 ? 0.12 : 0;
  confidence += liquidityMap.maxNotional > 0 ? 0.10 : 0;
  confidence += lsRatio ? 0.08 : 0;
  confidence = Math.min(confidence, 0.95);

  return {
    symbol: sym.id,
    emoji: sym.emoji,
    metrics: {
      currentPrice: price,
      priceChange24h: snapshot.open24h ? ((price - snapshot.open24h) / snapshot.open24h) * 100 : 0,
      high24h: snapshot.high24h,
      low24h: snapshot.low24h,
      openInterest: snapshot.openInterest,
      oiValueUsd: snapshot.oiValueUsd,
      fundingRate: snapshot.fundingRate,
      fundingAnnualized: snapshot.fundingRate * 3 * 365 * 100,
      volume24h: snapshot.volume24h,
    },
    crowdedSide,
    crowdedLabel: CROWDED_LABELS[crowdedSide],
    riskDir,
    riskLabel: RISK_LABELS[riskDir],
    longShortRatio: lsRatioVal,
    longRatio,
    volatility,
    poc,
    upperZones,
    lowerZones,
    upperLiquidity,
    lowerLiquidity,
    density,
    confidence,
    klineCount: klines.length,
    hasOrderBook: liquidityMap.maxNotional > 0,
  };
}

// ── 对外:拉取全部币种分析 ─────────────────────────────────────────────────
// 串行处理各币种(配合 okxThrottle),避免瞬间 ~18 个并发触发 OKX 限流。
export async function fetchLiquidation(options = {}) {
  const symbols = options.symbols || SYMBOLS;
  const onPartial = typeof options.onPartial === "function" ? options.onPartial : null;
  const results = [];
  const errors = {};
  const note = (r) => {
    results.push(r);
    results.sort((a, b) => SYMBOLS.findIndex((s) => s.id === a.symbol) - SYMBOLS.findIndex((s) => s.id === b.symbol));
    if (onPartial) onPartial({ results: [...results], errors: { ...errors } });
  };
  // 返回 true=成功 / false=真空值(不重试) / "retry"=抛异常(多为 OKX 瞬时 429,可重试)
  const attempt = async (sym) => {
    try {
      const r = await analyzeSymbol(sym);
      if (r) { delete errors[sym.id]; note(r); return true; }
      errors[sym.id] = "empty";
      return false;
    } catch (e) {
      errors[sym.id] = String(e && e.message ? e.message : e);
      return "retry";
    }
  };
  const retryable = [];
  for (const sym of symbols) {
    if ((await attempt(sym)) === "retry") retryable.push(sym);
  }
  // 瞬时失败(限流)的币种:限速窗口重置后逐个补一次,避免整板块缺币。
  for (const sym of retryable) {
    await new Promise((r) => setTimeout(r, 1500));
    await attempt(sym);
  }
  return { results, errors, fetchedAt: new Date().toISOString() };
}

export const Liquidation = { SYMBOLS, CROWDED_LABELS, RISK_LABELS, fetchLiquidation, analyzeSymbol };
