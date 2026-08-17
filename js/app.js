// ============================================================================
// 加密终端 · 应用外壳
//   板块路由(hash)+ 设置 + 刷新编排 + 结算倒计时 + 历史图 Modal + 盈亏模拟。
//   板块即插即用:在 BOARDS 注册一个 create 工厂即可。
// ============================================================================
import { FundingAPI } from "./api.js?v=20260817e";
import { Countdown } from "./countdown.js?v=20260817e";
import { HistoryDB } from "./history.js?v=20260817e";
import { h, fmtClock, timeAgo, toast } from "./ui.js?v=20260817e";
import { createFundingBoard } from "./boards/funding.js?v=20260817e";
import { createMemeBoard } from "./boards/meme.js?v=20260817e";
import { createLiquidationBoard } from "./boards/liquidation.js?v=20260817e";
import { createOptionsBoard } from "./boards/options.js?v=20260817e";

// ── 设置 ─────────────────────────────────────────────────────────────
const SETTINGS_KEY = "cryptoTerminalSettings";
const DEFAULT_SETTINGS = {
  minSpread: 0.0001,
  minApr: 0,
  hideLowConfidence: false,
  onlyAccessible: true,
  evalPosition: 10000,
  memeHideRug: true,
  memeOnlyEarly: false,
  notifyEnabled: false,
  notifyApr: 30,
  simPosition: 10000,
  simRate: 0.10,
  simHold: 72,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
}

// ── 全局状态 ─────────────────────────────────────────────────────────
const state = {
  settings: loadSettings(),
  board: null, // 当前板块 id
  boards: {}, // id -> instance
  autoTimer: null,
};

// ── 板块注册 ─────────────────────────────────────────────────────────
const BOARD_DEFS = [
  { id: "funding", create: createFundingBoard, autoMs: 5 * 60_000, nav: { icon: "💰", title: "资金费率套利", sub: "现货+跨所" } },
  { id: "meme", create: createMemeBoard, autoMs: 60_000, nav: { icon: "🔥", title: "Meme 异动", sub: "早期发现" } },
  { id: "liquidation", create: createLiquidationBoard, autoMs: 3 * 60_000, nav: { icon: "📉", title: "主力清算热图", sub: "清算密集区" } },
  { id: "options", create: createOptionsBoard, autoMs: 5 * 60_000, nav: { icon: "🧱", title: "期权 Wall", sub: "最大痛点/持仓墙" } },
];

// ── ctx:板块与外壳的桥梁 ─────────────────────────────────────────────
const ctx = {
  get settings() { return state.settings; },
  setRefreshStatus,
  setLastUpdated,
  setExchangeStatus,
  openChart,
  renderChart,
};

