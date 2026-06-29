# Cloud Regime v3.0 — Full Stack · Settings Reference

**File:** `cloud-regime-v3-full-stack-strategy.pine`  
**Chart:** MNQ1! · 5m (as tested)  
**Recorded:** 2026-05-29  
**MCP pin:** `ADVISOR_STRATEGY_SUBSTRING=Full Stack`

---

## Strategy properties (code — not in Inputs panel)

These are set in the `strategy()` declaration. **Do not change `initial_capital` below 100000 on MNQ** or Strategy Tester shows 0 fills.

```pine
strategy("Cloud Regime v3.0 — Full Stack",
     shorttitle          = "CR_v3",
     overlay             = true,
     pyramiding          = 0,
     default_qty_type    = strategy.fixed,
     default_qty_value   = 1,
     initial_capital     = 100000,
     commission_type     = strategy.commission.cash_per_contract,
     commission_value    = 0.62,
     slippage            = 1,
     calc_on_every_tick  = false,
     process_orders_on_close = true,
     max_bars_back       = 1000,
     max_labels_count    = 500)
```

| Property | Value | Notes |
|----------|-------|-------|
| `initial_capital` | **100000** | Required for MNQ1! margin |
| `pyramiding` | 0 | One position at a time |
| `default_qty_value` | 1 | 1 contract |
| TP / SL | 20 / 10 pts | From inputs `tpPoints` / `slPoints` |

---

## All inputs (defaults as in pine source)

| in_N | Group | Input | Default | Options / range |
|------|-------|-------|---------|-----------------|
| in_0 | MULTI-TIMEFRAME | HTF (Cloud / MACD / ADX) | **5** | Must match chart TF on 5m |
| in_1 | CLOUD | Fast EMA | 9 | |
| in_2 | CLOUD | Slow EMA | 21 | |
| in_3 | CLOUD | SMA Baseline | 50 | |
| in_4 | CLOUD | Cloud Smoothing | 3 | |
| in_5 | CLOUD | EMA Slope Lookback | 5 | |
| in_6 | CLOUD | EMA Steep Threshold | 0.15 | |
| in_7 | MACD | Fast Length | 12 | |
| in_8 | MACD | Slow Length | 26 | |
| in_9 | MACD | Signal Length | 9 | |
| in_10 | VWAP | Proximity Buffer (ATR×) | 1.0 | |
| in_11 | VWAP | ATR Length | 14 | |
| in_12 | VWAP | VWAP Entry Trigger | **2-Bar** | Edge, 2-Bar, Zone |
| in_13 | ADX | ADX / DI Length | 14 | |
| in_14 | ADX | ADX Smoothing | 14 | |
| in_15 | ADX | Optimal Floor | **18** | Grid winner |
| in_16 | ADX | Optimal Ceiling | **35** | Grid winner |
| in_17 | D-RSI | Enable D-RSI Filter | true | |
| in_18 | D-RSI | RSI Length | 21 | |
| in_19 | D-RSI | D-RSI Smoothing | 14 | |
| in_20 | D-RSI | Signal Line Length | 9 | |
| in_21 | D-RSI | Signal Mode | Direction Change | Direction Change, Zero-Crossing, Signal Line Crossing |
| in_22 | BB WICK LABELS | Plot Bollinger Bands | true | |
| in_23 | BB WICK LABELS | Show BB Wick Labels | true | |
| in_24 | BB WICK LABELS | BB Length | 20 | |
| in_25 | BB WICK LABELS | BB Std Dev | 2.0 | |
| in_26 | BB WICK LABELS | RSI Length (label data) | 14 | |
| in_27 | BB WICK LABELS | RSI Oversold | 30 | |
| in_28 | BB WICK LABELS | RSI Overbought | 70 | |
| in_29 | BB WICK LABELS | Min Confluence to Show Label | 3 | Research still counts all wicks |
| in_30 | RISK | Take Profit (pts) | 20.0 | |
| in_31 | RISK | Stop Loss (pts) | 10.0 | |
| in_32 | SESSION | Enable Session Filter | true | |
| in_33 | SESSION | Trading Window | **0930-1600** | Grid winner (RTH) |
| in_34 | SESSION | Block Lunch Chop (13–14 ET) | **true** | Labeled review filter |
| in_35 | **ENTRIES** | **Enable Trend Tier** | **true** | Dual tier with wick |
| in_36 | **ENTRIES** | **Enable Wick Reversal Tier** | **true** | CR3_WL / CR3_WU |
| in_37 | ENTRIES | Wick Entry Min Confluence | **2** | W_L_2 style |
| in_38 | ENTRIES | Wick Long Max Confluence | **4** | Block conf≥5 trap |
| in_39 | ENTRIES | Wick Short Max Confluence | **4** | Cap W_U_3+ noise |
| in_40 | ENTRIES | Wick Long Requires RSI OS | **false** | Confluence-only longs |
| in_41 | ENTRIES | Wick Short Requires RSI OB | **true** | W_U_OB quality |
| in_42 | ENTRIES | Block Long Wick Trend Stack | **true** | conf≥4 + BULL + MACD |
| in_43 | ENTRIES | ADX Block on Wick Positions | **false** | Bracket exits only |
| in_44 | TABLE | Show Performance Table | true | |
| in_45 | RESEARCH | Enable Research Mode | true | |
| in_46 | RESEARCH | Outcome Lookback (bars) | 10 | |
| in_47 | RESEARCH | Event Cluster (bars) | 12 | |
| in_48 | RESEARCH | Win Threshold (pts) | 0.0 | |
| in_49 | RESEARCH | Track MFE / MAE | true | |
| in_50 | RESEARCH | Show Research Table | true | |
| in_51 | RESEARCH | ADX Entry Ceiling | **35** | Grid winner |
| in_52 | RESEARCH | Trend — ADX gate | true | |
| in_53 | RESEARCH | Trend — D-RSI filter | true | |
| in_54 | RESEARCH | Trend — Cloud slope | true | |
| in_55 | RESEARCH | Trend — Session filter | true | |

