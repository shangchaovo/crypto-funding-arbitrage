# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A **cryptocurrency funding rate arbitrage monitoring dashboard** — a single-page web app that tracks funding rates across 6 exchanges (Binance, OKX, Bybit, dYdX, Hyperliquid, Bitget) for 40 symbols, identifies arbitrage opportunities (long low-rate / short high-rate), and displays them in a dark-themed UI.

No build system, no framework, no package manager. Pure Vanilla JS (ES Modules) + HTML + CSS with a minimal Node.js static server.

## Running the Project

```bash
# Development
node server.js                    # Serves on PORT env var (default 8765)
PORT=8080 node server.js          # Custom port

# Production (macOS launchd — already installed on this machine)
# The plist is at launchd/com.local.funding-dashboard.plist; it runs server.js
# on PORT=8768 with NODE_ENV=production, restarting automatically on crash.
# Do not assume 8765 belongs to this project; it is currently used by another local dashboard.
./scripts/install-launchd.sh      # Copies plist to ~/Library/LaunchAgents and loads it
./scripts/uninstall-launchd.sh    # Unloads and removes the plist
launchctl kickstart -k gui/$(id -u)/com.local.funding-dashboard   # Hard restart

# View logs
 tail -f logs/server.out.log logs/server.err.log
```

The server sets `Cache-Control: no-store` on all responses for local development. Access at `http://localhost:8768`.

## Data Architecture

Three-tier data source with automatic fallback:

1. **WebSocket real-time** (`js/api.js:createRealtimeClient`) — Binance/OKX/Bybit funding rate streams. Falls back silently if connection fails.
2. **Direct REST API** (`js/api.js:fetchDirect`) — Fetches all 6 exchanges in parallel when user manually refreshes or cache is stale. Individual exchange failures don't block others.
3. **Prefetch cache** (`data/rates.json`) — GitHub Actions runs `scripts/fetch-rates.js` every 10 minutes, commits results. The frontend loads this immediately on first paint whenever it exists, then manual refresh can force direct API.

The frontend always shows **real data** — no mock/simulated fallbacks. If all sources fail, it shows an empty table with a toast error.

### Prefetch Script (`scripts/fetch-rates.js`)

A standalone Node script (no deps) that uses system `curl -L` (not Node `fetch`) to work around HTTPS/TLS certificate issues in this environment. The script reads the existing `data/rates.json` first. On failure, it **preserves** the old file rather than overwriting with empty data. When some exchanges succeed and others fail, it merges in stale rows from the previous cache for the failed exchanges (marked as `"fallback": true`). The GitHub Actions workflow (`.github/workflows/fetch-rates.yml`) runs every 10 minutes and skips commits when `git diff --quiet` shows no changes.

## Frontend Architecture

### Module Responsibilities

| File | Role | Key Exports |
|------|------|-------------|
| `js/api.js` | Exchange adapters + WebSocket client | `FundingAPI` — `fetchRates()`, `createRealtimeClient()`, `EXCHANGE_NAMES` |
| `js/arbitrage.js` | Pure calculation logic | `Arbitrage` — `calculateArbitrages()`, `buildAllRatesRows()`, `sortRows()`, `formatPercent()` |
| `js/history.js` | IndexedDB persistence + SVG charts | `HistoryDB` — `saveSnapshot()`, `getSymbolHistory()`, `renderHistoryChart()` |
| `js/countdown.js` | UTC funding settlement countdown | `Countdown` — `startCountdown(el)`, `getNextFundingSettlement()` |
| `js/app.js` | State, rendering, events, settings | Entry point — imports all modules, wires everything together |

### State & Rendering

A single `state` object in `app.js` holds all mutable state (view, filters, sort, rawRates, arbitrages, allRows, settings, etc.). There is no reactive framework — `render()` is called explicitly after state changes. `render()` delegates to `renderStats()`, `renderArbitrageTable()`, `renderAllRatesTable()`, `renderExchangeStatus()`, and `updateHash()`.

**Important pattern**: `updateRatesState(rates, source)` is the single path for ingesting new rate data. Both `refreshData()` (REST/cache) and `applyRealtimeRates()` (WebSocket) call it.

### Settings & Persistence

User settings (minSpread, minApr, notifyEnabled, notifyApr, simulator params) are stored in `localStorage` under key `fundingDashboardSettings`. The settings panel is a fixed-position drawer toggled via CSS class `open`.

The dashboard also caches the last fetched payload in `localStorage` under `fundingDashboardCache` (30-min TTL) for instant first paint.

### IndexedDB History

`history.js` stores per-symbol snapshots in IndexedDB (`fundingHistory` DB, `snapshots` store). Each refresh writes one record per symbol containing all exchange rates. Old records are trimmed when the store exceeds 500 entries. The data is used by the 24h SVG line chart shown when double-clicking any table row.

