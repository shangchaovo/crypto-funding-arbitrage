// ============================================================================
// Meme 异动监测:GeckoTerminal(链上 DEX 池子:价/量/动量/池龄/流动性)
//              + DexScreener(boost 社交热度)
// 目标:在"暴涨前或刚开始"阶段发现异动——成交量异常放大 + 动量刚启动 + 池龄新 + 有热度。
// ============================================================================
import { FundingAPI } from "./api.js?v=20260817e";

const { fetchWithRetry } = FundingAPI;

// 重点监控的链(meme 主战场;eth/arbitrum meme 较少且易触发限流,默认关闭可在设置开)
const NETWORKS = ["solana", "base", "bsc", "eth"];

const NETWORK_NAMES = {
  solana: "Solana", base: "Base", bsc: "BSC", eth: "Ethereum", arbitrum: "Arbitrum",
  polygon: "Polygon", optimism: "Optimism", avalanche: "Avalanche", ton: "TON", sui: "Sui",
};

// 稳定币/大盘币作为 base 不是 meme 候选(它们是报价币或蓝筹),直接排除
const NON_MEME_BASE = new Set([
  "USDC", "USDT", "USD1", "DAI", "FDUSD", "USDE", "TUSD", "USDD", "PYUSD",
  "WETH", "WBTC", "ETH", "BTC", "BNB", "WBNB", "SOL", "WSOL", "WBSC", "stETH", "weETH",
]);

// 客户端短缓存:看板轮询时避免对上游(Go 限流敏感)猛刷
let _memeCache = null;
const MEME_CACHE_TTL_MS = 60_000;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 涨跌幅钳制:跌幅不可能超 -100%,GeckoTerminal 对薄池/新池常返回占位脏数据(如 -4101%)。
// 钳到合理区间,避免脏值污染评分与阶段判定。
function clampChg(v) {
  const n = toNum(v);
  if (n < -99) return -99;
  if (n > 99999) return 99999;
  return n;
}

// 限并发 + 批间隔,避免触发 GeckoTerminal 突发限流(429/502)
async function mapLimit(items, limit, fn, gapMs = 250) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const res = await Promise.all(batch.map(fn));
    out.push(...res);
    if (i + limit < items.length) await new Promise((r) => setTimeout(r, gapMs));
  }
  return out;
}

// ── GeckoTerminal:某链的趋势池 + 新池 ────────────────────────────────────
async function fetchGeckoPools(network, kind) {
  // kind: "trending_pools" | "new_pools"
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/${kind}?page=1`;
  const payload = await fetchWithRetry(url, { attempts: 1, connectTimeoutMs: 6000, readTimeoutMs: 12000 });
  return (payload && payload.data) || [];
}

// 把一个 GeckoTerminal 池子归一成统一模型
function normalizePool(pool, network, kind) {
  const a = (pool && pool.attributes) || {};
  const rel = (pool && pool.relationships) || {};
  const name = a.name || "";
  const baseSymbol = name.split("/")[0]?.trim() || "?";
  const baseAddr = rel.base_token && rel.base_token.data && rel.base_token.data.id
    ? String(rel.base_token.data.id).split("_").pop() : "";
  const pc = a.price_change_percentage || {};
  const vol = a.volume_usd || {};
  const tx = a.transactions || {};
  const h1 = tx.h1 || {};
  const createdAt = a.pool_created_at ? Date.parse(a.pool_created_at) : null;
  return {
    id: pool.id || `${network}_${a.address}`,
    chain: network,
    chainName: NETWORK_NAMES[network] || network,
    kind, // "trending" | "new"
    symbol: baseSymbol,
    name,
    address: a.address || "",
    baseAddress: baseAddr,
    priceUsd: toNum(a.base_token_price_usd),
    chg: { m5: clampChg(pc.m5), m15: clampChg(pc.m15), m30: clampChg(pc.m30), h1: clampChg(pc.h1), h6: clampChg(pc.h6), h24: clampChg(pc.h24) },
    vol: { m5: toNum(vol.m5), m15: toNum(vol.m15), m30: toNum(vol.m30), h1: toNum(vol.h1), h6: toNum(vol.h6), h24: toNum(vol.h24) },
    buysH1: toNum(h1.buys),
    sellsH1: toNum(h1.sells),
    buyersH1: toNum(h1.buyers),
    liquidityUsd: toNum(a.reserve_in_usd),
    fdv: toNum(a.fdv_usd),
    marketCap: toNum(a.market_cap_usd),
    createdAt,
    ageMinutes: createdAt ? Math.max(0, (Date.now() - createdAt) / 60000) : null,
    boosted: false,
    url: a.address ? `https://www.geckoterminal.com/${network}/pools/${a.address}` : "",
  };
}

