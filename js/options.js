// ============================================================================
// 板块④:期权 Wall — 数据 + 分析(纯 JS,无依赖)
//   数据源(自动择优):
//     · Deribit(主流,持仓最深)——本地经本地代理可达;但封锁 Cloudflare 边缘 IP(429)。
//     · OKX 期权(兜底)——公网边缘可达,确保公网也能出墙;深度略逊于 Deribit。
//   指标:Max Pain 最大痛点、按行权价 Call/Put 持仓分布、大押注区、PCR、25Δ Skew。
// ============================================================================
import { FundingAPI } from "./api.js?v=20260817c";

const { fetchWithRetry } = FundingAPI;
const DERIBIT = "https://www.deribit.com/api/v2/public";
const OKX = "https://www.okx.com";

export const COINS = [
  { id: "BTC", deribitContract: 0.1, okxUly: "BTC-USD", emoji: "🟠" },
  { id: "ETH", deribitContract: 1, okxUly: "ETH-USD", emoji: "🟣" },
];

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// ── Deribit ────────────────────────────────────────────────────────────────
async function deribitGet(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const data = await fetchWithRetry(`${DERIBIT}/${endpoint}${qs ? `?${qs}` : ""}`, {
    attempts: 2, connectTimeoutMs: 8000, readTimeoutMs: 20000,
  });
  if (data && data.error) throw new Error(data.error.message || "Deribit API error");
  return data && data.result;
}

function parseDeribitDate(dateStr) {
  const m = String(dateStr).match(/^(\d{1,2})([A-Z]{3})(\d{2})$/i);
  if (!m) return new Date(NaN);
  const [, day, mon, yr] = m;
  return new Date(Date.UTC(+(`20${yr}`), MONTHS[mon.toUpperCase()], +day, 8, 0, 0));
}

function parseDeribitInstrument(name) {
  const parts = String(name).split("-");
  if (parts.length !== 4) return null;
  const [coin, dateStr, strikeStr, type] = parts;
  const strike = parseFloat(strikeStr);
  const expiry = parseDeribitDate(dateStr);
  if (!Number.isFinite(strike) || Number.isNaN(expiry.getTime())) return null;
  return { coin, strike, type: type === "C" ? "call" : "put", expiry };
}

async function fetchDeribitOptions(coin) {
  const [bookSummary, spotRes, instruments] = await Promise.all([
    deribitGet("get_book_summary_by_currency", { currency: coin.id, kind: "option" }),
    deribitGet("get_index_price", { index_name: `${coin.id.toLowerCase()}_usd` }),
    deribitGet("get_instruments", { currency: coin.id, kind: "option", expired: "false" }),
  ]);
  const spotPrice = (spotRes && spotRes.index_price) || 0;
  if (!spotPrice) throw new Error("Deribit 现货指数为空");
  const instMap = new Map((instruments || []).map((i) => [i.instrument_name, i]));
  const now = new Date();
  const options = [];
  for (const item of bookSummary || []) {
    const parsed = parseDeribitInstrument(item.instrument_name);
    if (!parsed || parsed.expiry <= now) continue;
    const inst = instMap.get(item.instrument_name);
    const contractSize = (inst && inst.contract_size) || coin.deribitContract;
    const oiCoin = (item.open_interest || 0) * contractSize;
    if (oiCoin <= 0) continue;
    options.push({
      ...parsed,
      dateStr: parsed.expiry.toISOString().split("T")[0],
      openInterestCoin: oiCoin,
      openInterestUsd: oiCoin * spotPrice,
      iv: item.mark_iv ?? item.iv ?? 0,
    });
  }
  return { spotPrice, options, source: "deribit" };
}

// ── OKX(兜底)─────────────────────────────────────────────────────────────
async function okxGet(path) {
  const data = await fetchWithRetry(`${OKX}${path}`, { attempts: 2, connectTimeoutMs: 7000, readTimeoutMs: 15000 });
  if (!data || data.code !== "0") throw new Error(data?.msg || `OKX ${path} 返回异常`);
  return data.data;
}

