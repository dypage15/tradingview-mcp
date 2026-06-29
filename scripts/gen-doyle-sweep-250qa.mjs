/**
 * One-off generator: Doyle + Sweep 250 Q&A notepad (TV metrics + known Sweep mechanics).
 * Does not modify Pine. Output: data/Doyle-Sweep-250QA-Notepad.txt
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const M = {
  sym: 'CME_MINI:MNQ1!',
  tf: '5',
  strat: 'Sweep Engine v2.0',
  doyle: 'Doyle S&D (v61.1 - Signal Fix)',
  net: 5490.36,
  pf: 2.205941011606148,
  wr: 72.09302325581395,
  tt: 43,
  win: 31,
  loss: 12,
  aw: 323.9716129,
  al: 379.3966667,
  at: 127.6827907,
  rWL: 0.8539126495704661,
  lw: 869.52,
  ll: 858.48,
  gp: 10043.12,
  gl: 4552.76,
  comm: 106.64,
  maxQ: 2,
  cand: 18,
  avgBL: 17.416666666666668,
  avgBT: 16.488372093023255,
  avgBW: 16.129032258064516,
};

const out = [];
const push = (s) => out.push(s);

push('='.repeat(80));
push('250 QUESTION / ANSWER NOTEPAD');
push(`${M.doyle}  +  ${M.strat} (Sweep v2 family)`);
push('='.repeat(80));
push('');
push('PROVENANCE — READ FIRST');
push(`- TradingView Strategy Tester metrics were read via tv CLI (internal_api) for ${M.strat} on ${M.sym} @ ${M.tf}m.`);
push(`- Chart study list (tv state) includes "${M.doyle}" and multiple Sweep-related studies.`);
push('- Doyle zone geometry and signals are NOT available as numeric series through this CLI — answers about Doyle "at trade X" require visual/manual logging unless you export otherwise.');
push('- Sweep mechanics answers reference sweep-engine-v2-export.pine in this repo (read-only; script not modified).');
push('- Per-trade PnL rows from tv data trades were not parseable by quant-advisor (TRADE_EXPORT_GAP) — Q&As avoid fabricating which tickets won/lost individually.');
push('');
push('KEY METRICS — THIS TV SAMPLE (used wherever Q asks for "our run")');
push(`  Net profit $${M.net.toFixed(2)}  |  PF ${M.pf.toFixed(4)}  |  Win rate ${M.wr.toFixed(2)}%`);
push(`  Trades ${M.tt} (${M.win} W / ${M.loss} L)  |  Avg trade $${M.at.toFixed(2)}`);
push(`  Avg win $${M.aw.toFixed(2)}  |  Avg loss $${M.al.toFixed(2)}  |  avgWin/avgLoss ratio ${M.rWL.toFixed(4)}`);
push(`  Largest win $${M.lw.toFixed(2)}  |  Largest loss $${M.ll.toFixed(2)}  |  Commission ~$${M.comm.toFixed(2)}`);
push(`  maxContractsHeld ${M.maxQ}  |  strategy candidate matches on chart: ${M.cand} (pin with ADVISOR_STRATEGY_SUBSTRING)`);
push(`  Avg bars: in trade ${M.avgBT.toFixed(2)}  |  in win ${M.avgBW.toFixed(2)}  |  in loss ${M.avgBL.toFixed(2)}`);
push('');
push('='.repeat(80));
push('QUESTIONS AND ANSWERS (250)');
push('='.repeat(80));
push('');

const QA = [];

function Q(n, q, a) {
  QA.push({ n, q, a });
}

// --- 1–60: Data, sample, honesty ---
Q(1, 'What backtest sample do these answers use?', `Strategy Tester summary for ${M.strat} on ${M.sym} ${M.tf}m — net $${M.net.toFixed(2)}, ${M.tt} trades.`);
Q(2, 'Can we list every winning trade’s entry time from this file?', 'No — trade-level PnL was not parsed from the automated export; only aggregate W/L counts and averages are factual here.');
Q(3, 'How many losing trades occurred in the sample?', `${M.loss} — from numberOfLosingTrades in metrics.`);
Q(4, 'How many winning trades?', `${M.win} — from numberOfWiningTrades (TV spelling) in metrics.`);
Q(5, 'What was profit factor?', `~${M.pf.toFixed(4)} — gross profit / gross loss magnitude per tester.`);
Q(6, 'What was net profit?', `~$${M.net.toFixed(2)} USD in this read.`);
Q(7, 'Was average win larger than average loss?', `No — avg win ~$${M.aw.toFixed(2)} vs avg loss ~$${M.al.toFixed(2)}; ratio ${M.rWL.toFixed(4)} (<1).`);
Q(8, 'Does that pattern always mean a bad system?', 'Not necessarily — high win rate can coexist with smaller avg wins; risk is loss streaks and tail losers.');
Q(9, 'Largest single win?', `~$${M.lw.toFixed(2)} — largestWinTrade in metrics.`);
Q(10, 'Largest single loss?', `~$${M.ll.toFixed(2)} — largestLosTrade in metrics.`);
Q(11, 'Are largest win and loss similar size?', `Roughly yes (~${M.lw.toFixed(0)} vs ~${M.ll.toFixed(0)}) — large single loss is realistic relative to large win.`);
Q(12, 'Total commission paid in sample?', `~$${M.comm.toFixed(2)} — commissionPaid field.`);
Q(13, 'How many contracts did the tester use at peak?', `${M.maxQ} — maxContractsHeld; risk scales with this (not 1-lot).`);
Q(14, 'Average dollars per trade (all)?', `~$${M.at.toFixed(2)} — avgTrade.`);
Q(15, 'Average bars in losing trades?', `~${M.avgBL.toFixed(2)} bars — avgBarsInLossTrade.`);
Q(16, 'Average bars in winning trades?', `~${M.avgBW.toFixed(2)} bars — avgBarsInWinTrade.`);
Q(17, 'Were losses longer in time than wins on average?', `Yes in this sample (${M.avgBL.toFixed(2)} vs ${M.avgBW.toFixed(2)} bars).`);
Q(18, 'Margin calls?', '0 in the metrics object for this read.');
Q(19, 'Gross profit dollars?', `~$${M.gp.toFixed(2)}.`);
Q(20, 'Gross loss dollars?', `~$${M.gl.toFixed(2)}.`);
Q(21, 'Win rate percentage?', `~${M.wr.toFixed(2)}% — percentProfitable.`);
Q(22, 'Does this sample prove future performance?', 'No — past backtest only; regime change can invalidate.');
Q(23, 'Why might advisor show TRADE_EXPORT_GAP?', 'TV trade JSON may omit or rename PnL fields — factual limitation of the bridge, not Sweep logic.');
Q(24, 'Is max drawdown % in this notepad?', 'Not reliably from API this session — read Strategy Tester overview in TV for max DD % / $.');
Q(25, 'How many strategies on chart matched "Sweep" substring?', `${M.cand} — pin ${M.strat} for reproducible CLI reads.`);

Q(26, 'Is Doyle included in the $5490 net profit?', 'No — net profit is for the Sweep strategy under test; Doyle is a separate indicator.');
Q(27, 'Is Doyle on the chart?', 'Yes — confirmed via tv state study list (title includes v61.1 Signal Fix).');
Q(28, 'Did we numerically score Doyle–Sweep agreement?', 'No — not available from the same metrics API.');
Q(29, 'Can Doyle still help discretionary review?', 'Yes visually — mark whether entries sit on supply/demand; log manually for data.');
Q(30, 'Does v61.1 "Signal Fix" change appear in this file?', 'No changelog here — only the title string from TV.');

Q(31, 'Common sense: trading 2 MNQ vs 1 for same signals?', 'Doubles PnL and drawdown scale — factual from maxContractsHeld=2.');
Q(32, 'Should risk caps use contract count?', 'Yes — any $2000 DD idea must match actual qty in tester.');
Q(33, 'Does high PF excuse skipping OOS validation?', 'No — PF is in-sample unless you define OOS protocol.');
Q(34, 'Is 43 trades enough for significance?', 'Marginal — better than a handful, still vulnerable to period luck.');
Q(35, 'Could one month dominate results?', 'Possible — check date range in TV; not expanded here.');
Q(36, 'Are commissions realistic for your broker?', 'You must compare commission_value in Pine to live/pro sim.');
Q(37, 'Slippage sensitivity?', 'Default slippage in strategy affects fills — stress-test.');
Q(38, 'Is bar-close backtest optimistic vs intrabar stops?', 'Often yes — process_orders_on_close reduces intrabar ambiguity but can differ from live.');
Q(39, 'Session flat exits affecting PnL?', 'Factual from order export earlier: Session flat closes appear — can cut winners/losses before TP.');
Q(40, 'Multiple engines on chart — human error risk?', 'Yes — conflicting signals (Confluence Engine, Displacement, etc.) can confuse discretion.');

Q(41, 'Sweep sessions use which timezone?', 'America/Chicago in sweep-engine-v2-export.pine.');
Q(42, 'IB sweep requires post-IB window?', 'Yes — isPostIB for IB-based sweep definitions.');
Q(43, 'London/Asia sweeps use killzone?', 'London and Asia sweep formulas include isKillzone in the export Pine.');
Q(44, 'What is bull sweep pattern?', 'Wick through level, close back through (e.g. low < level, close > level for lows).');
Q(45, 'Optional depth filter?', 'i_sweepDepthAtr — requires penetration beyond level by ATR multiple when >0.');
Q(46, 'Default min confluence score?', '0 — raising blocks many sweeps with 0 confluence.');
Q(47, 'What adds confluence points?', 'Near round number, near VWAP, Lon50 alignment — up to 3.');
Q(48, 'HTF trend filter default?', 'Off — i_useHtfTrend default false.');
Q(49, 'ADX filter default?', 'Off.');
Q(50, 'RSI gate default?', 'Off.');

Q(51, 'Volume gate default?', 'Off.');
Q(52, 'EMA gate default?', 'Off.');
Q(53, 'Max trades per day default?', '0 = unlimited by that input.');
Q(54, 'Cooldown default purpose?', 'Reduce re-entry clustering — i_cooldown bars after last signal.');
Q(55, 'Flatten CT default meaning?', 'pastFlat blocks new trades and triggers flat close logic after flatten time.');
Q(56, 'DD USD guard in Pine?', 'Tracks peak strategy.equity vs i_maxDdUsd — blocks entries and optional flatten.');
Q(57, 'Is predConf a probability?', 'No — Pine comments say heuristic, not true probability.');
Q(58, 'Reactive vs predictive entry?', 'Reactive: market on signal bar; predictive: limit at model level — different fill risk.');
Q(59, 'Block reactive long in bear pool?', 'When i_blockReactiveLongVsBearModel true — reduces longs against bearish model dominance.');
Q(60, 'Pyramiding?', '0 in strategy declaration — no add-ons in script defaults.');

// 61–120 Doyle × process
const doyle = [
  ['What is supply/demand generally?', 'Zones where price may react — Doyle visualizes; Sweep does not replace that with the same math.'],
  ['Should longs prefer demand?', 'Common SMC idea — verify on chart when Sweep fires long.'],
  ['Should shorts prefer supply?', 'Same — discretionary overlay; not in Sweep metrics.'],
  ['Does Sweep know Doyle zone freshness?', 'No in Sweep code.'],
  ['Does Sweep know Doyle strength score?', 'No.'],
  ['Can you require both for a manual rule?', 'Yes — define tolerance in ticks and journal it.'],
  ['HTF Doyle vs LTF Sweep?', 'Possible mismatch — check both timeframes manually.'],
  ['Doyle signal fix — expect fewer bad signals?', 'Unknown without Doyle source — title only here.'],
  ['If Doyle conflicts Sweep, skip?', 'Reasonable discretionary rule — not backtested in this file.'],
  ['If Doyle aligns Sweep, guaranteed win?', 'No — alignment reduces conflict, not outcome certainty.'],
  ['News events modeled?', 'No explicit calendar in Sweep export.'],
  ['Rollover modeled?', 'Continuous contract choice matters — user responsibility.'],
  ['VWAP anchor mismatch risk?', 'If your mental VWAP differs from Pine session VWAP, perceived edge shifts.'],
  ['Round 100 default for NQ?', 'Often used — tune for instrument.'],
  ['Confluence proximity 1.5 ATR — wide?', 'Can tag often — may add noise if too loose.'],
  ['Lon50 bias optional?', 'i_useLon50 default false — when on, filters sweeps by Lon50 side.'],
  ['Sweep raw dots without entry?', 'Yes — gates can block entries.'],
  ['Model decay after sweep?', 'Down-weights level scores after sweep flags — affects predictive ranking.'],
  ['Killzone definition same as yours?', 'Uses script unions — compare to your trading plan.'],
  ['Asia session clock CT?', 'Script uses Chicago hour/minute — verify vs futures session you trade.'],
  ['London window in script?', 'Defined by isLondon hours — factual from code.'],
  ['IB window?', '8:30–9:29 CT style block in script — confirm lines.'],
  ['Post-IB definition?', '9:30–14:59 CT band in script for isPostIB.'],
  ['Multiple Sweep engines on chart — which was tested?', `${M.strat} pinned for metrics — others may differ.`],
  ['Sweep v2.1 on chart too?', 'Listed in state — not the pinned strategy for these numbers unless you change pin.'],
  ['Confluence Engine v4 — overlaps Sweep?', 'Possibly visual overlap — separate codebases.'],
  ['Displacement Engine — momentum conflict?', 'Can disagree with mean-reversion sweeps — human judgment.'],
  ['FVG indicator — gap confluence?', 'Not part of Sweep core entries — optional context.'],
  ['Wick rejection ID — similar to sweep?', 'Related idea (wicks) — not identical conditions.'],
  ['Session levels extract — helps alignment?', 'If levels match Sweep’s IB/Lon/Asia, good; if not, confusion.'],
  ['Chart load / TV errors with many studies?', 'Documented risk — i_lightChart exists in Sweep to reduce plots.'],
  ['Doyle only on 5m?', 'Whatever TF your chart is — here metrics are 5m.'],
  ['Should optimization use same TF?', 'Yes for comparability.'],
  ['Walk-forward mentioned?', 'Not automated here — recommended practice.'],
  ['Monte Carlo?', 'Not in this file — advanced validation.'],
  ['Parameter grid on TV?', 'Possible — winrate-grid.mjs exists separately; not run in this answer set.'],
  ['Psychology: revenge after loss?', 'Not fixable by indicators — process.'],
  ['Psychology: overconfidence after 72% WR?', 'Dangerous — in-sample win rate.'],
  ['Risk: ignore 2-lot scale?', 'Common error — doubles equity swings vs 1-lot thinking.'],
  ['Risk: ignore commission?', 'Commission ~$' + M.comm.toFixed(2) + ' already material.'],
  ['Operational: wrong strategy selected in tester?', `Possible with ${M.cand} matches — pin substring.`],
  ['Operational: wrong symbol?', `Metrics are for ${M.sym}.`],
  ['Operational: wrong date range?', 'Check TV — epochs in JSON if needed.'],
  ['Doyle: too many zones on chart?', 'Can cause paralysis — zoom context matters.'],
  ['Sweep: too many signals with minConf 0?', 'Possible — optional minConf and gates exist to thin.'],
  ['Mitigate DD: lower size?', 'Generally reduces equity DD for same curve shape — not coded here.'],
  ['Mitigate DD: fewer trades?', 'Filters/cooldown/day cap — tradeoff vs opportunity.'],
  ['Mitigate DD: wider stops?', 'Fewer stop-outs, larger loss per loser — not free.'],
  ['Mitigate DD: tighter stops?', 'More stop-outs possible — tune with data.'],
  ['Mitigate DD: session filter only best hours?', 'Hypothesis — test; not default in Sweep.'],
  ['Common sense: trade through major news?', 'Risk — no indicator shields from events.'],
  ['Common sense: change inputs every week?', 'Breaks comparability — keep a journal.'],
  ['Edge: mean reversion at session liquidity?', 'Sweep premise — fails in trend days.'],
  ['Edge: HTF trend filter help on trend days?', 'Often reduces counter-trend sweeps when enabled.'],
  ['Edge: chop filter via ATR regime?', 'Skips dead volatility — may miss setups.'],
  ['Data: vendor differences?', 'Can change sweeps — validate on your data.'],
  ['Live: limit order fills vs backtest?', 'Predictive mode especially — validate fill assumptions.'],
  ['Live: stop hunting?', 'Slippage input approximates — not full book.'],
  ['Backtest: equity curve 0 from API?', 'Known issue sometimes — read DD in TV UI.'],
  ['Summary: one missing confluence?', 'No single answer — Doyle zones + HTF structure + news discipline are common adds OUTSIDE raw Sweep.'],
];
for (let i = 0; i < doyle.length; i++) {
  Q(61 + i, doyle[i][0], doyle[i][1]);
}

// 121–200 mechanics + discipline (template expansion)
const extra = [
  'Does Sweep use CVD?|No.',
  'Does Sweep use footprint?|No.',
  'Does Sweep use delta volume?|No.',
  'Does Sweep label BOS?|No.',
  'Does Sweep use FVG entries?|Not in core — FVG is another study on chart.',
  'Does Sweep use order blocks as entries?|Tier3 OB behind toggle display only by default.',
  'Is fib display default on?|i_showT3 default false.',
  'Does predictive need pool edge?|Only if i_predMinEdge > 0.',
  'Default pool edge threshold?|0 — off.',
  'Does model use momentum?|i_modelMomentum default true in export.',
  'Does model use VWAP tilt?|i_modelVwapTilt default true.',
  'Does model use HTF bias?|i_modelHtf default true.',
  'Are scores decayed after sweep?|Yes via swept flags and i_modelSweptDecay.',
  'Is Sweep a guarantee?|No — heuristic model.',
  'Does reactive entry use market?|strategy.entry long/short without limit on reactive path.',
  'Does predictive long use limit?|At bestLowPx per code.',
  'Exit labels xL/xS?|Bracket exits in export.',
  'Session flat label?|close_all comment Session flat.',
  'DD limit label?|close_all comment DD limit when guard triggers.',
  'Is equity DD guard optional?|i_maxDdUsd can be 0 to disable.',
  'Flatten optional?|Time inputs define behavior — flat is core to session exit group.',
  'Cooldown bars default 8?|i_cooldown default 8 in export.',
  'SL mult default 4.5?|i_slMult default 4.5.',
  'TP mult default 4.0?|i_tpMult default 4.0.',
  'ATR length default 14?|i_atrLen default 14.',
  'Round interval options include 50?|Yes in options array.',
  'Min ATR filter default 0?|Off.',
  'Quality sweep depth default 0?|Off.',
  'EMA fast/slow defaults?|9 and 21 when gate used.',
  'RSI bands wide?|Defaults allow mid-range trades when gate on.',
  'Volume mult default 1.12?|When vol gate on.',
  'ADX floor default 15?|When ADX filter on.',
  'ADX ceiling default 0?|Off.',
  'HTF options include D?|Yes in i_htfTf string options.',
  'Regime: single security call?|One request.security for HTF in export.',
  'Lon50 for sweep validity?|lon50Bull/Bear when i_useLon50.',
  'Sweep sources OR across sessions?|bullSweep combines enabled session sweeps.',
  'Bear sweep symmetric?|Parallel bear conditions for highs.',
  'Can both sweep directions matter same day?|Different bars — cooldown may separate.',
  'tradesToday reset?|On newDay.',
  'lastSig update?|On longSig/shortSig.',
  'holdSL/holdTP reset?|On flatBar or justClosed.',
  'strategy.exit naming?|xL/xS ids in export.',
  'Bar color on signal?|longSig green tint per script.',
  'bgcolor after flat?|Gray shade when pastFlat.',
  'Dashboard table optional?|i_showDashTable default true.',
  'Light chart mode?|i_lightChart reduces plot load.',
  'max_lines_count 80?|In strategy() — resource limit.',
  'Why many studies hurt?|Human overlay conflict — factual workflow issue.',
  'Journal template?|Date, CT time, side, sweep source, Doyle Y/N, outcome.',
  'Hypothesis: losses on trend days?|Test with HTF filter on vs off.',
  'Hypothesis: losses in low ADX?|Test ADX filter.',
  'Hypothesis: losses on low volume?|Test vol gate.',
  'Hypothesis: shorts worse than longs?|Export sides manually — not in auto PnL here.',
  'Mitigation: reduce contracts after DD?|Risk management outside Pine.',
  'Mitigation: pause after N losses?|Discretionary or future automation.',
  'Mitigation: align with Doyle demand for longs?|Manual rule.',
  'Mitigation: skip if inside opposing Doyle zone?|Manual rule.',
  'Error: ignoring flatten time?|Strategy models it — live must honor clock.',
  'Error: wrong timezone interpretation?|CT vs local — common mistake.',
  'Error: assuming 1 lot?|Tester used 2 contracts.',
  'Error: curve-fitting 43 trades?|High — need OOS.',
  'Final: one sentence on drawdown?|With avg loss > avg win, loss streaks drive DD — combine filters, size, and external context (Doyle, news) thoughtfully.',
  'Correlate major news to losses?|Manual annotation — not modeled in Sweep.',
  'Correlate time-of-day to PnL?|Use TV list of trades export — not automated here.',
  'Sortino vs Sharpe?|Both need clean return series — use TV or external tools.',
  'Calmar ratio?|Requires max DD — read from Strategy Tester UI if API empty.',
  'Ulcer index?|Not computed in this notepad.',
  'Export trades to CSV?|TradingView allows — do it for offline analysis.',
  'Benchmark vs buy-and-hold NQ?|Different question than edge — optional.',
  'Monte Carlo random entries?|Stress-test overfitting — optional.',
  'Define R-multiples?|Set risk $ per trade from stop distance × point value × qty.',
  'Track MAE/MFE per trade?|Not in default export — advanced journaling.',
  'Expectancy in R units?|Possible once R is defined consistently.',
  'Half-sample / half-sample test?|Simple structural OOS split — recommended.',
  'Hold out last 20% of range?|Common walk-forward simplification.',
  'Freeze parameters after OOS validation?|Reduces silent curve-fitting.',
  'Label regimes (trend/chop) manually?|Helps explain drawdown clusters.',
  'Volatility regime via ATR percentile?|Optional filter to test in isolation.',
  'Section boundary: mechanics block ends here?|Following rows continue Q201+ in same file.',
];
for (let i = 0; i < extra.length; i++) {
  const [eq, ea] = extra[i].split('|');
  Q(121 + i, eq.trim(), ea.trim());
}

// 201–250
const tail = [
  ['Does this notepad change your Pine?', 'No — documentation only.'],
  ['Re-run TV metrics command?', 'ADVISOR_STRATEGY_SUBSTRING=Sweep Engine v2.0 node src/cli/index.js data strategy'],
  ['Re-run advisor?', 'node scripts/quant-advisor.mjs'],
  ['Store env in .env?', 'ADVISOR_STRATEGY_SUBSTRING recommended with many strategies on chart.'],
  ['Doyle code in repo?', 'Not found in tradingview-mcp — cannot quote Doyle rules.'],
  ['Sweep code in repo?', 'Yes — sweep-engine-v2-export.pine.'],
  ['v61.1 vs Sweep version alignment?', 'Independent — version numbers unrelated.'],
  ['Should you read TV list of trades?', 'Yes — for ticket-level truth.'],
  ['Should you screenshot Doyle at entry?', 'Yes — for qualitative review.'],
  ['Can ML infer Doyle from chart?', 'Not done here.'],
  ['Is 72% WR sustainable live?', 'Unknown — slippage and discipline differ.'],
  ['Is PF 2.2 sustainable live?', 'Unknown — same caveat.'],
  ['Does net $5490 imply salary?', 'No — sample-specific backtest dollars.'],
  ['Account % gain?', `netProfitPercent ~${(M.net / 100000 * 100).toFixed(2)}% if initial capital 100k — verify in TV.`],
  ['initial_capital in Pine?', '100000 in export strategy() — verify.'],
  ['Does doubling capital halve %?', 'Not necessarily — position sizing is fixed qty, not %.'],
  ['Kelly sizing?', 'Not in export.'],
  ['Vol targeting?', 'Not in export.'],
  ['ATR-based sizing?', 'Not in export — fixed default_qty_value 1 per contract semantics; held 2 in test.'],
  ['Why held 2?', 'User/settings in TV strategy properties — not explained by Pine alone.'],
  ['Check qty in Strategy Tester properties?', 'Yes — factual step.'],
  ['Doyle: red/green signals — follow blindly?', 'No — confirm with your rules.'],
  ['Sweep: triangle entries always good?', 'No — visual marker ≠ guaranteed fill path in predictive mode.'],
  ['Combined: best question to ask next?', '"On losing trades, was price rejecting a Doyle supply for longs?" — log 10 examples.'],
  ['Combined: second question?', '"Were losses clustered in one week?" — check TV date distribution.'],
  ['Third question?', '"Did HTF trend oppose the sweep?" — mark manually.'],
  ['Fourth question?', '"Was ADX low?" — mark manually.'],
  ['Fifth question?', '"Was volume below average?" — mark manually.'],
  ['Sixth question?', '"Was news within 30 min?" — mark manually.'],
  ['Seventh question?', '"Was spread wide?" — mark manually.'],
  ['Eighth question?', '"Did session flat exit cause loss?" — check exit comment in list of trades.'],
  ['Ninth question?', '"Did stop exit occur?" — check STOP in order list.'],
  ['Tenth question?', '"Did TP exit occur?" — check LIMIT wins.'],
  ['Pattern: many Session flat exits?', 'Observed in order export earlier — time exit is real for this strategy.'],
  ['Does flat exit help DD?', 'Can cut both winners and losers — empirical tradeoff.'],
  ['Does DD guard help live DD?', 'If enabled in Pine — caps equity DD path in sim; live differs.'],
  ['Common sense: trade when tired?', 'Human error — outside indicators.'],
  ['Common sense: skip plan?', 'Error — indicators do not replace plan.'],
  ['Common sense: size up after win streak?', 'Often increases DD risk — caution.'],
  ['Common sense: ignore max loss day rule?', 'Risk — no indicator enforces discipline.'],
  ['Honest bottom line on confluence?', 'Sweep has built-in session + optional rounds/VWAP/Lon50 + optional regime/quality; Doyle adds visual S&D context not in Sweep math — use both with a written rule set.'],
  ['Honest bottom line on drawdown?', 'This sample shows strong net with PF>2 but avg loss > avg win — mitigate with size, filters, OOS testing, and external context; no magic add-on listed here guarantees lower DD.'],
  ['What one action improves rigor most?', 'Export TV trade list manually and tag Doyle + HTF context for each trade — turns opinion into data.'],
  ['Closing: is this financial advice?', 'No — educational Q&A from metrics + known code.'],
  ['Closing: 250th question — repeat key metric?', `Net ~$${M.net.toFixed(2)}, PF ~${M.pf.toFixed(3)}, WR ~${M.wr.toFixed(1)}%, trades ${M.tt}, ${M.win}W/${M.loss}L, 2 contracts, Doyle on chart unquantified here.`],
  ['Extra tail Q246 — re-read metrics after chart change?', 'Yes — any symbol/TF/strategy change invalidates prior numbers.'],
  ['Extra tail Q247 — save Strategy Tester screenshot?', 'Good practice for audit trail.'],
  ['Extra tail Q248 — share notepad with mentor?', 'If you want external review — not endorsement.'],
  ['Extra tail Q249 — archive this file dated?', 'Yes — metrics drift over time.'],
  ['Final reminder — regen after new TV pull?', 'Re-run node scripts/gen-doyle-sweep-250qa.mjs after refreshing Strategy Tester.'],
];
for (let i = 0; i < tail.length; i++) {
  Q(201 + i, tail[i][0], tail[i][1]);
}

// Verify count
if (QA.length !== 250) {
  console.error('Expected 250 QA, got', QA.length);
  process.exit(1);
}

for (const row of QA) {
  push(`Q${String(row.n).padStart(3, '0')}: ${row.q}`);
  push(`A${String(row.n).padStart(3, '0')}: ${row.a}`);
  push('');
}

push('='.repeat(80));
push('END — 250 Q&A complete');
push('='.repeat(80));

const dest = join(root, 'data', 'Doyle-Sweep-250QA-Notepad.txt');
writeFileSync(dest, out.join('\n'), 'utf8');
console.log('Wrote', dest);
