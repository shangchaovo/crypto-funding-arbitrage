// ============================================================================
// 板块③:主力清算热图(UI)
//   热力条 = 各价格区间的估算清算密度(红=上方空头清算区,绿=下方多头清算区)。
//   标注当前价、清算密集区(墙)、多空拥挤方向、主力收割方向。
//   ⚠️ 公开 OI/K线/订单簿估算,非 CoinGlass 逐价格点真实清算数据。
// ============================================================================
import { Liquidation } from "../liquidation.js?v=20260823";
import {
  h, fmtPctSigned, fmtUsd, fmtUsdCompact, fmtPrice, timeAgo, toast, skeletonHero, skeletonRows,
} from "../ui.js?v=20260823";

export function createLiquidationBoard(ctx) {
  let host = null;
  let results = [];
  let errors = {};
  let fetchedAt = null;
  let loading = false;
  let activeSymbol = "BTC";

  let heroEl, statsEl, panelEl, tabsEl;

  // 回到本板块时,数据年龄超过此值才后台静默刷新(清算拉取较重,阈值放宽避免频繁打 OKX)
  const REMOUNT_STALE_MS = 90_000;

  async function load(force = false) {
    if (loading) return;
    loading = true;
    ctx.setRefreshStatus("loading");
    try {
      const res = await Liquidation.fetchLiquidation({
        onPartial: ({ results: pr, errors: pe }) => {
          // 渐进渲染:BTC 先出,ETH/SOL 随后合并。
          results = pr;
          errors = pe;
          if (results.length && !results.some((r) => r.symbol === activeSymbol)) activeSymbol = results[0].symbol;
          ctx.setLastUpdated(new Date().toISOString());
          renderAll();
        },
      });
      results = res.results || [];
      errors = res.errors || {};
      fetchedAt = res.fetchedAt || new Date().toISOString();
      if (results.length && !results.some((r) => r.symbol === activeSymbol)) activeSymbol = results[0].symbol;
      ctx.setLastUpdated(fetchedAt);
      ctx.setRefreshStatus(results.length ? "ok" : "error");
      if (!results.length) toast("清算数据暂不可用(OKX 限流),稍后刷新", "error");
    } catch (e) {
      console.error("liquidation load failed", e);
      ctx.setRefreshStatus("error");
      toast(`清算数据加载失败:${e.message}`, "error");
    } finally {
      loading = false; // 先复位再渲染(onPartial 渐进渲染仍保持 loading=true)
      renderAll();
    }
  }

  const active = () => results.find((r) => r.symbol === activeSymbol) || results[0] || null;

  // ── 骨架 ─────────────────────────────────────────────────────────
  function mount(hostEl) {
    host = hostEl;
    host.className = "board";
    host.innerHTML = "";
    host.appendChild(h("div.board-head",
      h("h2", { text: "📉 主力清算热图" }),
      h("p", { text: "基于 OKX 永续的持仓量(OI)+ 杠杆层(5/10/25/50/100x)+ K线入场分布 + 多空比 + 订单簿,建模估算各价格区间的清算密集区。红色=上方空头清算区(价格涨→空头被爆),绿色=下方多头清算区(价格跌→多头被爆)。" })));
    tabsEl = h("div", { id: "liqTabs" });
    heroEl = h("div", { id: "liqHero" });
    statsEl = h("div", { id: "liqStats" });
    panelEl = h("div", { id: "liqPanel" });
    host.appendChild(tabsEl);
    host.appendChild(heroEl);
    host.appendChild(statsEl);
    host.appendChild(panelEl);
    host.appendChild(h("p.disclaimer", { text: "⚠️ 本图为公开行情/OI/订单簿推导的概率密度估算,用于识别流动性密集区,非 CoinGlass 逐价格点真实清算数据,不构成投资建议。" }));
    // 秒回:会话内已有数据→直接渲染不闪骨架;太旧才后台静默刷新,冷载才骨架+强刷
    if (results.length) {
      renderAll();
      const age = Date.now() - Date.parse(fetchedAt || 0);
      if (age > REMOUNT_STALE_MS) load(false);
    } else {
      heroEl.appendChild(skeletonHero());
      panelEl.appendChild(skeletonRows());
      load(true);
    }
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
      Liquidation.SYMBOLS.map((s) => h("button", {
        class: `subtab ${activeSymbol === s.id ? "active" : ""}`,
        onclick: () => { activeSymbol = s.id; renderAll(); },
      }, `${s.emoji} ${s.id}`))));
  }

  // ── Hero:主力方向 + 最近墙 ───────────────────────────────────────
  function renderHero() {
    if (!heroEl) return;
    const d = active();
    heroEl.innerHTML = "";
    if (!d) {
      heroEl.appendChild(h("div.empty-state", h("div.ico", "📉"), h("div", { text: loading ? "正在建模清算密度…" : "暂无数据" })));
      return;
    }
    const nearestUp = [...d.upperZones].sort((a, b) => a.distancePct - b.distancePct)[0];
    const nearestDown = [...d.lowerZones].sort((a, b) => a.distancePct - b.distancePct)[0];
    const card = (tag, cls, symbol, metric, unit, sub) => h("div.hero-card",
      h("div.hero-tag", { class: cls, text: tag }),
      h("div", h("span.hero-symbol", { text: symbol })),
      h("div.hero-metric", h("span.big", { text: metric }), h("span.unit", { text: unit })),
      h("div.hero-sub", { text: sub }));

    heroEl.appendChild(h("div.hero-grid", [
      card("🐋 主力收割方向", d.riskDir === "UP" ? "neg" : d.riskDir === "DOWN" ? "pos" : "",
        `${d.emoji} ${d.symbol}`,
        d.riskDir === "UP" ? "↑ 上方" : d.riskDir === "DOWN" ? "↓ 下方" : "→ 均衡",
        d.riskLabel,
        `上/下方清算规模比 ${fmtUsdCompact(d.upperLiquidity)} vs ${fmtUsdCompact(d.lowerLiquidity)}`),
      nearestUp
        ? card("🔴 最近空头墙(上方)", "neg", `${d.emoji} ${d.symbol}`,
            `$${fmtPrice(nearestUp.price)}`, `+${nearestUp.distancePct.toFixed(2)}%`,
            `爆仓规模 ${fmtUsdCompact(nearestUp.concentrationScore)} · 置信 ${(nearestUp.confidence * 100).toFixed(0)}%`)
        : card("🔴 最近空头墙(上方)", "neg", `${d.emoji} ${d.symbol}`, "--", "", "无明显密集区"),
      nearestDown
        ? card("🟢 最近多头墙(下方)", "pos", `${d.emoji} ${d.symbol}`,
            `$${fmtPrice(nearestDown.price)}`, `-${nearestDown.distancePct.toFixed(2)}%`,
            `爆仓规模 ${fmtUsdCompact(nearestDown.concentrationScore)} · 置信 ${(nearestDown.confidence * 100).toFixed(0)}%`)
        : card("🟢 最近多头墙(下方)", "pos", `${d.emoji} ${d.symbol}`, "--", "", "无明显密集区"),
      card("⚖️ 账户多空", d.crowdedSide === "LONG" ? "pos" : d.crowdedSide === "SHORT" ? "neg" : "",
        `${d.emoji} ${d.symbol}`,
        `${(d.longRatio * 100).toFixed(0)}%`, `多 / ${((1 - d.longRatio) * 100).toFixed(0)}% 空`,
        d.crowdedLabel),
    ]));
  }

  function renderStats() {
    if (!statsEl) return;
    const d = active();
    statsEl.innerHTML = "";
    if (!d) return;
    const m = d.metrics;
    const stat = (label, val, cls = "") => h("div.stat", h("span", { text: label }), h("strong", { class: cls, text: val }));
    statsEl.appendChild(h("div.stats-grid",
      stat("标记价格", `$${fmtPrice(m.currentPrice)}`),
      stat("24h 涨跌", fmtPctSigned(m.priceChange24h / 100, 2), m.priceChange24h >= 0 ? "pos" : "neg"),
      stat("持仓量 OI", fmtUsdCompact(m.oiValueUsd)),
      stat("资金费率(年化)", `${(m.fundingRate * 100).toFixed(4)}% (${m.fundingAnnualized.toFixed(0)}%)`, m.fundingRate >= 0 ? "pos" : "neg"),
      stat("1h 波动率", `${(d.volatility * 100).toFixed(2)}%`),
      stat("模型置信度", `${(d.confidence * 100).toFixed(0)}%`),
      stat("K线样本", `${d.klineCount} 根`),
      stat("更新时间", fetchedAt ? timeAgo(Date.now() - Date.parse(fetchedAt)) : "--")));
  }

  // ── 热力图 ───────────────────────────────────────────────────────
  function renderHeatmap(d) {
    const bins = d.density || [];
    if (!bins.length) return h("div.empty-state", h("div", { text: "无密度数据" }));
    const cur = d.metrics.currentPrice;
    const minP = bins[0].priceLow;
    const maxP = bins[bins.length - 1].priceHigh;
    const curPct = ((cur - minP) / (maxP - minP)) * 100;
    const loPct = ((minP - cur) / cur) * 100;
    const hiPct = ((maxP - cur) / cur) * 100;

    const cols = bins.map((b) => {
      const shortDominant = b.shortLiqScore >= b.longLiqScore;
      const op = 0.12 + b.intensity * 0.88;
      // 浅色主题:空=红、多=绿,与全站语义色一致(原为青/红)
      const color = shortDominant ? `rgba(225, 77, 67, ${op})` : `rgba(22, 163, 74, ${op})`;
      const height = Math.max(2, b.intensity * 100);
      const sideTxt = b.side === "upper" ? "上方(空头清算)" : "下方(多头清算)";
      const title = `$${fmtPrice(b.price)} · ${sideTxt}\n密度强度 ${(b.intensity * 100).toFixed(0)}%\n多爆 ${fmtUsdCompact(b.longLiqScore)} / 空爆 ${fmtUsdCompact(b.shortLiqScore)}\n距现价 ${b.side === "upper" ? "+" : "-"}${b.distancePct.toFixed(2)}%`;
      return h("div.hm-col", { title },
        h("div.hm-bar", { style: `height:${height}%;background:${color}` }));
    });

    return h("div.heatmap",
      h("div.heatmap-legend",
        h("span.legend-item", h("span.swatch", { style: "background:rgba(225, 77, 67, 0.9)" }), "空头清算区(上方·价格涨→空爆)"),
        h("span.legend-item", h("span.swatch", { style: "background:rgba(22, 163, 74, 0.9)" }), "多头清算区(下方·价格跌→多爆)"),
        h("span.legend-item.dim", `现价 $${fmtPrice(cur)}`)),
      h("div.hm-stage",
        h("div.hm-cols", cols),
        h("div.hm-marker", { style: `left:${curPct}%` }, h("span.hm-marker-line"), h("span.hm-marker-tag", { text: `$${fmtPrice(cur)}` }))),
      h("div.heatmap-axis",
        h("span", { text: `$${fmtPrice(minP)} (${loPct.toFixed(0)}%)` }),
        h("span.axis-mid", { text: "估算清算密度 →" }),
        h("span", { text: `$${fmtPrice(maxP)} (+${hiPct.toFixed(0)}%)` })));
  }

  // ── 墙列表(上/下方清算密集区)────────────────────────────────────
  function zoneList(zones, sign, colorCls) {
    if (!zones.length) return h("div.empty-state", h("div", { text: "无明显密集区" }));
    const maxScore = Math.max(...zones.map((z) => z.concentrationScore));
    return h("div.zone-list", zones.map((z) => {
      const w = maxScore ? (z.concentrationScore / maxScore) * 100 : 0;
      return h("div.zone-item",
        h("div.zone-price", `$${fmtPrice(z.price)}`),
        h("div.zone-dist", { class: colorCls, text: `${sign}${z.distancePct.toFixed(2)}%` }),
        h("div.zone-bar-wrap", h("div.zone-bar", { class: colorCls, style: `width:${w}%` })),
        h("div.zone-meta", `${fmtUsdCompact(z.concentrationScore)} · ${(z.confidence * 100).toFixed(0)}%`));
    }));
  }

  function renderPanel() {
    if (!panelEl) return;
    const d = active();
    panelEl.innerHTML = "";
    if (!d) {
      panelEl.appendChild(h("div.empty-state", h("div.ico", "📉"), h("div", { text: loading ? "正在建模…" : "加载失败" })));
      return;
    }
    panelEl.appendChild(h("section.panel",
      h("div.panel-head", h("h2", { text: `${d.emoji} ${d.symbol} 清算密度热图` }),
        h("p", { text: `每列 = 一个价格区间的相对清算强度(0-100%)。柱越高/越亮 = 该区间爆仓越密集,价格触及时越容易被"收割"。` })),
      renderHeatmap(d)));
    panelEl.appendChild(h("div.zone-grid",
      h("section.panel",
        h("div.panel-head", h("h2.zone-title.neg", { text: "🔴 上方清算墙(空头密集区)" }),
          h("p", { text: "价格上行至此,空头被强制平仓,可能助推冲高(轧空)。" })),
        zoneList([...d.upperZones].sort((a, b) => a.distancePct - b.distancePct), "+", "neg")),
      h("section.panel",
        h("div.panel-head", h("h2.zone-title.pos", { text: "🟢 下方清算墙(多头密集区)" }),
          h("p", { text: "价格下行至此,多头被强制平仓,可能加速下探(杀多)。" })),
        zoneList([...d.lowerZones].sort((a, b) => a.distancePct - b.distancePct), "-", "pos"))));
  }

  return {
    id: "liquidation",
    nav: { icon: "📉", title: "主力清算热图", sub: "清算密集区" },
    mount,
    refresh: (force) => load(force !== false),
    applySettings: () => renderAll(),
    unmount: () => { host = null; heroEl = null; statsEl = null; panelEl = null; tabsEl = null; },
    isLoading: () => loading,
    hasData: () => results.length > 0,
    getFetchedAt: () => fetchedAt,
  };
}