// BTC-USD-260817-59000-C → {strike, type, expiry}(OKX 到期 08:00 UTC)
function parseOkxInstId(instId) {
  const parts = String(instId).split("-");
  if (parts.length !== 5) return null;
  const [, , ymd, strikeStr, typeFlag] = parts;
  const m = String(ymd).match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const strike = parseFloat(strikeStr);
  const expiry = new Date(Date.UTC(2000 + +yy, +mm - 1, +dd, 8, 0, 0));
  if (!Number.isFinite(strike) || Number.isNaN(expiry.getTime())) return null;
  return { strike, type: typeFlag === "C" ? "call" : "put", expiry };
}

async function fetchOkxOptions(coin) {
  const uly = coin.okxUly;
  const base = uly.split("-")[0];
  const [oiRows, summaryRows, spotRows] = await Promise.all([
    okxGet(`/api/v5/public/open-interest?instType=OPTION&uly=${uly}`),
    okxGet(`/api/v5/public/opt-summary?uly=${uly}`),
    okxGet(`/api/v5/market/index-tickers?instId=${base}-USD`),
  ]);
  const spotPrice = parseFloat((spotRows || [])[0]?.idxPx) || 0;
  if (!spotPrice) throw new Error("OKX 期权指数为空");
  const ivMap = new Map((summaryRows || []).map((s) => [s.instId, parseFloat(s.markVol) || 0]));
  const now = new Date();
  const options = [];
  for (const r of oiRows || []) {
    const oiCoin = parseFloat(r.oiCcy) || 0;
    if (oiCoin <= 0) continue;
    const parsed = parseOkxInstId(r.instId);
    if (!parsed || parsed.expiry <= now) continue;
    const ivRaw = ivMap.get(r.instId) || 0;
    options.push({
      ...parsed,
      coin: coin.id,
      dateStr: parsed.expiry.toISOString().split("T")[0],
      openInterestCoin: oiCoin,
      openInterestUsd: parseFloat(r.oiUsd) || oiCoin * spotPrice,
      iv: ivRaw > 3 ? ivRaw : ivRaw * 100, // OKX markVol 为小数,统一成 %
    });
  }
  return { spotPrice, options, source: "okx" };
}

// ── 分析(统一模型)─────────────────────────────────────────────────────────
function groupByExpiry(options) {
  const groups = new Map();
  for (const opt of options) {
    const key = opt.expiry.toISOString().split("T")[0];
    if (!groups.has(key)) groups.set(key, { date: opt.expiry, dateStr: opt.dateStr, options: [] });
    groups.get(key).options.push(opt);
  }
  return [...groups.values()].sort((a, b) => a.date - b.date);
}

function calculateMaxPain(options, spotPrice) {
  const strikes = [...new Set(options.map((o) => o.strike))].sort((a, b) => a - b);
  if (!strikes.length) return null;
  let minPain = Infinity;
  let maxPainStrike = strikes[0];
  for (const testStrike of strikes) {
    let total = 0;
    for (const opt of options) {
      total += opt.type === "call"
        ? Math.max(0, testStrike - opt.strike) * opt.openInterestCoin
        : Math.max(0, opt.strike - testStrike) * opt.openInterestCoin;
    }
    if (total < minPain) { minPain = total; maxPainStrike = testStrike; }
  }
  return {
    maxPainStrike,
    totalOiUsd: options.reduce((s, o) => s + o.openInterestUsd, 0),
    totalOiCoin: options.reduce((s, o) => s + o.openInterestCoin, 0),
    deviation: ((maxPainStrike - spotPrice) / spotPrice) * 100,
  };
}

function calculatePCR(options) {
  let callOi = 0; let putOi = 0; let callOiUsd = 0; let putOiUsd = 0;
  for (const o of options) {
    if (o.type === "call") { callOi += o.openInterestCoin; callOiUsd += o.openInterestUsd; }
    else { putOi += o.openInterestCoin; putOiUsd += o.openInterestUsd; }
  }
  return { pcr: callOi > 0 ? putOi / callOi : 0, callOi, putOi, callOiUsd, putOiUsd, totalOi: callOi + putOi, totalOiUsd: callOiUsd + putOiUsd };
}

