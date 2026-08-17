// ============================================================================
// 板块④:期权 Wall(UI)
//   数据源:Deribit 公开期权 API。
//   展示:按行权价的 Call(绿)/Put(红)持仓墙、Max Pain 最大痛点、PCR、25Δ Skew、大押注区。
// ============================================================================
import { Options } from "../options.js?v=20260817c";
import {
  h, fmtUsdCompact, fmtPrice, timeAgo, toast, skeletonHero, skeletonRows,
} from "../ui.js?v=20260817c";

export function createOptionsBoard(ctx) {
  let host = null;
  let results = [];
  let errors = {};
  let fetchedAt = null;
  let loading = false;
  let activeCoin = "BTC";

  let heroEl, statsEl, panelEl, tabsEl;

  async function load(force = false) {
    if (loading) return;
    loading = true;
    ctx.setRefreshStatus("loading");
    try {
      const res = await Options.fetchOptions({});
      results = res.results || [];
      errors = res.errors || {};
      fetchedAt = res.fetchedAt || new Date().toISOString();
      if (results.length && !results.some((r) => r.coin === activeCoin)) activeCoin = results[0].coin;
      ctx.setLastUpdated(fetchedAt);
      ctx.setRefreshStatus(results.length ? "ok" : "error");
    } catch (e) {
      console.error("options load failed", e);
      ctx.setRefreshStatus("error");
      toast(`期权数据加载失败:${e.message}`, "error");
    } finally {
      loading = false; // 先复位再渲染,空态/加载态文案才不会停在"加载中"
      renderAll();
    }
  }

  const active = () => results.find((r) => r.coin === activeCoin) || results[0] || null;

  function mount(hostEl) {
    host = hostEl;
    host.className = "board";
    host.innerHTML = "";
    host.appendChild(h("div.board-head",
      h("h2", { text: "🧱 期权 Wall" }),
      h("p", { text: "BTC/ETH 期权持仓分布:按行权价的 Call(绿)/Put(红)持仓墙、Max Pain 最大痛点、PCR 多空比、25Δ Skew 波动率偏度、大押注区。数据源自动择优:Deribit(持仓最深,本地可用)优先,公网边缘被其限流时回退 OKX 期权。" })));
    tabsEl = h("div", { id: "optTabs" });
    heroEl = h("div", { id: "optHero" });
    statsEl = h("div", { id: "optStats" });
    panelEl = h("div", { id: "optPanel" });
    host.appendChild(tabsEl);
    host.appendChild(heroEl);
    host.appendChild(statsEl);
    host.appendChild(panelEl);
    heroEl.appendChild(skeletonHero());
    panelEl.appendChild(skeletonRows());
    load(true);
  }

  function renderAll() {
    if (!host) return;
    renderTabs();
    renderHero();
    renderStats();
    renderPanel();
  }

  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.innerHTML = "";
    tabsEl.appendChild(h("div.subtabs",
      Options.COINS.map((c) => h("button", {
        class: `subtab ${activeCoin === c.id ? "active" : ""}`,
        onclick: () => { activeCoin = c.id; renderAll(); },
      }, `${c.emoji} ${c.id}`))));
  }

  const skewLabel = (skew) => {
    if (skew == null) return "--";
    if (skew.skew > 3) return `${skew.skew.toFixed(1)}% (恐慌·买 Put 保护)`;
    if (skew.skew < -3) return `${skew.skew.toFixed(1)}% (贪婪·追 Call)`;
    return `${skew.skew.toFixed(1)}% (中性)`;
  };

  function renderHero() {
    if (!heroEl) return;
    const d = active();
    heroEl.innerHTML = "";
    if (!d) {
      heroEl.appendChild(h("div.empty-state", h("div.ico", "🧱"), h("div", { text: loading ? "正在拉取期权持仓…" : "暂无数据" })));
      return;
    }
    const mp = d.nearestMaxPain;
    const card = (tag, cls, metric, unit, sub) => h("div.hero-card",
      h("div.hero-tag", { class: cls, text: tag }),
      h("div", h("span.hero-symbol", { text: `${d.emoji} ${d.coin}` })),
      h("div.hero-metric", h("span.big", { text: metric }), h("span.unit", { text: unit })),
      h("div.hero-sub", { text: sub }));
    heroEl.appendChild(h("div.hero-grid", [
      card("💰 现货指数", "", `$${fmtPrice(d.spotPrice)}`, "", `${d.optionCount} 张活跃期权 · ${d.expiryCount} 个到期日`),
      mp ? card("🎯 近月 Max Pain", mp.deviation >= 0 ? "pos" : "neg", `$${fmtPrice(mp.maxPainStrike)}`,
          `${mp.deviation >= 0 ? "+" : ""}${mp.deviation.toFixed(1)}%`, `${mp.dateStr} 到期 · ${mp.daysTo} 天 · OI ${fmtUsdCompact(mp.totalOiUsd)}`)
        : card("🎯 近月 Max Pain", "", "--", "", "无数据"),
      card("⚖️ PCR(Put/Call)", d.pcr.pcr > 1.1 ? "neg" : d.pcr.pcr < 0.9 ? "pos" : "",
          d.pcr.pcr.toFixed(2), d.pcr.pcr > 1.1 ? "偏空" : d.pcr.pcr < 0.9 ? "偏多" : "均衡",
          `Call OI ${fmtUsdCompact(d.pcr.callOiUsd)} · Put OI ${fmtUsdCompact(d.pcr.putOiUsd)}`),
      card("📊 25Δ Skew", d.skew && d.skew.skew > 3 ? "neg" : d.skew && d.skew.skew < -3 ? "pos" : "",
          d.skew ? d.skew.skew.toFixed(1) + "%" : "--", "风险逆转", skewLabel(d.skew)),
    ]));
  }

  function renderStats() {
    if (!statsEl) return;
    const d = active();
    statsEl.innerHTML = "";
    if (!d) return;
    const stat = (label, val, cls = "") => h("div.stat", h("span", { text: label }), h("strong", { class: cls, text: val }));
    statsEl.appendChild(h("div.stats-grid",
      stat("数据源", d.source === "deribit" ? "Deribit" : "OKX(公网兜底)", d.source === "deribit" ? "pos" : ""),
      stat("总持仓 OI", fmtUsdCompact(d.totalOiUsd)),
      stat("Call 持仓", fmtUsdCompact(d.pcr.callOiUsd), "pos"),
      stat("Put 持仓", fmtUsdCompact(d.pcr.putOiUsd), "neg"),
      stat("PCR", d.pcr.pcr.toFixed(2)),
      stat("活跃合约", String(d.optionCount)),
      stat("到期日", String(d.expiryCount)),
      stat("更新时间", fetchedAt ? timeAgo(Date.now() - Date.parse(fetchedAt)) : "--")));
  }

  // ── 持仓墙:按行权价 Call(绿,上)/Put(红,下)─────────────────────────
  function renderWall(d) {
    const spot = d.spotPrice;
    if (!spot || !d.strikeDist.length) return h("div.empty-state", h("div", { text: "无持仓分布" }));
    // 聚焦现货 ±40%,取 OI 最大的 ~42 个行权价
    const near = d.strikeDist.filter((s) => s.strike >= spot * 0.6 && s.strike <= spot * 1.4 && (s.callOi > 0 || s.putOi > 0));
    const top = [...near].sort((a, b) => (b.callOi + b.putOi) - (a.callOi + a.putOi)).slice(0, 42)
      .sort((a, b) => a.strike - b.strike);
    if (!top.length) return h("div.empty-state", h("div", { text: "现货附近无持仓" }));
    const maxOi = Math.max(...top.map((s) => Math.max(s.callOi, s.putOi)), 1);
    const minS = top[0].strike;
    const maxS = top[top.length - 1].strike;
    const spotPct = ((spot - minS) / (maxS - minS)) * 100;
    const mp = d.nearestMaxPain;
    const mpPct = mp && mp.maxPainStrike >= minS && mp.maxPainStrike <= maxS ? ((mp.maxPainStrike - minS) / (maxS - minS)) * 100 : null;

    const cols = top.map((s) => {
      const callH = (s.callOi / maxOi) * 100;
      const putH = (s.putOi / maxOi) * 100;
      const title = `行权价 $${fmtPrice(s.strike)}\nCall OI ${fmtUsdCompact(s.callOiUsd)} (${s.callOi.toFixed(1)})\nPut OI ${fmtUsdCompact(s.putOiUsd)} (${s.putOi.toFixed(1)})`;
      return h("div.wall-col", { title },
        h("div.wall-half.up", h("div.wall-bar.call", { style: `height:${callH}%` })),
        h("div.wall-half.down", h("div.wall-bar.put", { style: `height:${putH}%` })));
    });

    return h("div.wall",
      h("div.heatmap-legend",
        h("span.legend-item", h("span.swatch", { style: "background:rgba(68,208,123,0.9)" }), "Call 持仓(上方·看涨)"),
        h("span.legend-item", h("span.swatch", { style: "background:rgba(255,107,98,0.9)" }), "Put 持仓(下方·看跌/保护)"),
        mpPct != null ? h("span.legend-item.dim", `🎯 Max Pain $${fmtPrice(mp.maxPainStrike)}`) : null,
        h("span.legend-item.dim", `现货 $${fmtPrice(spot)}`)),
      h("div.wall-stage",
        h("div.wall-cols", cols),
        h("div.wall-baseline"),
        mpPct != null ? h("div.wall-marker.mp", { style: `left:${mpPct}%`, title: `Max Pain $${fmtPrice(mp.maxPainStrike)}` }, h("span.wall-marker-tag.mp", "MP")) : null,
        h("div.wall-marker.spot", { style: `left:${spotPct}%`, title: `现货 $${fmtPrice(spot)}` }, h("span.wall-marker-tag.spot", "现货"))),
      h("div.heatmap-axis",
        h("span", { text: `$${fmtPrice(minS)}` }),
        h("span.axis-mid", { text: "行权价 →" }),
        h("span", { text: `$${fmtPrice(maxS)}` })));
  }

  // ── Max Pain 各到期日 ─────────────────────────────────────────────
  function renderMaxPainTable(d) {
    if (!d.maxPainByExpiry.length) return h("div.empty-state", h("div", { text: "无 Max Pain 数据" }));
    return h("div.table-wrap",
      h("table",
        h("thead", h("tr",
          h("th", { text: "到期日" }), h("th", { text: "剩余" }),
          h("th", { text: "Max Pain" }), h("th", { text: "距现货" }),
          h("th", { text: "持仓 OI" }), h("th", { text: "引力" }))),
        h("tbody", d.maxPainByExpiry.map((mp) => {
          const dev = mp.deviation;
          const pull = Math.abs(dev) < 2 ? "弱" : Math.abs(dev) < 5 ? "中" : "强";
          return h("tr",
            h("td", h("span.num", { text: mp.dateStr })),
            h("td", h("span.num.muted", { text: `${mp.daysTo} 天` })),
            h("td", h("span.num", { text: `$${fmtPrice(mp.maxPainStrike)}` })),
            h("td", h("span", { class: `num ${dev >= 0 ? "rate-pos" : "rate-neg"}`, text: `${dev >= 0 ? "+" : ""}${dev.toFixed(1)}%` })),
            h("td", h("span.num.muted", { text: fmtUsdCompact(mp.totalOiUsd) })),
            h("td", h("span", { class: `badge ${pull === "强" ? "conf-high" : pull === "中" ? "conf-mid" : ""}`, text: pull })));
        }))));
  }

  // ── 大押注区(持仓最集中的行权价)─────────────────────────────────
  function renderConcentrations(d) {
    if (!d.concentrations.length) return h("div.empty-state", h("div", { text: "无数据" }));
    const maxOi = Math.max(...d.concentrations.map((c) => c.totalOiCoin), 1);
    return h("div.zone-list", d.concentrations.map((c) => {
      const w = (c.totalOiCoin / maxOi) * 100;
      const isCall = c.type === "call";
      return h("div.zone-item",
        h("div.zone-price", `$${fmtPrice(c.strike)}`),
        h("div.zone-dist", { class: isCall ? "pos" : "neg", text: isCall ? "Call" : "Put" }),
        h("div.zone-bar-wrap", h("div.zone-bar", { class: isCall ? "pos" : "neg", style: `width:${w}%` })),
        h("div.zone-meta", `${fmtUsdCompact(c.totalOiUsd)} · ${c.pctOfTotal.toFixed(1)}%`));
    }));
  }

  function renderPanel() {
    if (!panelEl) return;
    const d = active();
    panelEl.innerHTML = "";
    if (!d) {
      panelEl.appendChild(h("div.empty-state", h("div.ico", "🧱"), h("div", { text: loading ? "正在拉取…" : "加载失败" })));
      return;
    }
    panelEl.appendChild(h("section.panel",
      h("div.panel-head", h("h2", { text: `${d.emoji} ${d.coin} 期权持仓墙` }),
        h("p", { text: "每列 = 一个行权价,绿(上)=Call 持仓,红(下)=Put 持仓。柱越高 = 该价位持仓越集中,越可能形成支撑/压力。" })),
      renderWall(d)));
    panelEl.appendChild(h("div.zone-grid",
      h("section.panel",
        h("div.panel-head", h("h2.zone-title", { text: "🎯 Max Pain 最大痛点(各到期日)" }),
          h("p", { text: "使全体买方内在价值损失最大的结算价。临近到期,价格有向 Max Pain 收敛的倾向。" })),
        renderMaxPainTable(d)),
      h("section.panel",
        h("div.panel-head", h("h2.zone-title", { text: "🐋 大押注区(持仓最集中行权价)" }),
          h("p", { text: "全市场 OI 最大的行权价,代表大户/机构的主要押注与防守位。" })),
        renderConcentrations(d))));
  }

  return {
    id: "options",
    nav: { icon: "🧱", title: "期权 Wall", sub: "最大痛点/持仓墙" },
    mount,
    refresh: (force) => load(force !== false),
    applySettings: () => renderAll(),
    unmount: () => { host = null; heroEl = null; statsEl = null; panelEl = null; tabsEl = null; },
    isLoading: () => loading,
    hasData: () => results.length > 0,
    getFetchedAt: () => fetchedAt,
  };
}
