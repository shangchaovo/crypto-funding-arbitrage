// ============================================================================
// 共享 UI 助手:DOM 构建 / 格式化 / 徽章 / Toast。所有板块复用。
// ============================================================================

// 轻量 DOM 构建:h('div.sym-cell', {attrs}, children...)
// 第二个参数若其实是子节点(数组 / DOM 节点 / 字符串 / 数字),自动归入 children。
export function h(tag, attrs = {}, ...children) {
  const [tagName, ...classes] = tag.split(".");
  const el = document.createElement(tagName || "div");
  if (classes.length) el.className = classes.join(" ");
  // 第二参数为子节点的情况: h('div', [children]) / h('div', node) / h('div', 'text')
  const isNode = typeof Node !== "undefined" && attrs instanceof Node;
  if (attrs != null && (Array.isArray(attrs) || isNode || typeof attrs === "string" || typeof attrs === "number")) {
    children.unshift(attrs);
    attrs = {};
  }
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v == null) return;
    if (k === "class") el.className = (el.className ? el.className + " " : "") + v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v);
  });
  children.flat(Infinity).forEach((c) => {
    if (c == null || c === false) return;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  });
  return el;
}

// ── 格式化 ────────────────────────────────────────────────────────────
export function fmtPct(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  let fixed = (n * 100).toFixed(digits);
  if (digits === 4 && (fixed === "0.0000" || fixed === "-0.0000") && n !== 0) fixed = (n * 100).toFixed(5);
  return `${fixed}%`;
}

export function fmtPctSigned(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  const s = fmtPct(n, digits);
  return n > 0 && !s.startsWith("--") ? `+${s}` : s;
}

export function fmtApr(value) { return fmtPct(value, 2); }

// 已是百分数的值(meme 涨跌幅,如 -47.88 即 -47.88%):直接加 %,不再 ×100。
// (费率是分数 0.0013=0.13% 用 fmtPct;链上 chg 是百分点,用这个)
export function fmtPctPoint(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${n.toFixed(digits)}%`;
}
export function fmtPctPointSigned(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function fmtUsd(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// 紧凑美金:1.2K / 3.4M / 5.6B
export function fmtUsdCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "$0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(abs < 1 ? 4 : 0)}`;
}

export function fmtPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toExponential(2);
}

// 币龄:7m / 3.2h / 5.1d
export function fmtAge(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return "?";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

export function timeAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "刚刚";
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 前`;
  const hh = Math.floor(m / 60);
  return `${hh}h 前`;
}

export function fmtClock(isoOrMs) {
  const d = new Date(isoOrMs);
  if (isNaN(d)) return "--";
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

// ── Toast ────────────────────────────────────────────────────────────
export function toast(message, type = "info", duration = 3600) {
  const host = document.getElementById("toastHost");
  if (!host) return;
  const el = h("div", { class: `toast ${type}`, text: message });
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(() => el.remove(), 320);
  }, duration);
}

// ── 徽章构建 ─────────────────────────────────────────────────────────
export function confBadge(confidence) {
  const high = confidence === "high";
  return h("span", { class: `badge conf-badge ${high ? "high" : "low"}`, title: high ? "数据新鲜" : "数据陈旧/伪套利,谨慎" },
    high ? "● 实时" : "◐ 陈旧");
}

export function chainBadge(chain, chainName) {
  return h("span", { class: `badge chain-badge chain-${chain}`, text: chainName || chain });
}

const STAGE_CLASS = { 吸筹: "stage-accumulate", 启动: "stage-launching", 已拉升: "stage-pumped", 活跃: "stage-active", 平稳: "stage-flat" };
export function stageBadge(stage) {
  if (!stage) return null;
  return h("span", { class: `badge stage-badge ${STAGE_CLASS[stage.label] || "stage-flat"}`, text: stage.label });
}

export function safetyBadge(token) {
  const map = {
    safe: ["safety-safe", "✅ 安全"],
    caution: ["safety-caution", "⚠️ 注意"],
    danger: ["safety-danger", "🚫 危险"],
    flagged: ["safety-flagged", "🚫 风险"],
    unknown: ["safety-unknown", "· 未检"],
  };
  const [cls, label] = map[token.risk] || map.unknown;
  const reasons = (token.riskReasons || []).concat(token.rugFlags || []);
  const el = h("span", { class: `badge safety-badge ${cls}`, text: label });
  if (reasons.length) el.title = reasons.join("、");
  return el;
}

// 量异常放大仪表
export function volGauge(spike) {
  const v = Number(spike) || 0;
  const widthPct = Math.min(100, (v / 10) * 100); // 10x 封顶
  const hot = v >= 5;
  return h("span", { class: "gauge", title: `1h 成交量相对 24h 均值放大 ${v}x` },
    h("span", { class: "gauge-track" }, h("span", { class: `gauge-fill ${hot ? "hot" : ""}`, style: `width:${widthPct}%` })),
    h("span", { class: "gauge-val", text: v > 0 ? `${v}x` : "—" }));
}

// 动量条(正负)
export function momentumBar(pct) {
  const v = Number(pct) || 0;
  const widthPct = Math.min(100, Math.abs(v));
  const neg = v < 0;
  return h("span", { class: "meter", title: `1h 涨跌 ${v}%` },
    h("span", { class: "meter-track" }, h("span", { class: `meter-fill ${neg ? "neg" : ""}`, style: `width:${widthPct}%` })),
    h("span", { class: `num ${neg ? "rate-neg" : "rate-pos"}`, text: `${neg ? "" : "+"}${v}%` }));
}

// 币种头像(首字符占位)
export function symAvatar(symbol) {
  const ch = (symbol || "?").replace(/^1000/, "").charAt(0).toUpperCase() || "?";
  return h("span", { class: "sym-avatar", text: ch });
}

// ── 导出 ─────────────────────────────────────────────────────────────
export function downloadFile(filename, content, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

export function toCsv(rows) {
  return rows.map((r) => r.map((c) => {
    const s = c == null ? "" : String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
}

// ── 骨架屏:板块首载占位(load 完成后 renderAll 会覆盖,不会闪到后台刷新)─────
export function skeletonHero(cards = 4) {
  const g = h("div.sk-hero");
  for (let i = 0; i < cards; i++) g.appendChild(h("div.sk.sk-card"));
  return g;
}

export function skeletonRows(rows = 9) {
  const wrap = h("div.sk-rows");
  wrap.appendChild(h("div.sk.sk-line.sk-head"));
  for (let i = 0; i < rows; i++) wrap.appendChild(h("div.sk.sk-line", { style: `width:${92 - ((i * 7) % 30)}%` }));
  return wrap;
}

export const UI = {
  h, fmtPct, fmtPctSigned, fmtApr, fmtUsd, fmtUsdCompact, fmtPrice, fmtAge,
  fmtPctPoint, fmtPctPointSigned,
  timeAgo, fmtClock, toast, confBadge, chainBadge, stageBadge, safetyBadge,
  volGauge, momentumBar, symAvatar, downloadFile, toCsv, skeletonHero, skeletonRows,
};