function findConcentrations(options, topN = 10) {
  const map = new Map();
  for (const opt of options) {
    const key = `${opt.strike}-${opt.type}`;
    if (!map.has(key)) map.set(key, { strike: opt.strike, type: opt.type, totalOiCoin: 0, totalOiUsd: 0, count: 0 });
    const it = map.get(key);
    it.totalOiCoin += opt.openInterestCoin;
    it.totalOiUsd += opt.openInterestUsd;
    it.count += 1;
  }
  const all = [...map.values()];
  const totalOi = all.reduce((s, x) => s + x.totalOiCoin, 0);
  all.sort((a, b) => b.totalOiCoin - a.totalOiCoin);
  return all.slice(0, topN).map((x) => ({ ...x, pctOfTotal: totalOi > 0 ? (x.totalOiCoin / totalOi) * 100 : 0 }));
}

function buildStrikeDistribution(options) {
  const map = new Map();
  for (const o of options) {
    if (!map.has(o.strike)) map.set(o.strike, { strike: o.strike, callOi: 0, putOi: 0, callOiUsd: 0, putOiUsd: 0 });
    const it = map.get(o.strike);
    if (o.type === "call") { it.callOi += o.openInterestCoin; it.callOiUsd += o.openInterestUsd; }
    else { it.putOi += o.openInterestCoin; it.putOiUsd += o.openInterestUsd; }
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}

// 25Δ 风险逆转近似(±12% 行权价 nearest put/call IV 差,45 天内),统一作用于归一模型。
function calculateSkew(spot, options) {
  if (!spot) return null;
  const lowerStrike = spot * 0.88;
  const upperStrike = spot * 1.12;
  const now = Date.now();
  let bestPut = null;
  let bestCall = null;
  for (const opt of options) {
    const days = (opt.expiry - now) / 86400000;
    if (days < 0 || days > 45) continue;
    if (opt.type === "put") {
      const distance = Math.abs(opt.strike - lowerStrike);
      if (!bestPut || distance < bestPut.distance) bestPut = { strike: opt.strike, iv: opt.iv, distance };
    } else {
      const distance = Math.abs(opt.strike - upperStrike);
      if (!bestCall || distance < bestCall.distance) bestCall = { strike: opt.strike, iv: opt.iv, distance };
    }
  }
  if (!bestPut?.iv || !bestCall?.iv) return null;
  const avgIv = (bestPut.iv + bestCall.iv) / 2;
  if (!avgIv) return null;
  return {
    skew: ((bestPut.iv - bestCall.iv) / avgIv) * 100,
    putIv: bestPut.iv, callIv: bestCall.iv,
    putStrike: bestPut.strike, callStrike: bestCall.strike,
  };
}

// ── 单币种完整分析(Deribit 优先,OKX 兜底)─────────────────────────────────
async function analyzeCoin(coin) {
  let data;
  let usedSource;
  try {
    data = await fetchDeribitOptions(coin);
    usedSource = "deribit";
  } catch (e) {
    data = await fetchOkxOptions(coin);
    usedSource = "okx";
  }
  const { spotPrice, options } = data;
  if (!options.length) throw new Error(`${coin.id} 无有效期权持仓`);

  const expiries = groupByExpiry(options);
  const maxPainByExpiry = expiries.slice(0, 6).map((g) => ({
    dateStr: g.dateStr,
    date: g.date,
    daysTo: Math.ceil((g.date - Date.now()) / 86400000),
    ...calculateMaxPain(g.options, spotPrice),
  }));
  const pcr = calculatePCR(options);

  return {
    coin: coin.id,
    emoji: coin.emoji,
    source: usedSource,
    spotPrice,
    optionCount: options.length,
    expiryCount: expiries.length,
    pcr,
    skew: calculateSkew(spotPrice, options),
    maxPainByExpiry,
    nearestMaxPain: maxPainByExpiry[0] || null,
    concentrations: findConcentrations(options, 12),
    strikeDist: buildStrikeDistribution(options),
    totalOiUsd: pcr.totalOiUsd,
  };
}

export async function fetchOptions(options = {}) {
  const coins = options.coins || COINS;
  const settled = await Promise.allSettled(coins.map((c) => analyzeCoin(c)));
  const results = [];
  const errors = {};
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) results.push(r.value);
    else errors[coins[i].id] = String(r.reason && r.reason.message ? r.reason.message : r.reason);
  });
  results.sort((a, b) => COINS.findIndex((c) => c.id === a.coin) - COINS.findIndex((c) => c.id === b.coin));
  return { results, errors, fetchedAt: new Date().toISOString() };
}

export const Options = { COINS, fetchOptions, analyzeCoin };