// ── DexScreener:boost(正在被拉盘/买量的代币,社交热度信号)─────────────────
async function fetchBoosted() {
  const urls = [
    "https://api.dexscreener.com/token-boosts/latest/v1",
    "https://api.dexscreener.com/token-boosts/top/v1",
  ];
  const boosted = new Map(); // tokenAddress -> boost amount
  await Promise.all(
    urls.map(async (url) => {
      try {
        const payload = await fetchWithRetry(url, { attempts: 1, connectTimeoutMs: 6000, readTimeoutMs: 10000 });
        (Array.isArray(payload) ? payload : []).forEach((item) => {
          const addr = item && item.tokenAddress;
          if (!addr) return;
          const amt = toNum(item.amount) || 1;
          boosted.set(addr, Math.max(boosted.get(addr) || 0, amt));
        });
      } catch (e) {
        console.warn("DexScreener boost fetch failed", e);
      }
    }),
  );
  return boosted;
}

// ── GoPlus 合约安全检测(貔貅/蜜罐识别,权威层)─────────────────────────────
// EVM 链 → GoPlus chain id;Solana 走独立端点
const GPLUS_EVM_CHAIN = { eth: "1", bsc: "56", base: "8453", arbitrum: "42161", polygon: "137" };

function gplusVerdictEvm(info) {
  const flag = (k) => String(info[k] ?? "") === "1";
  const tax = (k) => { const v = parseFloat(info[k]); return Number.isFinite(v) ? v : 0; };
  const reasons = [];
  let risk = "safe";
  if (flag("is_honeypot") || flag("cannot_sell_all")) { reasons.push("貔貅/不可卖出"); risk = "danger"; }
  if (tax("sell_tax") > 0.1) { reasons.push(`卖出税 ${(tax("sell_tax") * 100).toFixed(0)}%`); risk = "danger"; }
  if (risk === "safe") {
    if (tax("buy_tax") > 0.1) { reasons.push(`买入税 ${(tax("buy_tax") * 100).toFixed(0)}%`); risk = "caution"; }
    if (flag("hidden_owner")) { reasons.push("隐藏owner"); risk = "caution"; }
    if (flag("can_take_back_ownership")) { reasons.push("可回收owner"); risk = "caution"; }
    if (flag("owner_change_balance")) { reasons.push("owner可改余额"); risk = "caution"; }
    if (flag("is_proxy")) { reasons.push("代理合约"); risk = risk === "safe" ? "caution" : risk; }
  }
  return { risk, reasons };
}

function gplusVerdictSolana(info) {
  const st = (k) => { const v = info[k]; return v && typeof v === "object" ? String(v.status ?? "0") : String(v ?? "0"); };
  const reasons = [];
  let risk = "safe";
  if (st("default_account_state") === "2") { reasons.push("默认冻结账户"); risk = "danger"; }
  if (st("freezable") === "1") { reasons.push("可冻结"); risk = "danger"; }
  if (st("balance_mutable_authority") === "1") { reasons.push("余额可篡改"); risk = "danger"; }
  if (risk === "safe") {
    if (st("mintable") === "1") { reasons.push("可增发"); risk = "caution"; }
    if (st("closable") === "1") { reasons.push("可关闭"); risk = "caution"; }
  }
  return { risk, reasons };
}