---

## VWAP trigger modes (code)

```pine
vwapPullback  = nearVwap and not nearVwap[1]      // Edge
vwapProx2Bar  = nearVwap and not nearVwap[2]      // 2-Bar (default, grid winner)
vwapZone      = nearVwap                          // Zone (many trades, lower quality)
vwapTrigger   = vwapTrigMode == "Edge" ? vwapPullback : vwapTrigMode == "2-Bar" ? vwapProx2Bar : vwapZone
```

---

## Entry logic (code)

### Trend tier → Strategy Tester comments `CR3_L` / `CR3_S`

```pine
longSetup  = htfBull and macdBullish and slopeGate and vwapTrigger and aboveVwap and adxGate and drsiGateL and entryOk
shortSetup = htfBear and macdBearish and slopeGate and vwapTrigger and belowVwap and adxGate and drsiGateS and entryOk

trendLongEntry  = flatBook and useTrendTier and longSetup
trendShortEntry = flatBook and useTrendTier and shortSetup
```

### Wick tier → Strategy Tester comments `CR3_WL` / `CR3_WU`

```pine
wickLongEntry  = flatBook and useWickTier and clusteredLower and wickLongConfOk and wickLongTrendOk
                 and (wickRequireOs ? wickOs : true) and entryOk
wickShortEntry = flatBook and useWickTier and clusteredUpper and wickShortConfOk
                 and (wickRequireOb ? wickOb : true) and entryOk
// entryOk = RTH session + optional lunch block (13:00–14:00 ET)
```

Wick entries only fire when trend does **not** on the same bar: `wickLongEntry and not trendLongEntry`.

### Research table vs Strategy Tester

| Research row | Meaning | ST order? |
|--------------|---------|-------------|
| `W_L_1`, `W_L_2`, `W_L_3+`, `W_L_OS`, `W_L_CT` | Forward stats on clustered wick **signals** | No (unless wick tier ON) |
| `T_L`, `T_S` | Trend **setup** snapshots | No (unless trend tier fires) |
| `E_L`, `E_S` | Actual trend **entries** | Yes → `CR3_L` / `CR3_S` |
| `WK_L`, `WK_S` | Actual wick **entries** | Yes → `CR3_WL` / `CR3_WU` |

---

## Verified presets (MNQ 5m ~102d)

### A — Production trend (default)

```json
{
  "htfTF": "5",
  "vwapTrigMode": "2-Bar",
  "proxMult": 1.0,
  "zOptLow": 18,
  "zOptHigh": 35,
  "adxEntryHigh": 35,
  "sessStart": "0930-1600",
  "useTrendTier": true,
  "useWickTier": false,
  "enforce_adx": true,
  "enforce_drsi": true,
  "enforce_slope": true,
  "enforce_session": true,
  "outcomeLB": 10
}
```

