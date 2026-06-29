# CR3 Prod vs Baseline Comparison

## Headline

| | Baseline (1m loose) | Prod preset (5m filtered) | Delta |
|---|---------------------|---------------------------|-------|
| Trades | 250 | 108 | -142 |
| Net | $2114.5 | $715.08 | $-1399.42 |
| Win rate | 44.8% | 49.1% | 4.3pp |
| PF | 1.42 | 1.37 | -0.05 |
| Net/trade | $8.46 | $6.62 | $-1.84 |

## Baseline entry mix
- CR3_WL: 144 trades, $1018
- CR3_WU: 106 trades, $1096

## Prod entry mix
- CR3_WL: 86 trades, $304
- CR3_L: 5 trades, $73
- CR3_WU: 13 trades, $244
- CR3_S: 4 trades, $95

## Prod top buckets
- W_L_OS: n=13 wr=61.5% $306.38
- W_U_OB: n=13 wr=61.5% $243.88
- ?: n=9 wr=66.7% $167.34
- W_L_2: n=47 wr=44.7% $83.22
- W_L_3+: n=26 wr=38.5% $-85.74

## Notes
- Higher win rate — filters removing low-edge entries.
- Trade count cut sharply — less commission drag, less chop exposure.
- Profit factor lower — fewer trades; check if net/trade improved.
