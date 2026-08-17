import { FundingAPI } from './api.js';

const DEFAULT_MIN_SPREAD = 0.00001;
const FRESH_MS = 15 * 60 * 1000; // >15min 的腿视为陈旧
const CAP_RATE8H = 0.0001; // +0.0100% 8h 等价,Hyperliquid/Binance 正向资金费"天花板"(仅用于跨所伪套利识别)
const CAP_TOL = 1e-6;

function isValidRate(value) {
  return Number.isFinite(Number(value));
}

// 给单条腿打"可疑"标记:陈旧 / 恰好为零 / 卡在 +0.01% 上限窄带内
function legFlags(leg, now) {
  const flags = [];
  const age = now - Date.parse(leg && leg.fetchedAt);
  if (!Number.isFinite(age) || age > FRESH_MS) flags.push("stale");
  const r = leg ? leg.rate8h : NaN;
  if (r === 0) flags.push("zero-leg");
  if (Number.isFinite(r) && Math.abs(r - CAP_RATE8H) <= CAP_TOL) flags.push("cap-leg");
  return flags;
}

function effectiveFundingRate(rate) {
  const fundingRate = Number(rate.fundingRate);
  const intervalHours = Number(rate.intervalHours) || 8;
  return fundingRate * (8 / intervalHours);
}

function groupBySymbol(rates) {
  return (rates || []).reduce((groups, rate) => {
    if (!rate || !rate.symbol || !rate.exchange || !isValidRate(rate.fundingRate)) return groups;
    const normalized = {
      ...rate,
      fundingRate: Number(rate.fundingRate),
      rate8h: effectiveFundingRate(rate),
    };
    if (!groups[normalized.symbol]) groups[normalized.symbol] = [];
    groups[normalized.symbol].push(normalized);
    return groups;
  }, {});
}

// ── 策略一:跨所套利(同一币种,低费率所做多 / 高费率所做空,赚费率差)──────────
function calculateArbitrages(rates, minSpread, now = Date.now()) {
  const threshold = Number.isFinite(minSpread) ? minSpread : DEFAULT_MIN_SPREAD;
  const groups = groupBySymbol(rates);
  const results = [];
  for (const [symbol, rows] of Object.entries(groups)) {
    const valid = rows.filter((row) => isValidRate(row.rate8h));
    if (valid.length < 2) continue;
    let low = valid[0];
    let high = valid[0];
    for (let i = 1; i < valid.length; i++) {
      const r = valid[i];
      if (r.rate8h < low.rate8h) low = r;
      if (r.rate8h > high.rate8h) high = r;
    }
    const spread = high.rate8h - low.rate8h;
    if (spread < threshold) continue;
    const markPrice = Number(low.markPrice) || Number(high.markPrice) || null;
    const lowFlags = legFlags(low, now);
    const highFlags = legFlags(high, now);
    const flags = [...new Set([...lowFlags, ...highFlags])];
    const stale = flags.includes("stale");
    const phantomZeroCap = lowFlags.includes("zero-leg") && highFlags.includes("cap-leg");
    const confidence = stale || phantomZeroCap ? "low" : "high";
    const lowAge = now - Date.parse(low.fetchedAt);
    const highAge = now - Date.parse(high.fetchedAt);
    results.push({
      symbol,
      low,
      high,
      spread,
      apr: spread * 3 * 365,
      estimated8hReturn: markPrice ? markPrice * spread : null,
      direction: `做多 ${exchangeName(low.exchange)} / 做空 ${exchangeName(high.exchange)}`,
      allRates: valid,
      lowRate: low.rate8h,
      highRate: high.rate8h,
      return8h: spread,
      confidence,
      flags,
      dataAgeMs: Math.max(Number.isFinite(lowAge) ? lowAge : 0, Number.isFinite(highAge) ? highAge : 0),
      exchangesCount: valid.length,
    });
  }
  return results;
}

// ── 策略二:现货-永续资金费套利(买现货 + 做空永续收资金费;delta 中性)────────
// 资金费率为正 → 空头收多头的钱,故"做空永续 + 买现货"净赚资金费,币价涨跌不亏。
// 为负则需"做多永续 + 做空现货(融券)"——现货难做空,实操以正费率为主。
function buildSpotMap(spots) {
  const map = new Map();
  (spots || []).forEach((s) => {
    if (s && s.symbol && s.exchange && Number.isFinite(Number(s.spotPrice))) {
      map.set(`${s.exchange}:${s.symbol}`, Number(s.spotPrice));
    }
  });
  return map;
}