### Change Detection & Cell Flash

On every refresh, `refreshData()` saves the current `state.allRows` into `state.previousAllRows` **before** fetching new data. `updateRatesState()` then builds a `previousSnapshot` Map keyed by `symbol:exchange` containing the previous `rate8h` values. `buildAllRatesRows()` uses this snapshot to compute a `trend` field (`"up"` / `"down"` / `"flat"`) for each cell. During `renderAllRatesRow()`, each cell's current rate is looked up against `prevMap`; if the delta exceeds `0.00000001`, a `cell-flash-green` or `cell-flash-red` class is added and auto-removed after 1.5s.

### Virtual Scrolling

A lightweight `VirtualScroller` class in `app.js` handles large datasets (>50 rows) by rendering only the viewport-visible rows plus a buffer. It uses spacer `<tr>` elements to maintain scroll height. Both tables switch between full DOM rendering and virtual scrolling based on `VIRTUAL_SCROLL_THRESHOLD`. The scroller reuses `renderArbitrageRow` / `renderAllRatesRow` helpers.

### All-Rates Range Bar Visualization

The "范围" column in the all-rates table shows a `range-bar` per symbol: a gradient fill whose width reflects the symbol's range relative to the global maximum range. Overlayed on the bar are small colored dots representing each exchange's rate position within that symbol's min-max range (green = positive, red = negative). A thin vertical line marks the zero point when the range spans both positive and negative territory.

### Interactions & Shortcuts

| Gesture | Action |
|---------|--------|
| Click "复制策略" | Copy strategy text to clipboard |
| Click 📊 | Load symbol into settings-panel simulator |
| Click symbol name | Jump to that row in all-rates view |
| **Double-click** any table row | Open 24h historical rate chart modal |
| **R** | Manual refresh |
| **A** | Switch to arbitrage view |
| **S** | Focus search input |
| **Shift+S** | Open settings panel |
| **Escape** | Close modal / settings panel |

### Data Export

Toolbar buttons download the current filtered view as CSV (schema-aware per view, UTF-8 BOM for Excel) or JSON (full payload + metadata). Uses `Blob` + `URL.createObjectURL`.

## Network & CORS Proxy

`server.js` exposes `/proxy?url=<encoded-url>` which forwards requests via **`curl -L`** (not Node `fetch` or `http.request`). This is intentional: Node's built-in HTTPS client has certificate validation issues in this environment, while system `curl` works reliably. The proxy uses `config/exchanges.json` as an allowlist — only hosts listed there can be proxied.

The dashboard is developed from mainland China where exchange APIs are GFW-blocked. The three-tier data architecture (WebSocket → REST → prefetch cache) is designed to work around this: the GitHub Actions runner (outside GFW) fetches data every 10 minutes, and the frontend falls back to this cached `data/rates.json` when direct APIs are unreachable.

## Key Files to Know

- **`index.html`** — Single entry point. Two view sections (`#arbitrageView`, `#allRatesView`), settings panel drawer, chart modal. Script tags have cache-busting query params; bump the version when modifying JS/CSS.
- **`server.js`** — Minimal static file server + `/proxy` endpoint. No framework, just Node `http` module.
- **`js/app.js`** — The bulk of the application logic. Start here for any UI or behavior changes.
- **`scripts/fetch-rates.js`** — Mirror of `js/api.js` exchange adapters but for Node (uses `curl` instead of `fetch`).
- **`data/rates.json`** — Auto-updated by GitHub Actions. Do not edit manually.

## Conventions

- **ES Modules**: Each JS file exports a named object (`export const ModuleName = { ... }`). `app.js` is the entry module that imports all others via `import { ModuleName } from './file.js'`. `index.html` loads only `app.js` with `type="module"`.
- **Cache busting**: Append `?v=YYYYMMDD` to script/link URLs in `index.html` when making changes.
- **Exchange order**: `EXCHANGE_ORDER = ["binance", "okx", "bybit", "dydx", "hyperliquid", "bitget"]` is the canonical order used in table headers, status pills, and chart colors.
- **Funding rate normalization**: All rates are normalized to an 8-hour equivalent (`rate8h = fundingRate * (8 / intervalHours)`) so 1h and 8h settlements are directly comparable.
- **Error handling**: Individual exchange failures are swallowed with a warning; the UI shows partial data with a fallback indicator. Only total failure (no data at all) shows an error toast.
- **Dynamic refresh interval**: `getDynamicRefreshInterval()` adjusts polling based on proximity to the next UTC funding settlement (0:00 / 8:00 / 16:00): 30s when <10 min away, 2 min when <30 min away, default 5 min otherwise. Auto-refresh pauses when the tab is hidden.
- **Mobile sticky column**: The first column (symbol name) is `position: sticky` scoped to `.table-wrap` so it stays visible during horizontal scroll on narrow screens.
