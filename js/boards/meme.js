// ============================================================================
// 板块②:Meme 异动监测
//   目标:在"暴涨前或刚开始"阶段发现异动——链上成交量异常放大 + 动量刚启动
//        + 池龄新 + 有社交热度。貔貅/rug 默认筛除(有买无卖/异常涨幅/合约危险)。
// ============================================================================
import { Meme } from "../meme.js?v=20260823";
import {
  h, fmtPctPointSigned, fmtUsdCompact, fmtPrice, fmtAge, timeAgo,
  chainBadge, stageBadge, safetyBadge, volGauge, symAvatar, downloadFile, toCsv, toast,
  skeletonHero, skeletonRows,
} from "../ui.js?v=20260823";

const { NETWORKS, NETWORK_NAMES } = Meme;

export function createMemeBoard(ctx) {
  let host = null;
  let tokens = [];
  let status = {};
  let fetchedAt = null;
  let loading = false;
  let securityPending = false; // 合约安全检测进行中(GoPlus 第二帧尚未回来)
  let fromCache = false; // 当前展示的是 localStorage 快照(等首帧实时数据)

  let search = "";
  let chainFilter = "all";
  let stageFilter = "all"; // all | 吸筹 | 启动 | 已拉升 | 活跃 | 平稳
  let sort = { key: "score", dir: -1 };

  const S = () => ctx.settings;

  // 回到本板块时,数据年龄超过此值才后台静默刷新(否则直接复用,秒回不闪)
  const REMOUNT_STALE_MS = 45_000;

  // 持久快照:页面重载后冷启动先用它秒回,实时数据回来再替换(仅缓存榜前 N 个,控制体积)
  const CACHE_KEY = "memeBoardCacheV1";
  const CACHE_MAX_AGE_MS = 30 * 60_000;
  const CACHE_TOP_N = 120;
  function saveCache() {
    try {
      const slim = tokens.slice(0, CACHE_TOP_N).map((t) => ({ ...t, riskPending: undefined, _secChecked: undefined }));
      localStorage.setItem(CACHE_KEY, JSON.stringify({ tokens: slim, fetchedAt }));
    } catch (e) { /* 超配额/隐私模式忽略 */ }
  }
  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || !Array.isArray(c.tokens) || !c.tokens.length) return null;
      if (Date.now() - Date.parse(c.fetchedAt || 0) > CACHE_MAX_AGE_MS) return null;
      return c;
    } catch (e) { return null; }
  }

  async function load(force = false) {
    if (loading) return;
    loading = true;
    ctx.setRefreshStatus("loading");
    try {
      const res = await Meme.fetchMeme({
        force,
        // 秒回第一帧:合约检测前先上板(安全徽章=检测中/未检,绝不标安全)
        onQuick: (q) => {
          tokens = q.tokens || [];
          status = q.status || {};
          securityPending = !!q.securityPending;
          fromCache = false;
          fetchedAt = q.fetchedAt || new Date().toISOString();
          ctx.setLastUpdated(fetchedAt);
          renderAll();
        },
      });
      tokens = res.tokens || [];
      status = res.status || {};
      securityPending = false;
      fromCache = false;
      fetchedAt = res.fetchedAt || new Date().toISOString();
      ctx.setLastUpdated(fetchedAt);
      ctx.setRefreshStatus(tokens.length ? "ok" : "error");
      if (tokens.length) saveCache();
      if (tokens.length) {
        const early = tokens.filter((t) => !t.filtered && ["吸筹", "启动"].includes(t.stage.label));
        if (early.length) toast(`Meme 监测:${early.length} 个早期异动(吸筹/启动)`, "success", 2600);
      }
    } catch (e) {
      console.error("meme load failed", e);
      ctx.setRefreshStatus("error");
      toast(`Meme 数据加载失败:${e.message}`, "error");
    } finally {
      loading = false; // 先复位再渲染,否则 0 早期异动时 hero 会一直停在"正在扫描…"
      renderAll();
    }
  }

  // ── 筛选 ─────────────────────────────────────────────────────────
  function visibleTokens() {
    const s = S();
    return tokens.filter((t) => {
      if (s.memeHideRug && t.filtered) return false;
      if (s.memeOnlyEarly && !["吸筹", "启动"].includes(t.stage.label)) return false;
      if (chainFilter !== "all" && t.chain !== chainFilter) return false;
      if (stageFilter !== "all" && t.stage.label !== stageFilter) return false;
      if (search && !(t.symbol || "").toUpperCase().includes(search.toUpperCase())) return false;
      return true;
    });
  }

  function sortedTokens(rows) {
    const { key, dir } = sort;
    return [...rows].sort((a, b) => {
      let va, vb;
      switch (key) {
        case "symbol": va = a.symbol; vb = b.symbol; break;
        case "score": va = a.score; vb = b.score; break;
        case "volSpike": va = a.volSpike; vb = b.volSpike; break;
        case "h1": va = a.chg.h1; vb = b.chg.h1; break;
        case "h24": va = a.chg.h24; vb = b.chg.h24; break;
        case "vol1h": va = a.vol.h1; vb = b.vol.h1; break;
        case "liq": va = a.liquidityUsd; vb = b.liquidityUsd; break;
        case "age": va = a.ageMinutes ?? 1e12; vb = b.ageMinutes ?? 1e12; break;
        default: va = a.score; vb = b.score;
      }
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  }

  // ── 骨架 ─────────────────────────────────────────────────────────
  function mount(hostEl) {
    host = hostEl;
    host.className = "board";
    host.innerHTML = "";
    host.appendChild(h("div.board-head",
      h("h2", { text: "🔥 Meme 异动监测" }),
      h("p", { text: "监控 Solana / Base / BSC / Ethereum 链上 DEX 池,寻找暴涨前或初期的异动:成交量异常放大 + 动量刚启动 + 池龄新 + 社交热度。貔貅/rug(有买无卖、异常涨幅、合约危险)默认筛除。" })));
    heroEl = h("div", { id: "memeHero" });
    statsEl = h("div", { id: "memeStats" });
    host.appendChild(heroEl);
    host.appendChild(statsEl);
    host.appendChild(buildControls());
    panelEl = h("div", { id: "memePanel" });
    host.appendChild(panelEl);
    // 秒回三级:① 会话内已有数据→直接渲染不闪骨架;② 页面重载冷启→localStorage 快照秒回;
    //   ③ 真·首次→骨架+强刷。快照/会话数据太旧都再后台静默刷新。
    if (tokens.length) {
      renderAll();
      const age = Date.now() - Date.parse(fetchedAt || 0);
      if (age > REMOUNT_STALE_MS) load(false);
      return;
    }
    const snap = readCache();
    if (snap) {
      tokens = snap.tokens;
      fetchedAt = snap.fetchedAt;
      fromCache = true;
      renderAll();
      load(true); // 快照只是开胃菜,立刻拉实时替换
      return;
    }
    heroEl.appendChild(skeletonHero());
    panelEl.appendChild(skeletonRows());
    load(true);
  }

  let heroEl, statsEl, panelEl;

  function buildControls() {
    const chip = (id, label) => h("button", {
      class: `subtab ${stageFilter === id ? "active" : ""}`, dataset: { stage: id },
      onclick: () => { stageFilter = id; renderAll(); },
    }, label);
    const chainSel = h("select", { onchange: (e) => { chainFilter = e.target.value; renderPanel(); } },
      h("option", { value: "all", text: "全部链" }),
      NETWORKS.map((n) => h("option", { value: n, text: NETWORK_NAMES[n] || n, selected: chainFilter === n ? "" : null })));
    return h("div.controls",
      h("div.subtabs",
        chip("all", "全部"),
        chip("吸筹", "🟣 吸筹"),
        chip("启动", "🟢 启动"),
        chip("已拉升", "🟠 已拉升"),
        chip("活跃", "🟡 活跃")),
      h("div.filter-row",
        h("label.search", h("span", { text: "币种" }),
          h("input", { type: "search", placeholder: "搜 symbol", value: search, oninput: (e) => { search = e.target.value; renderPanel(); } })),
        h("label.search", h("span", { text: "链" }), chainSel)),
      h("div.export-group",
        h("button", { class: "btn ghost", onclick: exportCsv }, "📄 CSV")));
  }

  // ── 渲染 ─────────────────────────────────────────────────────────
  function renderAll() {
    if (!host) return; // 板块已被切换卸载(异步加载完成后回调)
    renderHero();
    renderStats();
    renderPanel();
    host.querySelectorAll("[data-stage]").forEach((b) => b.classList.toggle("active", b.dataset.stage === stageFilter));
  }
  function renderPanel() {
    if (!panelEl) return;
    panelEl.innerHTML = "";
    panelEl.appendChild(renderTable());
  }

  function renderHero() {
    if (!heroEl) return;
    // 早期信号(吸筹/启动),未筛除,按异动分
    const early = tokens.filter((t) => !t.filtered && ["吸筹", "启动"].includes(t.stage.label))
      .sort((a, b) => b.score - a.score);
    const cards = early.slice(0, 4).map((t) => {
      const safety = safetyBadge(t);
      return h("div.hero-card",
        h("div.hero-tag", `${t.stage.label === "吸筹" ? "🟣 吸筹·量增价未动" : "🟢 启动·早期上攻"}`),
        h("div", h("span.hero-symbol", t.symbol), chainBadge(t.chain, t.chainName)),
        h("div.hero-metric",
          h("span.big", `${t.volSpike > 0 ? t.volSpike + "x" : "新"}`),
          h("span.unit", `量异常 · 1h ${fmtPctPointSigned(t.chg.h1, 1)}`)),
        h("div.hero-action", `1h量 ${fmtUsdCompact(t.vol.h1)} · 深度 ${fmtUsdCompact(t.liquidityUsd)}`),
        h("div.hero-sub", `池龄 ${fmtAge(t.ageMinutes)}${t.boosted ? " · 🔥社交热度" : ""} · `, safety));
    });
    heroEl.innerHTML = "";
    heroEl.appendChild(cards.length
      ? h("div.hero-grid", cards)
      : h("div.empty-state", h("div.ico", "🌊"), h("div", { text: loading ? "正在扫描链上池子…" : "当前无明确早期异动(吸筹/启动)。下方列表显示全部活跃池。" })));
  }

  function renderStats() {
    if (!statsEl) return;
    const shown = visibleTokens();
    const early = tokens.filter((t) => !t.filtered && ["吸筹", "启动"].includes(t.stage.label)).length;
    const filtered = tokens.filter((t) => t.filtered).length;
    const boosted = tokens.filter((t) => t.boosted).length;
    const stat = (label, val, cls = "") => h("div.stat", h("span", { text: label }), h("strong", { class: cls, text: val }));
    statsEl.innerHTML = "";
    statsEl.appendChild(h("div.stats-grid",
      stat("监控池子", String(tokens.length)),
      stat("早期异动", String(early), "pos"),
      stat("社交热度", String(boosted)),
      stat("已筛除 rug", String(filtered), "neg"),
      stat("合约检测", securityPending ? "进行中…" : "完成", securityPending ? "" : "pos"),
      stat("更新时间", (fromCache ? "快照 " : "") + (fetchedAt ? timeAgo(Date.now() - Date.parse(fetchedAt)) : "--"), fromCache ? "" : undefined)));
  }

  function sortBtn(key, label) {
    const cls = sort.key === key ? (sort.dir === 1 ? "asc" : "desc") : "";
    return h("button", { class: `sort-btn ${cls}`, onclick: () => { sort.key === key ? (sort.dir *= -1) : (sort.key = key, sort.dir = -1); renderPanel(); } },
      label, h("span.sort-indicator"));
  }

  function renderTable() {
    const s = S();
    const rows = sortedTokens(visibleTokens());
    const shown = rows.slice(0, 300);
    const filteredCount = tokens.filter((t) => t.filtered).length;
    return h("section.panel",
      h("div.panel-head",
        h("h2", { text: "链上异动榜" }),
        h("p", { text: `按异动分排序(量异常为主,动量/买压/池龄/热度为辅)。显示 ${shown.length}/${rows.length}${s.memeHideRug && filteredCount ? ` · 已筛除 ${filteredCount} 个疑似 rug(可在设置关闭)` : ""}。` })),
      h("div.table-wrap",
        h("table",
          h("thead", h("tr",
            h("th", { text: "#" }),
            h("th", { text: "安全" }),
            h("th", sortBtn("symbol", "币种")),
            h("th", { text: "链 / 阶段" }),
            h("th", sortBtn("score", "异动分")),
            h("th", sortBtn("volSpike", "量异常")),
            h("th", sortBtn("h1", "1h 涨跌")),
            h("th", sortBtn("h24", "24h")),
            h("th", sortBtn("vol1h", "1h 量")),
            h("th", sortBtn("liq", "深度")),
            h("th", sortBtn("age", "池龄")),
            h("th", { text: "链接" }))),
          h("tbody", shown.length ? shown.map((t, i) => memeRow(t, i)) : [emptyRow(12)]))));
  }

  function memeRow(t, i) {
    const riskTitle = [(t.riskReasons || []).join("、"), (t.rugFlags || []).join("、")].filter(Boolean).join(";");
    return h("tr", { class: t.filtered ? "row-filtered" : "", style: t.filtered ? "opacity:0.55" : "" },
      h("td", h("span", { class: "num muted", text: String(i + 1) })),
      h("td", { title: riskTitle }, safetyBadge(t), t.shallow ? h("span.risk-reasons", { text: "浅盘" }) : null,
        t.riskReasons && t.riskReasons.length ? h("span.risk-reasons", { text: t.riskReasons[0] }) : null,
        t.rugFlags && t.rugFlags.length ? h("span.risk-reasons", { text: t.rugFlags[0] }) : null),
      h("td", h("div.sym-cell", symAvatar(t.symbol),
        h("div", h("span.sym-name", t.symbol), h("span.sym-sub", { text: (t.name || "").slice(0, 22) })))),
      h("td", h("div", { style: "display:flex;flex-direction:column;gap:4px" }, chainBadge(t.chain, t.chainName), stageBadge(t.stage))),
      h("td", h("span", { class: "num", style: "color:var(--accent);font-weight:800", text: String(t.score) })),
      h("td", volGauge(t.volSpike)),
      h("td", h("span", { class: `num ${t.chg.h1 >= 0 ? "rate-pos" : "rate-neg"}`, text: fmtPctPointSigned(t.chg.h1, 1) })),
      h("td", h("span", { class: `num ${t.chg.h24 >= 0 ? "rate-pos" : "rate-neg"}`, text: fmtPctPointSigned(t.chg.h24, 1) })),
      h("td", h("span", { class: "num muted", text: fmtUsdCompact(t.vol.h1) })),
      h("td", h("span", { class: "num muted", text: fmtUsdCompact(t.liquidityUsd) })),
      h("td", h("span", { class: "num muted", text: fmtAge(t.ageMinutes) }), t.boosted ? h("span.boost-fire", { text: " 🔥", title: "DexScreener 社交热度" }) : null),
      h("td", t.url ? h("a", { class: "link-ext", href: t.url, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation() }, "↗") : null));
  }

  function emptyRow(cols) {
    const msg = loading ? "扫描中…" : (S().memeOnlyEarly ? "当前无早期异动;可在设置关闭「仅看早期」" : "无数据");
    return h("tr", h("td", { colspan: String(cols) }, h("div.empty-state", h("div.ico", "🔍"), h("div", { text: msg }))));
  }

  function exportCsv() {
    const rows = [["rank", "symbol", "chain", "stage", "risk", "score", "volSpike", "chgH1", "chgH24", "volH1", "liquidity", "ageMin", "boosted", "address", "url"]];
    sortedTokens(visibleTokens()).forEach((t, i) => rows.push([
      i + 1, t.symbol, t.chainName, t.stage.label, t.risk, t.score, t.volSpike,
      t.chg.h1, t.chg.h24, Math.round(t.vol.h1), Math.round(t.liquidityUsd),
      t.ageMinutes != null ? Math.round(t.ageMinutes) : "", t.boosted ? "yes" : "", t.address, t.url,
    ]));
    downloadFile(`meme-anomaly-${Date.now()}.csv`, "﻿" + toCsv(rows), "text/csv");
    toast("已导出 CSV", "success");
  }

  return {
    id: "meme",
    nav: { icon: "🔥", title: "Meme 异动", sub: "早期发现" },
    mount,
    refresh: (force) => load(force !== false),
    applySettings: () => renderAll(),
    unmount: () => { host = null; heroEl = null; statsEl = null; panelEl = null; },
    isLoading: () => loading,
    hasData: () => tokens.length > 0,
    getFetchedAt: () => fetchedAt,
  };
}
