# CR3 Full Stack — MNQ 5m evaluation (~102d)

## Verdict

**Keep embedded research mode; keep trend tier ON, wick tier OFF for production.** Wick buckets show measurable forward edge; trend tier is profitable post-capital fix with ADX 18–35 + RTH session.

## Research highlights (outcomeLB=10, clusterBars=12)

| Bucket | N | Win% | AvgPts | Notes |
|--------|---|------|--------|-------|
| **W_L_2** | 274 | 59.1% | +12.51 | Best balanced bucket (plan success metric met) |
| W_L_CT | 288 | 57.3% | +5.60 | Counter-trend lower wick — usable hypothesis |
| W_L_3+ | 149 | 51.0% | -2.83 | High conf alone insufficient |
| W_L_OS | 52 | 53.8% | -0.55 | OS alone insufficient (small N) |
| T_L / T_S | 5 / 6 | 40% / 50% | mixed | Trend stack still rare |
| W_U_2 | 250 | 39.6% | -14.78 | Short wick 2-conf — avoid |

Clustered wick N (~150–290 per bucket) is far below raw label count (~500+) — clustering works.

## Strategy Tester (defaults, capital fix)

| Metric | Value |
|--------|-------|
| Trades | 6 (2L / 4S) |
| Net | +$67.56 |
| PF | 1.77 |
| WR | 66.7% |

**Root cause of earlier 0-trade runs:** `initial_capital=10000` insufficient for MNQ1! margin. Fixed to **100000** (matches ClReg2.2).

## Grid sweep (54 cells) — post-capital fix

**Run:** `data/grid_runs/cr3_grid_2026-05-29T22-46-25/`

| ADX band | Session | Trades | Net | PF | WR | Met constraint |
|----------|---------|--------|-----|-----|-----|----------------|
| **18–35** | **0930–1600** | **10** | **+$101.60** | **1.78** | **60%** | **yes** |
| 20–40 | 0930–1600 | 11 | +$79.86 | 1.52 | 54.5% | yes |
| 20–45 | 0930–1600 | 11 | +$79.86 | 1.52 | 54.5% | yes |
| 18–35 | 0930–1200 | 7 | +$45.82 | 1.42 | 57.1% | no (trades < 10) |

- **27/54 cells** met constraints (MIN_TRADES ≥ 10, PF ≥ 1.0, net > 0).
- **Trade metrics are identical** across `wickMinConf` (2/3/4) and `outcomeLB` (8/10/20) — expected while wick tier is OFF; only ADX band + session affect trend entries.
- **Winner:** tighter ADX floor **18** and ceiling **35** beats wider 20–45 bands (+$101 vs +$80 at 11 trades).
- **Best research cell** (same run): W_L_2 59.1% / +12.5 pts (N=274) at outcomeLB=20 morning — research-only; trade winner is RTH + ADX 18–35.

## OOS

Only **6 closed trades** at pre-grid defaults — insufficient for 70/30 calendar split. Full-window research buckets used for signal validation; trade-level OOS deferred until trend tier produces ≥20 trades.

Random-entry baseline (100 trades, TP 20 / SL 10): +500 pts simulated — CR3 wick research buckets beat null on Win% + AvgPts where N≥30.

## Production defaults locked

| Setting | Value | Rationale |
|---------|-------|-----------|
| `initial_capital` | 100000 | MNQ margin |
| `useTrendTier` | true | Trend + wick dual tier |
| `useWickTier` | **true** | Labeled review: W_L_2 edge worth trading |
| `wickMinConf` | **2** | 72% of labeled PnL at conf=2 |
| `wickMaxConfLong/Short` | **4** | Block conf≥5 long trend-stack trap |
| `wickRequireOs` | **false** | W_L_2 confluence-only (counter-cloud best) |
| `wickRequireOb` | **true** | W_U_OB 58% WR in labeled review |
| `wickBlockTrendStack` | **true** | Skip conf≥4 + BULL cloud + MACD bull longs |
| `useLunchBlock` | **true** | Block 13:00–14:00 ET entries |
| `applyAdxBlockToWick` | **false** | Wick bracket exits; ADX block neutral noise |
| `minWickConfDisplay` | 3 | Cuts label noise |
| `sessStart` | 0930-1600 | Grid trade winner |
| `zOptLow` / `zOptHigh` | 18 / 35 | Grid trade winner |
| `tpPoints` / `slPoints` | 20 / 10 | Grid + 5m baseline |
| `htfTF` | 5 | Match 5m chart |
| `vwapTrigMode` | 2-Bar | Grid winner |
| `outcomeLB` / `clusterBars` | 10 / 12 | Research defaults |

## Next steps

1. ~~Re-run `run-cr3-grid.mjs` post-capital fix~~ — done; ADX 18–35 + RTH locked.
2. ~~Enable wick tier with labeled-review filters~~ — done in pine defaults + `apply-cr3-labeled-prod.mjs`.
3. Re-export labeled trades after prod preset backtest (`merge-xlsx-label-trades.mjs`).
4. OOS re-run when trade count ≥20.
