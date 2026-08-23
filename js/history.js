import { FundingAPI } from './api.js';

const DB_NAME = "fundingHistory";
  const DB_VERSION = 1;
  const STORE_NAME = "snapshots";
  const RETENTION_MS = 26 * 60 * 60 * 1000; // 优化: 按时间保留(略大于 24h，使“24h”图表弹窗名副其实)；旧实现按 500 条记录≈仅 1h
  const HARD_CAP = 6000; // 优化: 安全上限，防止异常高频写入时无限增长

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
          store.createIndex("symbol", "symbol", { multiEntry: false });
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
      };
    });
    return dbPromise;
  }

  async function saveSnapshot(timestamp, rates) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);

      // Group rates by symbol and store one record per symbol per snapshot
      const bySymbol = {};
      (rates || []).forEach((rate) => {
        if (!rate || !rate.symbol || !rate.exchange) return;
        if (!bySymbol[rate.symbol]) bySymbol[rate.symbol] = {};
        bySymbol[rate.symbol][rate.exchange] = {
          rate8h: rate.rate8h ?? rate.fundingRate * (8 / (rate.intervalHours || 8)),
          fundingRate: rate.fundingRate,
          markPrice: rate.markPrice,
        };
      });

      Object.entries(bySymbol).forEach(([symbol, exchanges]) => {
        store.put({
          timestamp,
          symbol,
          exchanges,
          savedAt: Date.now(),
        });
      });

      // Trim old records
      await trimOldSnapshots(store);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn("Failed to save snapshot", e);
    }
  }

  async function trimOldSnapshots(store) {
    // 优化: 改为按时间裁剪（删除早于 now-RETENTION_MS 的记录），并用同一事务的 timestamp 索引游标；
    // 旧实现按主键顺序删到 500 条，既把保留期压到≈1h，又可能在某些币种序列里留洞。
    return new Promise((resolve) => {
      const cutoff = Date.now() - RETENTION_MS;
      let deleted = 0;
      let range;
      try {
        range = IDBKeyRange.upperBound(cutoff, true); // < cutoff
      } catch (e) {
        resolve();
        return;
      }
      const cursorReq = store.index("timestamp").openCursor(range);
      cursorReq.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) {
          trimHardCap(store).then(resolve, () => resolve()); // 时间裁剪后再做一次硬上限兜底
          return;
        }
        if (deleted >= HARD_CAP) { resolve(); return; } // 单次事务删除上限，防卡
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      cursorReq.onerror = () => resolve();
    });
  }

  // 优化: 硬上限兜底——若记录数仍超 HARD_CAP，按 timestamp 升序删最旧的
  function trimHardCap(store) {
    return new Promise((resolve, reject) => {
      const countReq = store.count();
      countReq.onsuccess = () => {
        const count = countReq.result;
        if (count <= HARD_CAP) { resolve(); return; }
        let toDelete = count - HARD_CAP;
        const cursorReq = store.index("timestamp").openCursor();
        cursorReq.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor || toDelete <= 0) { resolve(); return; }
          cursor.delete();
          toDelete--;
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      };
      countReq.onerror = () => reject(countReq.error);
    });
  }

  async function getSymbolHistory(symbol, hours = 24) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const index = store.index("symbol");
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      const results = [];

      return new Promise((resolve, reject) => {
        const range = IDBKeyRange.only(symbol);
        const request = index.openCursor(range);
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) {
            resolve(results);
            return;
          }
          const record = cursor.value;
          if (record.timestamp >= cutoff) {
            results.push(record);
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    } catch (e) {
      console.warn("Failed to get history", e);
      return [];
    }
  }

  /* ── SVG Chart Renderer ── */
  /* 浅色主题可读配色:全部加深到白底可辨,同时保留各所品牌辨识度 */
  const CHART_COLORS = {
    binance: "#d9a400",
    okx: "#1f2937", // 白底上用深石板灰(原近白 #e6edf3 是为暗底设计的)
    bybit: "#e08800",
    gate: "#0aa37e",
    mexc: "#3b82f6",
    bitget: "#0891b2",
    hyperliquid: "#0c8a93",
    dydx: "#7c5cd6",
  };

  function renderHistoryChart(symbol, history, container) {
    if (!history || history.length < 2) {
      container.innerHTML = '<p class="muted" style="text-align:center;padding:40px;">历史数据不足，请等待更多数据刷新。</p>';
      return;
    }

    // Sort by timestamp
    history.sort((a, b) => a.timestamp - b.timestamp);

    // Build series per exchange
    const exchanges = new Set();
    history.forEach((h) => Object.keys(h.exchanges).forEach((ex) => exchanges.add(ex)));
    const exchangeList = Array.from(exchanges).sort();

    const width = 760;
    const height = 320;
    const pad = { top: 20, right: 20, bottom: 40, left: 60 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    // Find min/max across all series
    let globalMin = Infinity;
    let globalMax = -Infinity;
    exchangeList.forEach((ex) => {
      history.forEach((h) => {
        const val = h.exchanges[ex]?.rate8h;
        if (Number.isFinite(val)) {
          globalMin = Math.min(globalMin, val);
          globalMax = Math.max(globalMax, val);
        }
      });
    });

    if (!Number.isFinite(globalMin)) {
      container.innerHTML = '<p class="muted" style="text-align:center;padding:40px;">无有效历史数据。</p>';
      return;
    }

    const range = globalMax - globalMin || 0.0001;
    const yScale = (val) => pad.top + plotH - ((val - globalMin) / range) * plotH;
    const xScale = (idx) => pad.left + (idx / (history.length - 1)) * plotW;

    // Build paths
    const paths = exchangeList.map((ex) => {
      const points = [];
      history.forEach((h, i) => {
        const val = h.exchanges[ex]?.rate8h;
        if (Number.isFinite(val)) {
          points.push(`${xScale(i).toFixed(1)},${yScale(val).toFixed(1)}`);
        }
      });
      if (points.length < 2) return null;
      return {
        exchange: ex,
        d: `M ${points.join(" L ")}`,
        color: CHART_COLORS[ex] || "#888",
      };
    }).filter(Boolean);

    // Y-axis ticks
    const yTicks = [];
    for (let i = 0; i <= 5; i++) {
      const val = globalMin + (range * i) / 5;
      const y = yScale(val);
      yTicks.push({
        y,
        label: `${(val * 100).toFixed(4)}%`,
        line: `M ${pad.left},${y.toFixed(1)} L ${width - pad.right},${y.toFixed(1)}`,
      });
    }

    // X-axis ticks (show ~6 time labels)
    const xTicks = [];
    const tickCount = Math.min(6, history.length);
    for (let i = 0; i < tickCount; i++) {
      const idx = Math.round((i / (tickCount - 1)) * (history.length - 1));
      const x = xScale(idx);
      const date = new Date(history[idx].timestamp);
      xTicks.push({
        x,
        label: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
      });
    }

    const svgParts = [
      `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-height:${height}px;">`,
      // Grid lines
      ...yTicks.map((t) => `<path d="${t.line}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="4,4" opacity="0.5"/>`),
      // Data paths
      ...paths.map((p) => `<path d="${p.d}" stroke="${p.color}" stroke-width="2" fill="none"/>`),
      // Axes
      `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="var(--muted)" stroke-width="0.5"/>`,
      `<line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="var(--muted)" stroke-width="0.5"/>`,
      // Y labels
      ...yTicks.map((t) => `<text x="${pad.left - 8}" y="${t.y + 4}" text-anchor="end" fill="var(--muted)" font-size="10" font-family="var(--mono)">${t.label}</text>`),
      // X labels
      ...xTicks.map((t) => `<text x="${t.x}" y="${height - pad.bottom + 16}" text-anchor="middle" fill="var(--muted)" font-size="10" font-family="var(--mono)">${t.label}</text>`),
      // Zero line if in range
    ];

    if (globalMin <= 0 && globalMax >= 0) {
      const zeroY = yScale(0);
      svgParts.push(`<line x1="${pad.left}" y1="${zeroY.toFixed(1)}" x2="${width - pad.right}" y2="${zeroY.toFixed(1)}" stroke="var(--text)" stroke-width="0.5" opacity="0.3" stroke-dasharray="6,3"/>`);
    }

    svgParts.push("</svg>");

    container.innerHTML = svgParts.join("\n");

    // Build legend
    const legend = document.getElementById("chartLegend");
    if (legend) {
      legend.innerHTML = paths
        .map((p) => `<span><span class="dot" style="background:${p.color}"></span>${FundingAPI?.EXCHANGE_NAMES?.[p.exchange] || p.exchange}</span>`)
        .join("");
    }
  }

export const HistoryDB = {
  saveSnapshot,
  getSymbolHistory,
  renderHistoryChart,
  CHART_COLORS,
};
