# CR3 Prod vs Baseline Comparison

## Headline

| | Baseline (1m loose) | Prod preset (5m filtered) | Delta |
|---|---------------------|---------------------------|-------|
| Trades | 250 | 107 | -143 |
| Net | $2114.5 | $0 | $-2114.5 |
| Win rate | 44.8% | 0% | -44.8pp |
| PF | 1.42 | null | — |
| Net/trade | $8.46 | $0 | $-8.46 |

## Baseline entry mix
- CR3_WL: 144 trades, $1018
- CR3_WU: 106 trades, $1096

## Prod entry mix
- CR3_WL: 84 trades, $0
- CR3_L: 5 trades, $0
- CR3_WU: 13 trades, $0
- CR3_S: 5 trades, $0

## Prod top buckets
- W_L_2: n=45 wr=0% $0
- ?: n=10 wr=0% $0
- W_L_3+: n=26 wr=0% $0
- W_L_OS: n=13 wr=0% $0
- W_U_OB: n=13 wr=0% $0

## Notes
- Trade count cut sharply — less commission drag, less chop exposure.
- Profit factor lower — fewer trades; check if net/trade improved.
