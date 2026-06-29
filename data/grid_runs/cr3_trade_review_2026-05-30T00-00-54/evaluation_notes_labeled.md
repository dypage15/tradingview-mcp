# CR3 Wick-Only 1m — Labeled Trade Analysis (250 trades, +$2,114)

**Data:** `trades_with_labels.csv` — pane snapshots at entry merged with xlsx PnL/MFE/MAE  
**Settings:** MNQ 1m, HTF 30, Wick ON / Trend OFF, wickMinConf=1, TP 40 / SL 20, RTH 0930–1600

## Executive verdict

The account is profitable **despite** taking too many low-edge trades. **72% of net profit ($1,530) comes from conf=2 entries alone.** The engine works when a wick reversal at BB extremes gets 40 pts of follow-through; **96 full stop-outs (−$4,009) are the main leak.** Highest-action fix: **trade W_L_2 / conf=2 longs, especially counter-cloud, and cut conf≥5 longs and W_L_3+ volume.**

---

## What's helping (evidence from actual trades)

### 1. W_L_2 — validated edge (+$838, PF ~2.56)
- 37 trades, **59.5% WR**, +$22.64 avg
- 45.9% hit full TP vs 27% SL
- Matches 5m grid research (W_L_2 59% / +12.5 pts forward)

### 2. Confluence = 2 sweet spot (+$1,530 on 81 trades)
| Conf | N | WR | Net | Avg |
|------|---|-----|-----|-----|
| **2** | 81 | **51.9%** | **+$1,530** | +$18.89 |
| 3+ | 127 | 40.2% | +$377 | +$2.97 |
| 1 | 42 | 45.2% | +$207 | +$4.94 |

More checkmarks ≠ better. Conf 3+ adds **127 trades** for only **25% of profit**.

### 3. Long conf2 + counter-cloud — best cell (+$833, 73.7% WR)
- 19 trades: lower wick **against** HTF cloud
- 68.4% TP rate, only 15.8% SL
- Wick reversal at BB edge in local exhaustion — **this is the strategy's true identity**

### 4. Short upper wicks — W_U_2 + W_U_OB
| Bucket | N | WR | Net | Avg |
|--------|---|-----|-----|-----|
| W_U_2 | 36 | 44% | +$540 | +$15 |
| W_U_OB | 12 | **58%** | +$314 | +$26 |

Shorts use bracket well; OB tag marks quality (8.3% SL rate on OB).

### 5. Morning session 10:00–12:00 ET (+$1,617)
| Hour | N | Net | Avg |
|------|---|-----|-----|
| 10 | 19 | +$391 | +$20.58 |
| 11 | 41 | +$670 | +$16.33 |
| 12 | 40 | +$557 | +$13.92 |
| **13** | 42 | **−$120** | −$2.86 |

### 6. Counter-trend wicks beat with-trend (PF 1.94 vs 1.24)
- Counter-cloud: 79 trades, +$1,235, 50.6% WR
- With-cloud: 113 trades, +$555, 43.4% WR, **45% SL rate**

Wicks are **mean-reversion at extremes**, not trend continuation.

### 7. MACD hist opposing side (+$1,131 on macd_neg entries)
- Longs with negative MACD / shorts with positive: 49.5% WR vs 41.3% for aligned MACD
- Reversal entries work when momentum is exhausted on HTF

---

## What's hurting

### 1. Stop-loss volume — 96 trades, −$4,009 (189% of gross profit given back)
- Long `WL_Exit` path: **40.2% WR**, 53.6% SL rate
- Short `WS_Exit`: 47.3% WR — longs bleed more

### 2. W_L_3+ volume trap — 73 trades, +$152 total (+$2.08/trade)
- 29% of all trades, **56% SL rate**
- High conf on 1m = stacked filters in chop, not cleaner setups

### 3. Long conf≥5 + with-cloud — −$255, 88.9% SL (9 trades)
- conf6_cloud_with_cloud: worst cell
- "Perfect" confluence in trend = buying pullbacks that keep falling

### 4. Hour 13:00 — lunch chop (−$120, 33% WR, 45% SL)
- Simulated drop: 208 trades, +$2,235, **PF 1.57** vs 1.42 full set

### 5. wickMinConf=1 noise — 42 conf-1 trades, mostly marginal
- Dropping conf-1 longs alone: 225 trades, +$2,090, PF 1.46

### 6. ADX_Block exits (64) — messy middle
- Net +$173 (neutral), but **90% fire when ADX left 18–35 band**
- W_U_1 ADX blocks: −$90 — low-quality entries force-closed
- Not catastrophic; better as **entry filter** than mid-trade exit on wick tier

### 7. W_L_OS filter — disappointing in ST (9 trades, 33% WR, +$4)
- Research forward stats ≠ ST bracket outcomes on 1m
- Do not require OS until re-tested on 5m

### 8. Config drift from validated 5m baseline
- Grid winner: 5m trend ON, 10 trades, 60% WR, PF 1.78
- Current: 1m wick-only, 250 trades, 44.8% WR, PF 1.42, ~$310 commission

### 9. Bad-day pattern — high SL clustering
| Day | SL rate | PnL |
|-----|---------|-----|
| May 27 | **69%** | −$198 |
| May 22 | 53% | −$9 |
| May 18 (best) | 32% | +$789 |

May 27: grinding range, W_L_3+ and conf≥5 longs into repeated stops.

---

## Simulated filters (same 15-day window, not re-backtested)

| Filter | Trades | Net | PF |
|--------|--------|-----|-----|
| Actual | 250 | +$2,114 | 1.42 |
| conf ≥ 2 | 208 | +$1,907 | 1.44 |
| conf ≥ 2, skip hour 13 | 171 | +$1,985 | **1.58** |
| W_L_2 only | 37 | +$838 | **2.56** |
| Skip hour 13 | 208 | +$2,235 | 1.57 |

---

## Recommended production profile (ordered)

1. **wickMinConf = 2** — cuts conf-1 and most W_L_3+ noise  
2. **Long priority: W_L_2 pattern** — conf=2, prefer counter-cloud / macd_neg  
3. **Short: keep W_U_2, add wickRequireOb** for W_U_OB quality  
4. **Block or reduce size 13:00–14:00 ET**  
5. **Cap long conf at 4** — conf≥5 with-cloud is net negative  
6. **Move to 5m chart + HTF 5** for grid alignment; if staying 1m, HTF 15 not 30  
7. **Consider TP 20 / SL 10 on 1m** — 40pt target works on trend days (May 18) but 96 SLs suggest 20pt stop is wide for chop  
8. **Re-enable trend tier** as primary with wick tier filtered — dual-tier test  

---

## PnL waterfall

```
+$6,143   78 × full TP (40 pt)
−$4,009   96 × full SL (20 pt)
  +$173   64 × ADX_Block
  −$193   12 × other exits
─────────
+$2,114   net (250 trades)
```

**Bottom line:** Keep the wick reversal core; **stop feeding it conf≥3 longs in lunch chop.** The labeled data proves W_L_2 counter-cloud on 1m is real edge — everything else is dilution.
