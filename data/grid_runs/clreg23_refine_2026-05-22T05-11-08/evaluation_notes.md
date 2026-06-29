# ClReg2.3 refinement — MNQ 5m (~102d)

## Verdict

**Keep v2.2 optimized spec.** v2.3 quality filters and ATR risk did not beat baseline on this window.

## Best cell (4/72 met constraints)

| Setting | Value |
|---------|-------|
| RSI | Combined, len 6, lookback 3 |
| Cloud smooth | 3 |
| TP / SL | 30 / 15 pts (Points mode) |
| Cooldown | 0 |
| Min cloud sep | 0 |

**Metrics:** +2,581 pts net, PF 1.13, 37.7% WR, 551 trades

## Filter / risk findings

- **minCloudSep ≥ 3** → large drawdowns (e.g. cd0 sep3: negative net)
- **Cooldown 3** with sep=0 → identical to baseline (flip entries rarely stack)
- **Cooldown 6–10** → worse or unprofitable
- **ATR risk** → best +1,315 (TP 2.5× / SL 1.25× ATR), below points baseline

## Defaults change

Shipped **minBarsBetween=0**, **minCloudSep=0** in pine so new installs match grid winner.

## Next steps (if pushing past +2581)

1. Out-of-sample date split (train Dec–Feb / test Mar–May)
2. RTH-only session grid (globex flips may dilute edge)
3. Structural entry: require SMA slope / HTF cloud alignment before flip trade