// ── 路由 ─────────────────────────────────────────────────────────────
function currentBoardId() {
  const m = location.hash.match(/^#\/([a-z]+)/);
  const id = m && m[1];
  return BOARD_DEFS.some((b) => b.id === id) ? id : "funding";
}

function renderNav() {
  const nav = document.getElementById("boardNav");
  nav.innerHTML = "";
  BOARD_DEFS.forEach((def) => {
    const inst = state.boards[def.id];
    const nv = def.nav || (inst && inst.nav) || {};
    nav.appendChild(h("button", {
      class: `board-tab ${state.board === def.id ? "active" : ""}`,
      role: "tab", "aria-selected": state.board === def.id ? "true" : "false",
      onclick: () => { location.hash = `#/${def.id}`; },
    },
      h("span.tab-ico", { text: nv.icon || "▦" }),
      h("span", { text: nv.title || def.id }),
      nv.sub ? h("span.tab-sub", { text: nv.sub }) : null));
  });
}

function switchBoard(id) {
  if (state.board === id && state.boards[id]) return;
  // 卸载旧板块
  if (state.board && state.boards[state.board]) state.boards[state.board].unmount();
  const hostEl = document.getElementById("boardHost");
  hostEl.innerHTML = "";

  const def = BOARD_DEFS.find((b) => b.id === id);
  if (!state.boards[id]) state.boards[id] = def.create(ctx);
  const inst = state.boards[id];
  if (!inst.nav) inst.nav = def.nav;

  state.board = id;
  renderNav();
  inst.mount(hostEl);
  scheduleAutoRefresh();
  updateRefreshButton();
}

// ── 刷新编排 ─────────────────────────────────────────────────────────
function refreshActive(force = true) {
  const inst = state.boards[state.board];
  if (!inst) return;
  updateRefreshButton(true);
  Promise.resolve(inst.refresh(force)).finally(() => updateRefreshButton(false));
}

function scheduleAutoRefresh() {
  if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
  const def = BOARD_DEFS.find((b) => b.id === state.board);
  if (!def || !def.autoMs) return;
  state.autoTimer = setInterval(() => {
    if (document.hidden) return; // 页面不可见时暂停
    const inst = state.boards[state.board];
    if (inst && !inst.isLoading()) inst.refresh(true);
  }, def.autoMs);
}

function updateRefreshButton(loading) {
  const btn = document.getElementById("refreshBtn");
  const inst = state.boards[state.board];
  const isLoading = loading !== undefined ? loading : (inst && inst.isLoading());
  btn.classList.toggle("loading", !!isLoading);
  btn.textContent = isLoading ? "加载中…" : "刷新";
}

// ── 顶部状态 ─────────────────────────────────────────────────────────
let lastUpdatedIso = null;
function setLastUpdated(iso) {
  lastUpdatedIso = iso;
  document.getElementById("lastUpdated").textContent = fmtClock(iso);
  updateRefreshAge();
}
function updateRefreshAge() {
  const ageEl = document.querySelector("#refreshStatus .status-age");
  if (ageEl && lastUpdatedIso) ageEl.textContent = timeAgo(Date.now() - Date.parse(lastUpdatedIso));
}

function setRefreshStatus(status) {
  const el = document.getElementById("refreshStatus");
  const dot = el.querySelector(".status-dot");
  const text = el.querySelector(".status-text");
  el.classList.remove("ok", "stale", "error");
  if (status === "ok") { el.classList.add("ok"); text.textContent = "正常"; }
  else if (status === "loading") { text.textContent = "加载中"; }
  else if (status === "stale") { el.classList.add("stale"); text.textContent = "陈旧"; }
  else { el.classList.add("error"); text.textContent = "异常"; }
  updateRefreshAge();
}

// ── 页脚数据源状态 ───────────────────────────────────────────────────
function setExchangeStatus(exchangeStatus = {}, spotStatus = {}) {
  const host = document.getElementById("exchangeStatus");
  host.innerHTML = "";
  const { EXCHANGE_ORDER, EXCHANGE_NAMES, REGION_BLOCKED } = FundingAPI;
  EXCHANGE_ORDER.forEach((id) => {
    const st = exchangeStatus[id] || {};
    const blocked = REGION_BLOCKED && REGION_BLOCKED.has(id);
    const statusKey = blocked ? "region-blocked" : (st.status || "error");
    const pillCls = statusKey === "ok" ? "ok" : statusKey === "region-blocked" ? "region-blocked" : (statusKey === "fallback" || statusKey === "stale") ? "stale" : "error";
    const label = blocked ? "地区限制" : statusKey === "ok" ? "实时" : statusKey === "fallback" ? "缓存" : "异常";
    host.appendChild(h("span", { class: `status-pill ${pillCls}`, title: st.error || "" },
      h("span.status-dot"),
      h("span.pill-label", { text: EXCHANGE_NAMES[id] || id }),
      h("span.pill-info", { text: label })));
  });
}

// ── 历史图 Modal ─────────────────────────────────────────────────────
let chartSymbol = null;
function openChart(symbol, title) {
  chartSymbol = symbol;
  document.getElementById("chartTitle").textContent = title || `📈 ${symbol}`;
  document.getElementById("chartBody").innerHTML = '<div class="loading-state"><span class="spin"></span><div>加载历史…</div></div>';
  document.getElementById("chartLegend").innerHTML = "";
  document.getElementById("chartOverlay").classList.add("open");
  document.getElementById("chartModal").classList.add("open");
}
function renderChart(symbol, history) {
  if (symbol !== chartSymbol) return;
  const body = document.getElementById("chartBody");
  const legend = document.getElementById("chartLegend");
  if (!history || !history.length) {
    body.innerHTML = '<div class="empty-state"><div class="ico">📊</div><div>暂无历史数据(随刷新累积,24h 后出图)</div></div>';
    legend.innerHTML = "";
    return;
  }
  HistoryDB.renderHistoryChart(symbol, history, body);
  // 图例
  const { EXCHANGE_NAMES } = FundingAPI;
  const seen = new Set();
  history.forEach((snap) => Object.keys(snap.exchanges || {}).forEach((ex) => seen.add(ex)));
  legend.innerHTML = "";
  const colors = HistoryDB.CHART_COLORS || {};
  Array.from(seen).slice(0, 8).forEach((ex) => {
    legend.appendChild(h("span.lg",
      h("span.swatch", { style: `background:${colors[ex] || "#5cb8ff"}` }),
      h("span", { text: EXCHANGE_NAMES[ex] || ex })));
  });
}
function closeChart() {
  document.getElementById("chartOverlay").classList.remove("open");
  document.getElementById("chartModal").classList.remove("open");
  chartSymbol = null;
}

// ── 设置面板 ─────────────────────────────────────────────────────────
function openSettings() {
  syncSettingsInputs();
  document.getElementById("settingsOverlay").classList.add("open");
  document.getElementById("settingsPanel").classList.add("open");
}
function closeSettings() {
  document.getElementById("settingsOverlay").classList.remove("open");
  document.getElementById("settingsPanel").classList.remove("open");
}
function syncSettingsInputs() {
  const s = state.settings;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
  set("minSpreadInput", s.minSpread);
  set("minAprInput", s.minApr);
  setChk("hideLowConfidence", s.hideLowConfidence);
  setChk("onlyAccessible", s.onlyAccessible);
  set("evalPositionInput", s.evalPosition);
  setChk("memeHideRug", s.memeHideRug);
  setChk("memeOnlyEarly", s.memeOnlyEarly);
  setChk("notifyToggle", s.notifyEnabled);
  set("notifyAprInput", s.notifyApr);
  set("simPosition", s.simPosition);
  set("simRate", s.simRate);
  set("simHold", s.simHold);
  updateSimulator();
}
function readSettingsInputs() {
  const s = state.settings;
  const num = (id, d) => { const el = document.getElementById(id); const v = el ? Number(el.value) : NaN; return Number.isFinite(v) ? v : d; };
  const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
  s.minSpread = num("minSpreadInput", s.minSpread);
  s.minApr = num("minAprInput", s.minApr);
  s.hideLowConfidence = chk("hideLowConfidence");
  s.onlyAccessible = chk("onlyAccessible");
  s.evalPosition = num("evalPositionInput", s.evalPosition);
  s.memeHideRug = chk("memeHideRug");
  s.memeOnlyEarly = chk("memeOnlyEarly");
  s.notifyEnabled = chk("notifyToggle");
  s.notifyApr = num("notifyAprInput", s.notifyApr);
  s.simPosition = num("simPosition", s.simPosition);
  s.simRate = num("simRate", s.simRate);
  s.simHold = num("simHold", s.simHold);
}
function applySettings() {
  readSettingsInputs();
  saveSettings();
  const inst = state.boards[state.board];
  if (inst && inst.applySettings) inst.applySettings();
  toast("设置已保存", "success", 1800);
}

// ── 盈亏模拟(现货-永续 delta 中性)────────────────────────────────────
function updateSimulator() {
  const s = state.settings;
  const num = (id, d) => { const el = document.getElementById(id); const v = el ? Number(el.value) : NaN; return Number.isFinite(v) ? v : d; };
  const position = num("simPosition", s.simPosition);
  const ratePct = num("simRate", s.simRate); // 每 8h %
  const holdH = Math.max(8, num("simHold", s.simHold));
  const rate8h = ratePct / 100;
  const income8h = position * rate8h; // 每 8h 资金费(仅永续腿)
  // 手续费:现货开+平 + 永续开+平 ≈ 各 0.1% × 2 腿 × 2 次 = 0.4% 名义(一次性)
  const feeRate = 0.001; // 单边 0.1%
  const totalFee = position * feeRate * 4;
  const settlements = holdH / 8; // 持仓期内结算次数
  const grossIncome = income8h * settlements;
  const netIncome = grossIncome - totalFee;
  const netApr = position > 0 ? (netIncome / position) * (8760 / holdH) : 0;
  document.getElementById("sim8h").textContent = `$${income8h.toFixed(2)}`;
  document.getElementById("simApr").textContent = `${(netApr * 100).toFixed(1)}%`;
  document.getElementById("simFee").textContent = `$${totalFee.toFixed(2)}`;
}

// ── 键盘快捷键 ───────────────────────────────────────────────────────
function bindShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    switch (e.key.toLowerCase()) {
      case "r": refreshActive(true); break;
      case "1": location.hash = "#/funding"; break;
      case "2": location.hash = "#/meme"; break;
      case "3": location.hash = "#/liquidation"; break;
      case "4": location.hash = "#/options"; break;
      case "escape": closeChart(); closeSettings(); break;
      default:
        if (e.shiftKey && e.key.toLowerCase() === "s") openSettings();
    }
  });
}

// ── 事件绑定 ─────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById("refreshBtn").addEventListener("click", () => refreshActive(true));
  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  document.getElementById("closeSettings").addEventListener("click", closeSettings);
  document.getElementById("settingsOverlay").addEventListener("click", closeSettings);
  document.getElementById("closeChart").addEventListener("click", closeChart);
  document.getElementById("chartOverlay").addEventListener("click", closeChart);
  document.getElementById("saveSettings").addEventListener("click", () => { applySettings(); closeSettings(); });
  document.getElementById("resetSettings").addEventListener("click", () => {
    state.settings = { ...DEFAULT_SETTINGS };
    saveSettings(); syncSettingsInputs(); applySettings();
  });
  ["simPosition", "simRate", "simHold"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", updateSimulator);
  });
  window.addEventListener("hashchange", () => switchBoard(currentBoardId()));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) updateRefreshAge(); });
  // 每 10s 更新"数据年龄"
  setInterval(updateRefreshAge, 10_000);
}

// ── 启动 ─────────────────────────────────────────────────────────────
function init() {
  Countdown.startCountdown(document.getElementById("countdown"));
  bindEvents();
  bindShortcuts();
  switchBoard(currentBoardId());
}

init();