**Strategy Tester:** ~10 trades · +$101.60 · PF 1.78 · 60% WR

### B — Wick-only quality (RSI oversold required)

```json
{
  "htfTF": "5",
  "useTrendTier": false,
  "useWickTier": true,
  "wickMinConf": 2,
  "wickRequireOs": true,
  "wickRequireOb": true,
  "sessStart": "0930-1600",
  "outcomeLB": 10
}
```

**Strategy Tester:** ~28 trades · +$618.78 · WK_L N=13

### C — Wick-only W_L_2 style (confluence 2+, no RSI OS required)

```json
{
  "htfTF": "5",
  "useTrendTier": false,
  "useWickTier": true,
  "wickMinConf": 2,
  "wickRequireOs": false,
  "wickRequireOb": false,
  "sessStart": "0930-1600",
  "outcomeLB": 10
}
```

**Strategy Tester:** ~112 trades · +$344.62 · WK_L N=97

---

## Node / MCP — apply settings programmatically

**Source of truth:** `scripts/cr3-grid-utils.mjs` → `CR3_DEFAULT_SPEC` + `specToInputs()`

```javascript
// scripts/cr3-grid-utils.mjs
export const CR3_DEFAULT_SPEC = {
  htfTF: '5',
  cloudSmooth: 3,
  zOptLow: 18,
  zOptHigh: 35,
  proxMult: 1.0,
  vwapTrigMode: '2-Bar',
  tpPoints: 20,
  slPoints: 10,
  useSession: true,
  sessStart: '0930-1600',
  enableResearch: true,
  outcomeLB: 10,
  clusterBars: 12,
  useTrendTier: true,
  useWickTier: false,
  wickMinConf: 2,
  wickRequireOs: true,
  wickRequireOb: true,
  adxEntryHigh: 35,
  enforce_drsi: true,
  enforce_slope: true,
  minWickConfDisplay: 3,
};
```

### Push pine + apply defaults (PowerShell)

```powershell
$env:CLOUD_REGIME_SRC = "c:\Users\dypag\tradingview-mcp\cloud-regime-v3-full-stack-strategy.pine"
$env:ADVISOR_STRATEGY_SUBSTRING = "Full Stack"
node scripts/push-cloud-regime-v3.mjs
node scripts/run-cr3-research-snapshot.mjs
```

### Apply preset B (wick-only) via Node

```javascript
import * as indicators from './src/core/indicators.js';
import { specToInputs, CR3_DEFAULT_SPEC } from './scripts/cr3-grid-utils.mjs';

const spec = {
  ...CR3_DEFAULT_SPEC,
  useTrendTier: false,
  useWickTier: true,
  wickMinConf: 2,
  wickRequireOs: true,
};

await indicators.setInputs({
  entity_id: 'YOUR_ENTITY_ID',  // from chart_get_state
  inputs: JSON.stringify(specToInputs(spec)),
  persist_layout: true,
});
```

---

## Strategy Tester checklist (avoid 0 trades)

1. **HTF = 5** on a 5m chart (not 90, not 60).
2. **Enable Trend Tier = ON** (for trend trades) or **Wick Tier = ON** (for wick trades).
3. **Outcome Lookback = 10** (research only, but wrong value clutters table).
4. Strategy uses **initial_capital 100000** in code (saved script must be latest).
5. In List of Trades, filter comments: `CR3_L`, `CR3_S`, `CR3_WL`, `CR3_WU`.
6. Save layout after changing inputs so grid runs / manual tweaks do not drift.

---

## Related files

| Path | Role |
|------|------|
| `cloud-regime-v3-full-stack-strategy.pine` | Pine source |
| `scripts/cr3-grid-utils.mjs` | Input index map + `CR3_DEFAULT_SPEC` |
| `scripts/push-cloud-regime-v3.mjs` | Deploy to TV editor |
| `scripts/run-cr3-research-snapshot.mjs` | Export research table |
| `data/grid_runs/cr3_grid_2026-05-29T22-46-25/` | Post-capital grid results |
| `data/grid_runs/cr3_research_2026-05-29T22-42-41/evaluation_notes.md` | Evaluation summary |
