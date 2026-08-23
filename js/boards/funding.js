// ============================================================================
// 板块①:资金费率套利
//   子视图A 现货-永续(买现货 + 做空永续收资金费,delta 中性)
//   子视图B 跨所套利(低费率所做多 / 高费率所做空,赚费率差)
//   子视图C 全量费率矩阵(同一币种横向对比各所,热力着色)
// ============================================================================
import { FundingAPI } from "../api.js?v=20260823";
import { Arbitrage } from "../arbitrage.js?v=20260823";
import { HistoryDB } from "../history.js?v=20260823";
import {
  h, fmtPctSigned, fmtApr, fmtUsd, fmtUsdCompact, fmtPrice, fmtClock,
  confBadge, symAvatar, downloadFile, toCsv, toast, skeletonHero, skeletonRows,
} from "../ui.js?v=20260823";

const { EXCHANGE_ORDER, EXCHANGE_NAMES } = FundingAPI;

export function createFundingBoard(ctx) {
  // ── 内部状态 ──
  let host = null;
  let rawRates = [];
  let spots = [];
  let exchangeStatus = {};
  let spotStatus = {};
  let fetchedAt = null;
  let previousSnapshot = null;
  let loading = false;

  let subView = "spotperp"; // spotperp | cross | matrix
  let search = "";
  let exchFilter = "all";
  let sort = { spotperp: { key: "income8h", dir: -1 }, cross: { key: "spread", dir: -1 }, matrix: { key: "range", dir: -1 } };

  // 计算结果
  let spotPerpRows = [];
  let crossRows = [];
  let matrixRows = [];

  const S = () => ctx.settings;

  // 回到本板块时,数据年龄超过此值才后台静默刷新(否则直接复用,秒回不闪)
  const REMOUNT_STALE_MS = 60_000;

  // ── 数据加载(渐进式:快档费率先上板,现货/慢档随后并入)────────────────
  async function load(force = false) {
    if (loading) return;
    loading = true;
    ctx.setRefreshStatus("loading");
    previousSnapshot = Arbitrage.buildPreviousSnapshot(rawRates);

    const ingest = (rates, exchStatus, fetched) => {
      rawRates = rates || [];
      if (exchStatus) exchangeStatus = exchStatus;
      if (fetched) fetchedAt = fetched;
      recompute();
      ctx.setExchangeStatus(exchangeStatus, spotStatus);
      if (fetchedAt) ctx.setLastUpdated(fetchedAt);
      renderAll();
    };

    // 现货并行拉(不阻塞费率首屏);到位后重算基差/可买现货
    FundingAPI.fetchSpots()
      .then((sp) => {
        spots = sp.spots || [];
        spotStatus = sp.spotStatus || {};
        recompute();
        ctx.setExchangeStatus(exchangeStatus, spotStatus);
        renderAll();
      })
      .catch(() => {});

    try {
      const rp = await FundingAPI.fetchRates({
        force,
        onPartial: (p) => ingest(p.rates || [], p.exchangeStatus, p.fetchedAt),
      });
      ingest(rp.rates || [], rp.exchangeStatus, rp.fetchedAt);
      HistoryDB.saveSnapshot(Date.now(), rawRates).catch(() => {});
      ctx.setRefreshStatus(rawRates.length ? "ok" : "error");
    } catch (e) {
      console.error("funding load failed", e);
      ctx.setRefreshStatus("error");
      toast(`资金费率数据加载失败:${e.message}`, "error");
    } finally {
      loading = false;
      renderAll();
    }
  }

  function recompute() {
    const s = S();
    const evalPos = Number(s.evalPosition) || 10000;
    // 现货-永续
    spotPerpRows = Arbitrage.calculateSpotPerp(rawRates, spots, evalPos);
    // 跨所
    crossRows = Arbitrage.calculateArbitrages(rawRates, Number(s.minSpread) || Arbitrage.DEFAULT_MIN_SPREAD);
    // 全量矩阵
    matrixRows = Arbitrage.buildAllRatesRows(rawRates, previousSnapshot);
  }

  // ── 筛选 ─────────────────────────────────────────────────────────
  function matchSearch(symbol) {
    if (!search) return true;
    return symbol.toUpperCase().includes(search.toUpperCase());
  }

  function filteredSpotPerp() {
    const s = S();
    return spotPerpRows.filter((r) => {
      if (!matchSearch(r.symbol)) return false;
      if (exchFilter !== "all" && r.exchange !== exchFilter) return false;
      if (s.onlyAccessible && !(r.positive && r.spotAvailable)) return false;
      if (s.hideLowConfidence && r.confidence === "low") return false;
      if ((r.apr * 100) < (Number(s.minApr) || 0)) return false;
      return true;
    });
  }

  function filteredCross() {
    const s = S();
    return crossRows.filter((r) => {
      if (!matchSearch(r.symbol)) return false;
      if (exchFilter !== "all" && !(r.low.exchange === exchFilter || r.high.exchange === exchFilter)) return false;
      if (s.hideLowConfidence && r.confidence === "low") return false;
      if ((r.apr * 100) < (Number(s.minApr) || 0)) return false;
      return true;
    });
  }

  function filteredMatrix() {
    return matrixRows.filter((r) => {
      if (!matchSearch(r.symbol)) return false;
      if (exchFilter !== "all" && !r.byExchange[exchFilter]) return false;
      return true;
    });
  }

  // ── 排序 ─────────────────────────────────────────────────────────
  function sortRows(rows, view, getVal) {
    const { key, dir } = sort[view];
    return [...rows].sort((a, b) => {
      const va = getVal(a, key);
      const vb = getVal(b, key);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  }

  // ── 渲染骨架 ──────────────────────────────────────────────────────
  function mount(hostEl) {
    host = hostEl;
    host.className = "board";
    host.innerHTML = "";
    host.appendChild(h("div.board-head",
      h("h2", { text: "💰 资金费率套利" }),
      h("p", { text: "两种策略:① 现货-永续 —— 买现货同时做空永续,收取资金费(delta 中性,币价涨跌不亏);② 跨所套利 —— 同一币种在低费率所做多、高费率所做空,赚费率差。费率已归一为 8h 等价。" })));

    host.appendChild(buildHero());
    host.appendChild(buildStats());
    host.appendChild(buildControls());
    host.appendChild(buildPanels());
    // 秒回:会话内已有数据→直接渲染不闪骨架;太旧才后台静默刷新,冷载才骨架+强刷
    if (rawRates.length) {
      renderAll();
      const age = Date.now() - Date.parse(fetchedAt || 0);
      if (age > REMOUNT_STALE_MS) load(false);
    } else {
      heroEl.appendChild(skeletonHero());
      panelsEl.appendChild(skeletonRows());
      load(true);
    }
  }

  let heroEl, statsEl, panelsEl;
  function buildHero() {
    heroEl = h("div", { id: "fundingHero" });
    return heroEl;
  }
  function buildStats() {
    statsEl = h("div", { id: "fundingStats" });
    return statsEl;
  }
  function buildControls() {
    const sub = (id, label) => h("button", {
      class: `subtab ${subView === id ? "active" : ""}`, dataset: { sub: id },
      onclick: () => { subView = id; renderAll(); },
    }, label);
    return h("div.controls",
      h("div.subtabs",
        sub("spotperp", "💵 现货-永续"),
        sub("cross", "🔀 跨所套利"),
        sub("matrix", "▦ 全量矩阵")),
      h("div.filter-row",
        h("label.search", h("span", { text: "币种" }),
          h("input", { type: "search", placeholder: "BTC / ETH / SOL", value: search, oninput: (e) => { search = e.target.value; renderTables(); } })),
        buildExchangeFilter()),
      h("div.export-group",
        h("button", { class: "btn ghost", onclick: exportCsv, title: "导出当前视图为 CSV" }, "📄 CSV"),
        h("button", { class: "btn ghost", onclick: exportJson, title: "导出当前视图为 JSON" }, "📋 JSON")));
  }

  function buildExchangeFilter() {
    const sel = h("select", { onchange: (e) => { exchFilter = e.target.value; renderTables(); } },
      h("option", { value: "all", text: "全部交易所" }),
      EXCHANGE_ORDER.map((id) => h("option", { value: id, text: EXCHANGE_NAMES[id], selected: exchFilter === id ? "" : null })));
    return h("label.search", h("span", { text: "交易所" }), sel);
  }

  function buildPanels() {
    panelsEl = h("div", { id: "fundingPanels" });
    return panelsEl;
  }

  // ── 渲染各区块 ────────────────────────────────────────────────────
  function renderAll() {
    if (!host) return; // 板块已被切换卸载(异步加载完成后回调)
    renderHero();
    renderStats();
    renderPanels();
    // 更新子 tab active
    host.querySelectorAll(".subtab").forEach((b) => b.classList.toggle("active", b.dataset.sub === subView));
  }
  function renderTables() { renderPanels(); }

  function renderHero() {
    if (!heroEl) return;
    const accessible = spotPerpRows.filter((r) => r.positive && r.spotAvailable && r.confidence === "high")
      .sort((a, b) => b.income8h - a.income8h);
    const topCross = [...crossRows].filter((r) => r.confidence === "high").sort((a, b) => b.spread - a.spread);
    const cards = [];

    accessible.slice(0, 2).forEach((r) => {
      cards.push(h("div.hero-card",
        h("div.hero-tag", "💵 现货-永续 · 收资金费"),
        h("div", h("span.hero-symbol", r.symbol), h("span.hero-exch", EXCHANGE_NAMES[r.exchange] || r.exchange)),
        h("div.hero-metric",
          h("span.big", fmtUsd(r.income8h)),
          h("span.unit", `/8h · 年化 ${fmtApr(r.apr)}`)),
        h("div.hero-action", r.action),
        h("div.hero-sub", `费率 ${fmtPctSigned(r.rate8h)} · 基差 ${r.basis != null ? fmtPctSigned(r.basis, 3) : "--"} · 现货可买`)));
    });
    topCross.slice(0, 2).forEach((r) => {
      cards.push(h("div.hero-card",
        h("div.hero-tag", "🔀 跨所套利 · 费率差"),
        h("div", h("span.hero-symbol", r.symbol), h("span.hero-exch", `${r.exchangesCount} 所`)),
        h("div.hero-metric",
          h("span.big", fmtPctSigned(r.spread)),
          h("span.unit", `/8h · 年化 ${fmtApr(r.apr)}`)),
        h("div.hero-action", r.direction),
        h("div.hero-sub", `低 ${fmtPctSigned(r.lowRate)} @${EXCHANGE_NAMES[r.low.exchange]} · 高 ${fmtPctSigned(r.highRate)} @${EXCHANGE_NAMES[r.high.exchange]}`)));
    });

    heroEl.innerHTML = "";
    heroEl.appendChild(cards.length
      ? h("div.hero-grid", cards)
      : h("div.empty-state", h("div.ico", "⏳"), h("div", { text: loading ? "正在加载实时数据…" : "暂无可操作机会" })));
  }

  function renderStats() {
    if (!statsEl) return;
    const accessible = spotPerpRows.filter((r) => r.positive && r.spotAvailable);
    const maxCross = crossRows.length ? Math.max(...crossRows.map((r) => r.apr)) : 0;
    const maxSpot = accessible.length ? Math.max(...accessible.map((r) => r.apr)) : 0;
    const stat = (label, val, cls = "") => h("div.stat", h("span", { text: label }), h("strong", { class: cls, text: val }));
    statsEl.innerHTML = "";
    statsEl.appendChild(h("div.stats-grid",
      stat("监控币种", String(new Set(rawRates.map((r) => r.symbol)).size)),
      stat("费率数据点", String(rawRates.length)),
      stat("可操作现货套利", String(accessible.length), "pos"),
      stat("跨所机会", String(crossRows.length), "pos"),
      stat("最高年化(现货)", fmtApr(maxSpot), "pos"),
      stat("最高年化(跨所)", fmtApr(maxCross), "pos")));
  }

  function renderPanels() {
    if (!panelsEl) return;
    panelsEl.innerHTML = "";
    if (subView === "spotperp") panelsEl.appendChild(renderSpotPerpPanel());
    else if (subView === "cross") panelsEl.appendChild(renderCrossPanel());
    else panelsEl.appendChild(renderMatrixPanel());
  }

  function sortBtn(view, key, label) {
    const cur = sort[view];
    const cls = cur.key === key ? (cur.dir === 1 ? "asc" : "desc") : "";
    return h("button", { class: `sort-btn ${cls}`, onclick: () => { cur.key === key ? (cur.dir *= -1) : (cur.key = key, cur.dir = -1); renderPanels(); } },
      label, h("span.sort-indicator"));
  }

  // ── 子视图A:现货-永续 ──
  function renderSpotPerpPanel() {
    const s = S();
    const rows = sortRows(filteredSpotPerp(), "spotperp", (r, k) => {
      switch (k) {
        case "symbol": return r.symbol;
        case "rate8h": return r.rate8h;
        case "income8h": return r.income8h;
        case "apr": return r.apr;
        case "basis": return r.basis;
        case "volume24h": return r.volume24h;
        default: return r.income8h;
      }
    });
    const shown = rows.slice(0, 400);
    const panel = h("section.panel",
      h("div.panel-head",
        h("h2", { text: "现货-永续资金费套利" }),
        h("p", { text: `买现货 + 做空永续收资金费。${s.onlyAccessible ? "当前仅显示可买现货的正向机会;" : ""}共 ${rows.length} 个${rows.length > 400 ? `(显示前 400)` : ""}。` })),
      h("div.table-wrap",
        h("table",
          h("thead", h("tr",
            h("th", sortBtn("spotperp", "symbol", "币种")),
            h("th", { text: "交易所" }),
            h("th", sortBtn("spotperp", "rate8h", "8h 费率")),
            h("th", { text: "操作方向" }),
            h("th", sortBtn("spotperp", "income8h", `每8h收益·${s.evalPosition}U`)),
            h("th", sortBtn("spotperp", "apr", "年化")),
            h("th", sortBtn("spotperp", "basis", "基差")),
            h("th", sortBtn("spotperp", "volume24h", "24h量")),
            h("th", { text: "现货" }),
            h("th", { text: "置信" }))),
          h("tbody", shown.length ? shown.map(spotPerpRow) : [emptyRow(10, "无可操作的现货-永续机会")]))));
    return panel;
  }

  function spotPerpRow(r) {
    const rateCls = r.rate8h >= 0 ? "rate-pos" : "rate-neg";
    return h("tr.row-clickable", { onclick: () => openChart(r.symbol) },
      h("td", h("div.sym-cell", symAvatar(r.symbol), h("span.sym-name", r.symbol))),
      h("td", h("span", { class: "muted", text: EXCHANGE_NAMES[r.exchange] || r.exchange })),
      h("td", h("span", { class: `num ${rateCls}`, text: fmtPctSigned(r.rate8h) })),
      h("td", { style: "font-size:12px" }, r.action),
      h("td", h("span", { class: "num rate-pos", text: fmtUsd(r.income8h) })),
      h("td", h("span", { class: "num", text: fmtApr(r.apr) })),
      h("td", h("span", { class: `num ${r.basis != null && Math.abs(r.basis) > 0.02 ? "rate-neg" : ""}`, text: r.basis != null ? fmtPctSigned(r.basis, 3) : "--" })),
      h("td", h("span", { class: "num muted", text: r.volume24h ? fmtUsdCompact(r.volume24h) : "--" })),
      h("td", r.spotAvailable
        ? h("span", { class: "badge spot-badge ok", text: "可买" })
        : h("span", { class: "badge spot-badge no", text: "无现货" })),
      h("td", confBadge(r.confidence)));
  }

  // ── 子视图B:跨所套利 ──
  function renderCrossPanel() {
    const s = S();
    const rows = sortRows(filteredCross(), "cross", (r, k) => {
      switch (k) {
        case "symbol": return r.symbol;
        case "lowRate": return r.lowRate;
        case "highRate": return r.highRate;
        case "spread": return r.spread;
        case "apr": return r.apr;
        case "exchangesCount": return r.exchangesCount;
        default: return r.spread;
      }
    });
    const shown = rows.slice(0, 400);
    const panel = h("section.panel",
      h("div.panel-head",
        h("h2", { text: "跨所资金费率套利" }),
        h("p", { text: `同一币种在低费率所做多、高费率所做空,赚费率差。共 ${rows.length} 个机会${rows.length > 400 ? "(显示前 400)" : ""}。` })),
      h("div.table-wrap",
        h("table",
          h("thead", h("tr",
            h("th", sortBtn("cross", "symbol", "币种")),
            h("th", sortBtn("cross", "lowRate", "最低费率")),
            h("th", sortBtn("cross", "highRate", "最高费率")),
            h("th", sortBtn("cross", "spread", "费率差/8h")),
            h("th", sortBtn("cross", "apr", "年化")),
            h("th", { text: "建议方向" }),
            h("th", sortBtn("cross", "exchangesCount", "覆盖")),
            h("th", { text: "置信" }))),
          h("tbody", shown.length ? shown.map(crossRow) : [emptyRow(8, "暂无跨所套利机会")]))));
    return panel;
  }

  function crossRow(r) {
    return h("tr.row-clickable", { onclick: () => openChart(r.symbol) },
      h("td", h("div.sym-cell", symAvatar(r.symbol), h("span.sym-name", r.symbol))),
      h("td", h("span", { class: "num rate-neg", text: fmtPctSigned(r.lowRate) }), h("span.sym-sub", EXCHANGE_NAMES[r.low.exchange])),
      h("td", h("span", { class: "num rate-pos", text: fmtPctSigned(r.highRate) }), h("span.sym-sub", EXCHANGE_NAMES[r.high.exchange])),
      h("td", h("span", { class: "num rate-pos", text: fmtPctSigned(r.spread) })),
      h("td", h("span", { class: "num", text: fmtApr(r.apr) })),
      h("td", { style: "font-size:12px" }, r.direction),
      h("td", h("span", { class: "num muted", text: `${r.exchangesCount} 所` })),
      h("td", confBadge(r.confidence)));
  }

  // ── 子视图C:全量费率矩阵 ──
  function renderMatrixPanel() {
    const rows = sortRows(filteredMatrix(), "matrix", (r, k) => {
      if (k === "symbol") return r.symbol;
      if (k === "range") return r.range;
      const cell = r.byExchange[k];
      return cell ? cell.rate8h : null;
    });
    const shown = rows.slice(0, 500);
    // 全局 |rate| 分布,用于热力分级
    const allAbs = [];
    rows.forEach((r) => Object.values(r.byExchange).forEach((c) => { if (Number.isFinite(c.rate8h)) allAbs.push(Math.abs(c.rate8h)); }));
    allAbs.sort((a, b) => a - b);
    const q = (p) => allAbs.length ? allAbs[Math.floor(allAbs.length * p)] : 0;
    const t1 = q(0.6), t2 = q(0.85), t3 = q(0.97);

    const headCells = [h("th", sortBtn("matrix", "symbol", "币种"))].concat(
      EXCHANGE_ORDER.map((id) => h("th", sortBtn("matrix", id, EXCHANGE_NAMES[id]))),
      [h("th", sortBtn("matrix", "range", "范围"))]);

    const panel = h("section.panel",
      h("div.panel-head",
        h("h2", { text: "全量费率矩阵" }),
        h("p", { text: `同一币种横向对比 ${EXCHANGE_ORDER.length} 家交易所(8h 等价,绿正红负,颜色越深绝对值越大)。共 ${rows.length} 个币种${rows.length > 500 ? "(显示前 500)" : ""}。双击行看 24h 走势。` })),
      h("div.table-wrap",
        h("table",
          h("thead", h("tr", headCells)),
          h("tbody", shown.length ? shown.map((r) => matrixRow(r, t1, t2, t3)) : [emptyRow(EXCHANGE_ORDER.length + 2, "无数据")]))));
    return panel;
  }

  function matrixRow(r, t1, t2, t3) {
    const cells = EXCHANGE_ORDER.map((id) => {
      const c = r.byExchange[id];
      if (!c || !Number.isFinite(c.rate8h)) return h("td.heat.heat-empty", { text: "·" });
      const v = c.rate8h;
      const abs = Math.abs(v);
      const w = abs >= t3 ? "w3" : abs >= t2 ? "w2" : abs >= t1 ? "w1" : "";
      const cls = `heat ${v >= 0 ? "pos" : "neg"} ${w}`;
      return h("td", { class: cls, title: `${EXCHANGE_NAMES[id]} · 原始费率 ${fmtPctSigned(c.fundingRate)} / ${c.intervalHours}h`, dataset: { age: "" } }, fmtPctSigned(v));
    });
    return h("tr.row-clickable", { ondblclick: () => openChart(r.symbol) },
      h("td", h("div.sym-cell", symAvatar(r.symbol), h("span.sym-name", r.symbol))),
      cells,
      h("td", h("span", { class: "num muted", text: fmtPctSigned(r.range) })));
  }

  function emptyRow(cols, msg) {
    return h("tr", h("td", { colspan: String(cols) }, h("div.empty-state", h("div.ico", "∅"), h("div", { text: loading ? "加载中…" : msg }))));
  }

  // ── 导出 ─────────────────────────────────────────────────────────
  function exportCsv() {
    let rows, name;
    if (subView === "spotperp") {
      name = "spot-perp";
      rows = [["symbol", "exchange", "rate8h", "apr", "action", "income8h", "basis", "spotAvailable", "volume24h", "confidence"]];
      filteredSpotPerp().forEach((r) => rows.push([r.symbol, r.exchange, fmtPctSigned(r.rate8h), fmtApr(r.apr), r.action, r.income8h.toFixed(2), r.basis != null ? fmtPctSigned(r.basis, 3) : "", r.spotAvailable ? "yes" : "no", r.volume24h || "", r.confidence]));
    } else if (subView === "cross") {
      name = "cross-exchange";
      rows = [["symbol", "lowExchange", "lowRate", "highExchange", "highRate", "spread", "apr", "direction", "confidence"]];
      filteredCross().forEach((r) => rows.push([r.symbol, r.low.exchange, fmtPctSigned(r.lowRate), r.high.exchange, fmtPctSigned(r.highRate), fmtPctSigned(r.spread), fmtApr(r.apr), r.direction, r.confidence]));
    } else {
      name = "all-rates";
      rows = [["symbol"].concat(EXCHANGE_ORDER.map((id) => EXCHANGE_NAMES[id])).concat(["range"])];
      filteredMatrix().forEach((r) => rows.push([r.symbol].concat(EXCHANGE_ORDER.map((id) => r.byExchange[id] ? fmtPctSigned(r.byExchange[id].rate8h) : "")).concat([fmtPctSigned(r.range)])));
    }
    downloadFile(`funding-${name}-${Date.now()}.csv`, "﻿" + toCsv(rows), "text/csv");
    toast("已导出 CSV", "success");
  }

  function exportJson() {
    const payload = { view: subView, fetchedAt, spotPerp: filteredSpotPerp(), cross: filteredCross(), matrix: filteredMatrix() };
    downloadFile(`funding-${subView}-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
    toast("已导出 JSON", "success");
  }

  // ── 历史走势 ─────────────────────────────────────────────────────
  async function openChart(symbol) {
    ctx.openChart(symbol, `📈 ${symbol} · 24h 资金费率`);
    try {
      const history = await HistoryDB.getSymbolHistory(symbol, 24);
      ctx.renderChart(symbol, history);
    } catch (e) {
      ctx.renderChart(symbol, []);
    }
  }

  return {
    id: "funding",
    nav: { icon: "💰", title: "资金费率套利", sub: "现货+跨所" },
    mount,
    refresh: (force) => load(force !== false),
    applySettings: () => { recompute(); renderAll(); },
    unmount: () => { host = null; heroEl = null; statsEl = null; panelsEl = null; },
    isLoading: () => loading,
    hasData: () => rawRates.length > 0,
    getFetchedAt: () => fetchedAt,
  };
}
