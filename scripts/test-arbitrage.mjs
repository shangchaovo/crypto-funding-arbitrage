// 可选安全网：纯函数级断言，node scripts/test-arbitrage.mjs 直跑。应用不依赖本文件。
// 运行前 stub 浏览器全局，使 js/arbitrage.js → js/api.js 能在 Node 下被 import（api.js 仅函数体内用 window）。
globalThis.window = globalThis.window || {
  setTimeout,
  clearTimeout,
  location: { hostname: "localhost" },
};

let passed = 0;
let failed = 0;
function eq(name, actual, expected, eps = 1e-9) {
  const ok = typeof expected === "number" ? Math.abs(actual - expected) <= eps : actual === expected;
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`); }
}

const { Arbitrage } = await import("../js/arbitrage.js");

const NOW = Date.UTC(2026, 6, 23, 12, 0, 0);
const FRESH = new Date(NOW - 5 * 60_000).toISOString();     // 5 分钟前
const STALE = new Date(NOW - 17 * 24 * 3600_000).toISOString(); // 17 天前
const CAP8H = 0.0001;   // 0.0100% 8h 等价 = 上限腿
const ZERO8H = 0;       // 零腿
const REAL_NEG = -0.0004; // 真实负费率腿

function leg(exchange, rate8h, fetchedAt) {
  // rate8h 由 groupBySymbol 从 fundingRate/intervalHours 推导，故此处反推 fundingRate（intervalHours=8）
  return { symbol: "TEST", exchange, fundingRate: rate8h, intervalHours: 8, fetchedAt, markPrice: 1 };
}

console.log("# 质量门控 (calculateArbitrages)");
// 1) 陈旧腿 → low（旧缓存制造的“机会”应被降级）
let r = Arbitrage.calculateArbitrages([leg("dydx", ZERO8H, STALE), leg("hyperliquid", CAP8H, STALE)], 0.00001, NOW);
eq("stale legs -> low", r[0]?.confidence, "low");
eq("stale flags include stale", r[0]?.flags?.includes("stale"), true);

// 2) 新鲜 真零 vs 真实负/正(非上限) → high（ genuine 机会不被误杀）
r = Arbitrage.calculateArbitrages([leg("dydx", ZERO8H, FRESH), leg("binance", 0.0003, FRESH)], 0.00001, NOW);
eq("fresh genuine zero vs real -> high", r[0]?.confidence, "high");

// 3) 新鲜 零腿 + 上限腿 → low（伪套利模式，即使数据新鲜也降级）
r = Arbitrage.calculateArbitrages([leg("dydx", ZERO8H, FRESH), leg("hyperliquid", CAP8H, FRESH)], 0.00001, NOW);
eq("fresh zero+cap phantom -> low", r[0]?.confidence, "low");
eq("phantom flags zero+cap", r[0]?.flags?.includes("zero-leg") && r[0]?.flags?.includes("cap-leg"), true);

// 4) 新鲜 真实负 vs 上限 → high（非零腿，真实价差）
r = Arbitrage.calculateArbitrages([leg("dydx", REAL_NEG, FRESH), leg("hyperliquid", CAP8H, FRESH)], 0.00001, NOW);
eq("fresh real-neg vs cap -> high", r[0]?.confidence, "high");

// 5) 拍平字段 return8h == spread，便于排序
eq("return8h equals spread", r[0]?.return8h, r[0]?.spread);

console.log("# 模拟器公式（复刻 app.js updateSimulator 的 Phase3 模型，防 *100 回归）");
function sim({ spread, position, leverage, holdHours }) {
  const feeRate = 0.0008;
  const notional = position * leverage;
  const gross8h = notional * spread;
  const totalFee = 2 * feeRate * notional;
  const periods = Math.max(1, holdHours / 8);
  const feePer8h = totalFee / periods;
  const net8h = gross8h - feePer8h;
  const apr = spread * 3 * 365;
  const feeDragApr = (2 * feeRate * 8 / holdHours) * 3 * 365;
  const netApr = apr * leverage - feeDragApr; // 禁止 *100
  return { net8h, netApr, totalFee };
}
let s = sim({ spread: 0.0001, position: 10000, leverage: 1, holdHours: 24 });
eq("sim net8h ≈ -4.33", s.net8h, -4.333333333333333, 1e-6);
eq("sim netApr ≈ -0.474", s.netApr, -0.4745, 1e-6);
eq("sim totalFee = 16", s.totalFee, 16, 1e-9);
// 回归保护：旧 bug 公式会得出 ≈ -87.49（再 *100 显示 -8749%）；新公式 netApr 必须在 [-1, 5] 区间
eq("sim netApr sane (no *100 bug)", s.netApr > -1 && s.netApr < 5, true);

console.log("# 按仓位口径的每8h收益");
eq("evalPosition*spread", +(10000 * 0.000121).toFixed(2), 1.21, 1e-9);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
