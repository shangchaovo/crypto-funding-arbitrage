// 确定性单测:Meme 渐进渲染(onQuick 快帧 → GoPlus 终帧)+ 貔貅防线
// 用 mocked window/fetch 跑真实 js/meme.js,不依赖不稳定上游(GeckoTerminal 常 429)。
// 运行:node scripts/test-meme-progressive.mjs
//
// 覆盖的回归:fetchSecurity 是否"已检"必须看 _secChecked 而非 risk——
//   快帧会把 risk 预置 "unknown",若按 risk 过滤会把候选全误判为已检,
//   导致 GoPlus 一次不跑、貔貅(仅 GoPlus 可识别)漏筛。2026-08-17 修。

// ── 浏览器环境桩 ─────────────────────────────────────────────────────
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  location: { hostname: "localhost" },
};

// 三种代币:SAFE 正常 / HONEY 仅 GoPlus 可识别的貔貅(可冻结)/ RUG 硬特征(有买无卖)
const ADDR = { SAFE: "0xSAFE", HONEY: "0xHONEY", RUG: "0xRUG" };

function geckoPool(sym, addr, { buys = 50, sells = 40, h1 = 12, h24 = 30, liq = 30000 } = {}) {
  return {
    id: `solana_pool_${sym}`,
    attributes: {
      name: `${sym} / SOL`, address: `pool_${sym}`, base_token_price_usd: "0.5",
      price_change_percentage: { m5: "1", m15: "2", m30: "4", h1: String(h1), h6: String(h24 / 2), h24: String(h24) },
      volume_usd: { m5: "5000", m15: "12000", m30: "20000", h1: "80000", h6: "300000", h24: "900000" },
      transactions: { h1: { buys, sells, buyers: buys } },
      reserve_in_usd: String(liq), fdv_usd: "5000000", market_cap_usd: "4000000",
      pool_created_at: new Date(Date.now() - 90 * 60000).toISOString(),
    },
    relationships: { base_token: { data: { id: `solana_${addr}` } } },
  };
}

const GECKO_DATA = {
  data: [
    geckoPool("SAFE", ADDR.SAFE),
    geckoPool("HONEY", ADDR.HONEY, { buys: 60, sells: 45, h1: 18, liq: 50000 }),
    geckoPool("RUG", ADDR.RUG, { buys: 120, sells: 0, h1: 25, liq: 40000 }), // sells=0 → 有买无卖
  ],
};

function gplusSolana(addr, honeypot) {
  const info = honeypot ? { freezable: { status: "1" } } : { freezable: { status: "0" }, mintable: { status: "0" } };
  return { code: 1, message: "ok", result: { [addr]: info } };
}

const GPLUS_DELAY_MS = 120;
const fetchLog = [];
globalThis.fetch = async (input) => {
  const raw = typeof input === "string" ? input : input.url;
  let upstream = raw;
  const m = raw.match(/[?&]url=([^&]+)/);
  if (m) upstream = decodeURIComponent(m[1]);
  fetchLog.push(upstream);
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
  if (upstream.includes("api.geckoterminal.com")) return json(upstream.includes("/networks/solana/") ? GECKO_DATA : { data: [] });
  if (upstream.includes("api.dexscreener.com")) return json([]);
  if (upstream.includes("api.gopluslabs.io")) {
    await new Promise((r) => setTimeout(r, GPLUS_DELAY_MS));
    const addr = upstream.match(/contract_addresses=([^&]+)/)?.[1] || "";
    return json(gplusSolana(addr, addr === ADDR.HONEY));
  }
  return json({});
};

// ── 跑真实模块 ───────────────────────────────────────────────────────
const { Meme } = await import("../js/meme.js");

let seq = 0;
const events = [];
let quickSnap = null; // onQuick 当场深拷(GoPlus 会改同一对象)
const onQuick = (q) => {
  events.push({ t: ++seq, kind: "quick" });
  quickSnap = {
    securityPending: q.securityPending,
    tokens: q.tokens.map((t) => ({ symbol: t.symbol, risk: t.risk, riskPending: t.riskPending, filtered: t.filtered, score: t.score })),
  };
};
const finalPayload = await Meme.fetchMeme({ force: true, onQuick });
events.push({ t: ++seq, kind: "final" });

// ── 断言 ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};
const qBy = Object.fromEntries(quickSnap.tokens.map((t) => [t.symbol, t]));
const fBy = Object.fromEntries(finalPayload.tokens.map((t) => [t.symbol, t]));

console.log("\n[1] onQuick 时序");
check("onQuick 恰好触发一次", events.filter((e) => e.kind === "quick").length === 1);
check("onQuick 先于 final 返回", events[0]?.kind === "quick" && events[1]?.kind === "final");

console.log("\n[2] 快帧(GoPlus 前)貔貅防线");
check("快帧含 securityPending 标记", quickSnap.securityPending === true);
check("RUG(硬特征)快帧即筛除", qBy.RUG?.filtered === true);
check("RUG 快帧 risk=flagged", qBy.RUG?.risk === "flagged");
check("SAFE 快帧标 riskPending(检测中)", qBy.SAFE?.riskPending === true && qBy.SAFE?.risk === "unknown");
check("HONEY 快帧标 riskPending(检测中),不预先判安全", qBy.HONEY?.riskPending === true && qBy.HONEY?.risk === "unknown");
check("HONEY 快帧尚未筛除(等 GoPlus)", qBy.HONEY?.filtered === false);
check("快帧无任何 token 标 safe", quickSnap.tokens.every((t) => t.risk !== "safe"));

console.log("\n[3] 终帧(GoPlus 后)貔貅防线");
check("SAFE 终帧=安全", fBy.SAFE?.risk === "safe");
check("SAFE 终帧不筛除", fBy.SAFE?.filtered === false);
check("HONEY 终帧=危险(GoPlus 貔貅)", fBy.HONEY?.risk === "danger");
check("HONEY 终帧被筛除", fBy.HONEY?.filtered === true);
check("HONEY 终帧 honeypot 标记", fBy.HONEY?.honeypot === true);
check("RUG 终帧仍筛除", fBy.RUG?.filtered === true);
check("终帧 riskPending 全清除", finalPayload.tokens.every((t) => t.riskPending === undefined));
check("终帧按异动分排序", finalPayload.tokens.every((t, i, a) => i === 0 || a[i - 1].score >= t.score));

console.log("\n[4] GoPlus 实际被调用(逐币)");
const gplusCalls = fetchLog.filter((u) => u.includes("gopluslabs.io"));
check("GoPlus 调用=候选数(SAFE+HONEY;RUG 硬筛不查)", gplusCalls.length === 2, `got ${gplusCalls.length}`);

console.log(`\n结果:${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