// GoPlus 判定缓存:地址→{verdict,time}(合约属性变化慢,10 分钟内复用)
const _gplusCache = new Map();
const GPLUS_CACHE_TTL_MS = 10 * 60_000;

// 单地址检测(GoPlus 免费层现每次只处理首个地址,故逐币调用;限并发防限流)
async function checkOne(t) {
  const key = `${t.chain}:${String(t.baseAddress).toLowerCase()}`;
  const hit = _gplusCache.get(key);
  if (hit && Date.now() - hit.time < GPLUS_CACHE_TTL_MS) {
    Object.assign(t, hit.verdict);
    return;
  }
  const isSol = t.chain === "solana";
  const chainId = GPLUS_EVM_CHAIN[t.chain];
  if (!isSol && !chainId) { t.risk = t.risk || "unknown"; return; }
  const url = isSol
    ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${t.baseAddress}`
    : `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${t.baseAddress}`;
  try {
    const payload = await fetchWithRetry(url, { attempts: 1, connectTimeoutMs: 6000, readTimeoutMs: 12000 });
    const result = (payload && payload.result) || {};
    const k = Object.keys(result).find((kk) => kk.toLowerCase() === String(t.baseAddress).toLowerCase());
    const info = k ? result[k] : null;
    if (!info) { t.risk = t.risk || "unknown"; return; } // 未被 GoPlus 收录 → 保持 unknown
    const verdict = isSol ? gplusVerdictSolana(info) : gplusVerdictEvm(info);
    const out = {
      risk: verdict.risk,
      riskReasons: verdict.reasons,
      honeypot: verdict.risk === "danger",
    };
    Object.assign(t, out);
    _gplusCache.set(key, { time: Date.now(), verdict: out });
  } catch (e) {
    t.risk = t.risk || "unknown"; // 失败不阻断
  }
}

// 对候选代币做合约安全检测;逐币限并发,失败不阻断(回落 risk:"unknown")
// 注意:是否已检看 _secChecked,不看 risk——快帧会把 risk 预置为 "unknown",
//       若按 risk 过滤会把所有候选误判为"已检",导致 GoPlus 一次都不跑。
async function fetchSecurity(tokens) {
  const targets = tokens.filter((t) => t.baseAddress && !t._secChecked);
  await mapLimit(targets, 6, async (t) => { await checkOne(t); t._secChecked = true; }, 150);
  return tokens;
}

// ── 硬 rug 特征(在 GoPlus 之前先挡;命中即默认筛除)─────────────────────────
function cheapRedFlag(t) {
  const flags = [];
  if (t.buysH1 >= 20 && t.sellsH1 <= 1) flags.push("有买无卖"); // 貔貅特征:只进不出
  if (t.chg.h24 > 8000 || t.chg.h1 > 3000) flags.push("异常涨幅"); // 假盘刷量
  return flags;
}

// ── 异动评分:量异常(主)× 动量 × 买压 × 池龄(早期)× 热度;流动性仅作安全门 ──
const _r2 = (v) => Math.round(v * 100) / 100;
const _r3 = (v) => Math.round(v * 1000) / 1000;
function scoreAnomaly(t) {
  // 安全门:深度过低≈不可交易,重罚;但不作为排名驱动(避免老币霸榜)
  const liq = t.liquidityUsd;
  let liqFactor;
  if (liq >= 20000) liqFactor = 1.0;
  else if (liq >= 8000) liqFactor = 0.9;
  else if (liq >= 3000) liqFactor = 0.65;
  else liqFactor = 0.15;

  // 量异常(核心信号):h1 相对 h24 均值放大倍数;新池(h24 未满一天)用 h1 绝对量分级
  let volSpike = 0;
  if (t.vol.h24 > 0 && (t.ageMinutes == null || t.ageMinutes >= 720)) {
    volSpike = t.vol.h1 / Math.max(t.vol.h24 / 24, 1);
  }
  const volScore = Math.min(volSpike, 15) + Math.min(t.vol.h1 / 100000, 4); // spike 为主,绝对量为辅

  // 动量(早期导向):温和上涨=甜区(加分);已爆拉(高位)=不适合追,重罚;假盘刷量更罚
  const h1 = t.chg.h1;
  const h24 = t.chg.h24;
  let momentum;
  if (h1 <= 0) momentum = 0;
  else if (h1 <= 60) momentum = 0.5 + (h1 / 60) * 1.5; // 0.5..2.0 甜区递增
  else if (h1 <= 150) momentum = 2.0 - ((h1 - 60) / 90) * 1.3; // 2.0..0.7 渐晚
  else momentum = 0.35; // 已爆拉(>150%),不追
  if (h24 > 300) momentum *= 0.3; // 24h 已翻数倍=高潮期
  if (h24 > 5000 || h1 > 2500) momentum *= 0.1; // 假盘刷量,重罚
  const accel = (t.chg.m5 > 0 ? 0.5 : 0) + (t.chg.m15 > 0 ? 0.5 : 0); // 0..1
  const earlyBonus = h1 > 2 && h1 < 120 && accel >= 1 ? 0.7 : 0; // 温和放量上攻=更早期

  // 买压
  const tot = t.buysH1 + t.sellsH1;
  const buyRatio = tot > 0 ? t.buysH1 / tot : 0.5;
  const buyFactor = Math.max(0.5, Math.min(1.5, buyRatio * 2));

  // 早期(越新越好;老币不是"早期发现",重罚——目标是在暴涨前/初期发现)
  let recency = 1.0;
  if (t.ageMinutes != null) {
    if (t.ageMinutes < 5) recency = 0.7; // 太新,数据不足
    else if (t.ageMinutes < 120) recency = 2.0; // <2h 最新
    else if (t.ageMinutes < 720) recency = 1.6; // <12h
    else if (t.ageMinutes < 2880) recency = 1.3; // <2天
    else if (t.ageMinutes < 10080) recency = 0.8; // <7天
    else recency = 0.3; // >7天老币,基本非"早期"
  }
  const boostFactor = t.boosted ? 1.6 : 1.0;

  const score = volScore * (1 + momentum + earlyBonus) * buyFactor * recency * boostFactor * liqFactor;
  return { score: _r2(score), volSpike: _r2(volSpike), buyRatio: _r3(buyRatio), momentum: _r3(momentum) };
}

// 阶段标签:对应"暴涨前(吸筹)/ 刚开始(启动)/ 已拉升";吸筹/启动 仅判给年轻池(<3天),
// 老币放量只是"活跃"而非早期吸筹——避免把老币的正常波动误标为早期信号。
function stageOf(t) {
  const spike = (t.volSpike || 0) >= 2;
  const h1 = t.chg.h1;
  const young = t.ageMinutes == null || t.ageMinutes < 4320; // <3天 视为"早期"
  if (t.chg.h1 >= 80 || t.chg.h24 >= 200) return { key: "pumped", label: "已拉升" };
  if (young && spike && h1 > 5) return { key: "launching", label: "启动" };
  if (young && spike && h1 <= 5) return { key: "accumulate", label: "吸筹" }; // 量放大价未动→可能吸筹
  if (!young && spike) return { key: "active", label: "活跃" }; // 老币放量,非早期
  return { key: "flat", label: "平稳" };
}

// ── 主入口:限并发拉各链 + boost,归一、去重、排除稳定币、评分、安全检测、排序 ──
async function fetchMeme(options = {}) {
  // 短缓存:轮询时若新鲜直接复用,避免触发上游限流
  if (!options.force && _memeCache && Date.now() - _memeCache.time < MEME_CACHE_TTL_MS) {
    return _memeCache.payload;
  }
  const networks = options.networks || NETWORKS;
  const status = {};

  const tasks = [];
  networks.forEach((net) => {
    tasks.push([net, "trending_pools"]);
    tasks.push([net, "new_pools"]);
  });

  // 限并发(3)+ 批间隔,避免 GeckoTerminal 突发限流
  const results = await mapLimit(tasks, 3, async ([net, kind]) => {
    try {
      const rows = await fetchGeckoPools(net, kind);
      status[`${net}/${kind}`] = rows.length ? "ok" : "empty";
      return rows.map((p) => normalizePool(p, net, kind === "trending_pools" ? "trending" : "new"));
    } catch (e) {
      status[`${net}/${kind}`] = "error";
      console.warn(`GeckoTerminal ${net}/${kind} failed`, e);
      return [];
    }
  }, 300);

  let boosted = new Map();
  try {
    boosted = await fetchBoosted();
    status["dexscreener/boost"] = boosted.size ? "ok" : "empty";
  } catch (e) {
    status["dexscreener/boost"] = "error";
  }

  // 合并 + 按地址去重(trending 优先于 new,保留信息更全的)+ 排除稳定币/大盘币 base
  const byAddr = new Map();
  results.flat().forEach((t) => {
    if (!t.address) return;
    if (NON_MEME_BASE.has((t.symbol || "").toUpperCase())) return; // 稳定币/蓝筹非 meme
    const key = `${t.chain}:${t.address}`;
    const existing = byAddr.get(key);
    if (!existing || (existing.kind === "new" && t.kind === "trending")) {
      byAddr.set(key, t);
    }
  });

  const tokens = Array.from(byAddr.values()).map((t) => {
    if (t.baseAddress && boosted.has(t.baseAddress)) t.boosted = true;
    const s = scoreAnomaly(t);
    return { ...t, ...s };
  });

  // 貔貅防线①:硬 rug 特征(有买无卖/异常涨幅)
  tokens.forEach((t) => { t.rugFlags = cheapRedFlag(t); });

  // 根据当前 risk 计算 shallow/stage/filtered 并按异动分排序(快/终两阶段共用)
  const finalize = () => {
    tokens.forEach((t) => {
      if (!t.risk) t.risk = t.rugFlags.length ? "flagged" : "unknown";
      t.shallow = t.liquidityUsd < 5000; // 浅盘警示(不筛除)
      t.stage = stageOf(t); // 吸筹/启动/已拉升/平稳
      // 默认筛除:GoPlus 判 danger(貔貅/高卖税/可冻结) 或 硬 rug 特征
      t.filtered = t.risk === "danger" || t.rugFlags.length > 0;
    });
    tokens.sort((a, b) => b.score - a.score);
  };

  // 貔貅防线②候选:GoPlus 逐币调用最贵,只查"得分最高"的榜前 N 个
  const secN = options.securityTopN || 40;
  const candidates = options.checkSecurity !== false
    ? tokens
      .filter((t) => t.rugFlags.length === 0 && t.baseAddress)
      .sort((a, b) => b.score - a.score)
      .slice(0, secN)
    : [];

  // 秒回:合约检测最耗时(逐币 GoPlus ~10s+),先上板。
  //   硬 rug 特征(有买无卖/异常涨幅)此时已即时筛除;
  //   待检候选标 riskPending(徽章="检测中",绝不预先标"安全"),
  //   GoPlus danger 出来后第二帧再筛除——貔貅防线不因求快而放宽。
  if (typeof options.onQuick === "function") {
    const pending = new Set(candidates);
    tokens.forEach((t) => { t.riskPending = pending.has(t); });
    finalize();
    try {
      options.onQuick({
        tokens,
        status: { ...status, goplus: candidates.length ? "checking" : "skip" },
        fetchedAt: new Date().toISOString(),
        securityPending: candidates.length > 0,
      });
    } catch (e) { /* 渲染回调不影响数据流程 */ }
  }

  // GoPlus 合约安全检测(逐币,限并发)
  if (candidates.length) {
    status["goplus"] = "checking";
    await fetchSecurity(candidates);
    status["goplus"] = "ok";
  }
  tokens.forEach((t) => { delete t.riskPending; });
  finalize();

  const payload = { tokens, status, fetchedAt: new Date().toISOString() };
  _memeCache = { time: Date.now(), payload };
  return payload;
}

export const Meme = {
  NETWORKS,
  NETWORK_NAMES,
  fetchMeme,
  scoreAnomaly,
  stageOf,
};