function calculateSpotPerp(rates, spots, evalPosition = 10000, now = Date.now()) {
  const spotMap = buildSpotMap(spots);
  const results = [];
  (rates || []).forEach((rate) => {
    if (!rate || !rate.symbol || !rate.exchange || !isValidRate(rate.fundingRate)) return;
    const rate8h = effectiveFundingRate(rate);
    if (!isValidRate(rate8h)) return;
    const absRate = Math.abs(rate8h);
    const apr = absRate * 3 * 365; // 8h 等价 × 3 次/天 × 365 → 年化
    const positive = rate8h > 0;
    const spotPrice = spotMap.get(`${rate.exchange}:${rate.symbol}`) ?? null;
    const spotAvailable = spotPrice !== null;
    const markPrice = Number(rate.markPrice) || null;
    const basis = spotAvailable && markPrice && spotPrice ? (markPrice - spotPrice) / spotPrice : null;
    const flags = legFlags({ ...rate, rate8h }, now);
    const confidence = flags.includes("stale") ? "low" : "high";
    const age = now - Date.parse(rate.fetchedAt);
    results.push({
      symbol: rate.symbol,
      exchange: rate.exchange,
      rate8h,
      fundingRate: rate.fundingRate,
      intervalHours: rate.intervalHours,
      apr,
      positive,
      direction: positive ? "shortPerp" : "longPerp",
      action: positive ? "买现货 + 做空永续" : "做空现货 + 做多永续",
      markPrice,
      spotPrice,
      basis,
      spotAvailable,
      nextFundingTime: rate.nextFundingTime ?? null,
      volume24h: rate.volume24h ?? null,
      openInterest: rate.openInterest ?? null,
      income8h: evalPosition * absRate, // 每 evalPosition 名义本金,每 8h 收的资金费
      confidence,
      flags,
      dataAgeMs: Number.isFinite(age) ? age : 0,
    });
  });
  return results;
}

function buildPreviousSnapshot(rows) {
  const snapshot = new Map();
  (rows || []).forEach((rate) => {
    if (rate && rate.symbol && rate.exchange && isValidRate(rate.fundingRate)) {
      snapshot.set(`${rate.symbol}:${rate.exchange}`, effectiveFundingRate(rate));
    }
  });
  return snapshot;
}

function calculateTrend(current, previousSnapshot) {
  if (!previousSnapshot || !current.symbol || !current.exchange) return "unknown";
  const previous = previousSnapshot.get(`${current.symbol}:${current.exchange}`);
  if (!Number.isFinite(previous)) return "unknown";
  const currentRate8h = current.rate8h ?? effectiveFundingRate(current);
  const delta = currentRate8h - previous;
  if (Math.abs(delta) < 0.000000001) return "flat";
  return delta > 0 ? "up" : "down";
}

function buildAllRatesRows(rates, previousSnapshot) {
  const groups = groupBySymbol(rates);
  return Object.entries(groups).map(([symbol, rows]) => {
    const byExchange = {};
    let min = Infinity;
    let max = -Infinity;
    rows.forEach((row) => {
      byExchange[row.exchange] = {
        ...row,
        trend: calculateTrend(row, previousSnapshot),
      };
      const val = row.rate8h;
      if (Number.isFinite(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
      }
    });
    return {
      symbol,
      byExchange,
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 0,
      range: (Number.isFinite(max) ? max : 0) - (Number.isFinite(min) ? min : 0),
    };
  });
}

function exchangeName(id) {
  return FundingAPI.EXCHANGE_NAMES[id] || id;
}

function formatPercent(value, digits = 4) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  let fixed = (num * 100).toFixed(digits);
  if (digits === 4 && (fixed === "0.0000" || fixed === "-0.0000") && num !== 0) fixed = (num * 100).toFixed(5);
  return `${fixed}%`;
}

function formatApr(value) {
  return formatPercent(value, 2);
}

function formatCurrency(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}

// 大额 USD 简写:1.2K / 3.4M / 5.6B
function formatUsdCompact(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return "--";
  const abs = Math.abs(num);
  if (abs >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

function sortRows(rows, sortKey, direction = "desc") {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp;
    if (sortKey === "symbol") {
      cmp = String(a.symbol).localeCompare(String(b.symbol));
    } else {
      const aValue = Number(a[sortKey]) || 0;
      const bValue = Number(b[sortKey]) || 0;
      cmp = aValue - bValue;
    }
    if (cmp !== 0) return multiplier * cmp;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
}

export const Arbitrage = {
  DEFAULT_MIN_SPREAD,
  isValidRate,
  effectiveFundingRate,
  legFlags,
  groupBySymbol,
  calculateArbitrages,
  calculateSpotPerp,
  buildSpotMap,
  buildPreviousSnapshot,
  buildAllRatesRows,
  formatPercent,
  formatApr,
  formatCurrency,
  formatUsdCompact,
  sortRows,
};
