/**
 * Sequential MCP sweep: for tf in 1..250, chart_set_timeframe(tf) then data_get_strategy_results.
 * Uses official MCP client + stdio server (same handlers as Cursor call_mcp_tool).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function parseToolResult(toolResult) {
  const text = toolResult?.content?.[0]?.text;
  if (!text) return { _parseError: 'no text content in tool result' };
  try {
    return JSON.parse(text);
  } catch (e) {
    return { _parseError: e.message, _raw: text };
  }
}

async function callJson(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return parseToolResult(r);
}

function isSuccessRow(data) {
  if (!data || data._parseError) return false;
  if (data.success === false) return false;
  if (data.error) return false;
  const m = data.metrics;
  if (!m || typeof m !== 'object') return false;
  if (typeof m.netProfit !== 'number' || Number.isNaN(m.netProfit)) return false;
  return true;
}

function rankKey(row) {
  const np = row.netProfit;
  const pf = row.profitFactor ?? -Infinity;
  const gl = Math.abs(row.grossLoss ?? 0);
  return [-np, -pf, gl];
}

function compareRows(a, b) {
  const ka = rankKey(a);
  const kb = rankKey(b);
  for (let i = 0; i < 3; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return Number(a.timeframe) - Number(b.timeframe);
}

function num(x, d = 4) {
  if (x === null || x === undefined || typeof x !== 'number' || Number.isNaN(x)) return 'n/a';
  return x.toFixed(d);
}

function pct(x) {
  if (x === null || x === undefined || typeof x !== 'number' || Number.isNaN(x)) return 'n/a';
  return `${(x * 100).toFixed(2)}%`;
}

function buildQa100(successful, failed, best, aggregates) {
  const lines = [];
  const S = successful.length;
  const F = failed.length;
  const worst = successful.length
    ? [...successful].sort((a, b) => a.netProfit - b.netProfit)[0]
    : null;
  const q = (n, question, answer) => {
    lines.push(`Q${n}: ${question}`);
    lines.push(`A${n}: ${answer}`);
    lines.push('');
  };

  q(1, 'How many scenarios completed successfully out of 250?', `${S} of 250 scenarios returned valid strategy metrics (numeric net profit).`);
  q(2, 'How many scenarios failed?', `${F} scenarios did not yield usable metrics (see Failed list in report).`);
  q(3, 'Which single timeframe was best under the stated ranking rule?', best
    ? `Timeframe ${best.timeframe} minutes with net profit ${num(best.netProfit, 2)} USD, profit factor ${num(best.profitFactor, 6)}, and gross loss magnitude ${num(Math.abs(best.grossLoss), 2)} USD.`
    : 'No successful scenario; cannot name a best timeframe.');
  q(4, 'What was the optimization ranking priority?', 'Highest net profit, then highest profit factor, then lower implied drawdown proxy abs(grossLoss).');
  q(5, 'What symbol and chart type were enforced at the start?', 'Symbol CME_MINI:MNQ1! and chart type Candles (per run preamble).');
  q(6, 'Which strategy study did the MCP pick for metrics?', best?.strategy_name
    ? `Reported strategy_name: ${best.strategy_name} (TV Secondary filter default unless overridden by env).`
    : 'See per-row strategy_name in raw JSON when present.');
  q(7, 'What was the worst net profit among successful runs?', worst ? `${num(worst.netProfit, 2)} USD at timeframe ${worst.timeframe}.` : 'N/A — no successful rows.');
  q(8, 'What was the median net profit across successes?', aggregates.medianNet != null ? `${num(aggregates.medianNet, 2)} USD.` : 'N/A.');
  q(9, 'What was the mean net profit across successes?', aggregates.meanNet != null ? `${num(aggregates.meanNet, 2)} USD.` : 'N/A.');
  q(10, 'What was the maximum profit factor observed?', aggregates.maxPf != null ? `${num(aggregates.maxPf, 6)}.` : 'N/A.');
  q(11, 'At which timeframe did maximum profit factor occur?', aggregates.maxPfTf != null ? `Timeframe ${aggregates.maxPfTf}.` : 'N/A.');
  q(12, 'What was the minimum profit factor among successes?', aggregates.minPf != null ? `${num(aggregates.minPf, 6)}.` : 'N/A.');
  q(13, 'How many successful scenarios had net profit greater than zero?', `${aggregates.countPositiveNp} of ${S}.`);
  q(14, 'How many successful scenarios had net profit less than or equal to zero?', `${aggregates.countNonPositiveNp} of ${S}.`);
  q(15, 'What was the largest gross profit among successes?', aggregates.maxGrossProfit != null ? `${num(aggregates.maxGrossProfit, 2)} USD (tf ${aggregates.maxGrossProfitTf}).` : 'N/A.');
  q(16, 'What was the smallest gross loss magnitude (abs(grossLoss)) among successes?', aggregates.minAbsGl != null ? `${num(aggregates.minAbsGl, 2)} USD (tf ${aggregates.minAbsGlTf}).` : 'N/A.');
  q(17, 'What was the largest gross loss magnitude among successes?', aggregates.maxAbsGl != null ? `${num(aggregates.maxAbsGl, 2)} USD (tf ${aggregates.maxAbsGlTf}).` : 'N/A.');
  q(18, 'What maxContractsHeld value appeared in successful runs?', aggregates.uniqueMch.length ? `Observed: ${aggregates.uniqueMch.join(', ')}.` : 'N/A.');
  q(19, 'Did any timeframe show maxContractsHeld above 2?', aggregates.mchAbove2 ? 'Yes, at least one successful row reported maxContractsHeld > 2.' : 'No successful row in this sweep reported maxContractsHeld > 2.');
  q(20, 'What was the highest totalTrades count among successes?', aggregates.maxTrades != null ? `${aggregates.maxTrades} trades (tf ${aggregates.maxTradesTf}).` : 'N/A.');
  q(21, 'What was the lowest totalTrades count among successes?', aggregates.minTrades != null ? `${aggregates.minTrades} trades (tf ${aggregates.minTradesTf}).` : 'N/A.');
  q(22, 'What was the median totalTrades?', aggregates.medianTrades != null ? `${num(aggregates.medianTrades, 0)} trades.` : 'N/A.');
  q(23, 'Which timeframe had the best percentProfitable?', aggregates.bestPctTf != null ? `Timeframe ${aggregates.bestPctTf} with ${pct(aggregates.bestPctVal)}.` : 'N/A.');
  q(24, 'Which timeframe had the worst percentProfitable among successes?', aggregates.worstPctTf != null ? `Timeframe ${aggregates.worstPctTf} with ${pct(aggregates.worstPctVal)}.` : 'N/A.');
  q(25, 'Does a higher net profit always imply a higher profit factor in this sweep?', aggregates.npPfAligned === true
    ? `In this sweep the top net-profit timeframe (${best?.timeframe}) also had the maximum observed profit factor (${num(aggregates.maxPf, 6)}).`
    : aggregates.npPfAligned === false
      ? `No — the net-profit leader is timeframe ${best?.timeframe} (PF ${num(best?.profitFactor, 6)}) while the maximum profit factor ${num(aggregates.maxPf, 6)} occurred at timeframe ${aggregates.maxPfTf}.`
      : best
        ? 'Could not compare — maximum profit factor timeframe was not available from the successful rows.'
        : 'N/A — no successful rows.');
  q(26, 'What practical lesson comes from grossProfit vs grossLoss?', 'Net profit equals gross profit minus gross loss (and costs); large gross profit with large gross loss can still yield moderate net profit.');
  q(27, 'Should you trust a single best timeframe without forward testing?', 'No — treat the best timeframe as a hypothesis; validate with out-of-sample, walk-forward, and realistic slippage/fees.');
  q(28, 'Why might some timeframes fail to return metrics?', 'Empty reportData, strategy still calculating, Strategy Tester closed, or no strategy on chart — failed rows list reasons when available.');
  q(29, 'Was batch_run used for ranking?', 'No. Ranking uses only direct sequential MCP tool results from this script.');
  q(30, 'What does abs(grossLoss) proxy here?', 'A rough scale of losing-side gross PnL magnitude; it is not max drawdown from equity curve.');
  q(31, 'If two rows tie on net profit, how is the tie broken?', 'Higher profit factor wins; if still tied, lower abs(grossLoss) wins.');
  q(32, 'What commission assumption is embedded in these metrics?', 'Whatever commission is configured in TradingView Strategy Tester / symbol settings at run time; not overridden by this script.');
  q(33, 'Does changing timeframe change the backtest date range?', 'Often yes — visible history and default tester windows can shift with bar duration; compare date ranges in metrics.settings if present in exports.');
  q(34, 'Is the best timeframe always the most active (most trades)?', best && aggregates.maxTradesTf != null
    ? (best.timeframe === aggregates.maxTradesTf
      ? `Yes in this sweep — the net-profit leader (tf ${best.timeframe}) also had the highest totalTrades (${aggregates.maxTrades}).`
      : `No — net-profit leader is tf ${best.timeframe} while the highest totalTrades (${aggregates.maxTrades}) occurred at tf ${aggregates.maxTradesTf}.`)
    : 'N/A.');
  q(35, 'What is a sensible next step after picking timeframe 5 (if it ranks first)?', 'Run walk-forward on adjacent timeframes (4, 6, 8) and stress-test parameters held fixed.');
  q(36, 'How sensitive is net profit to timeframe in the observed range?', `Spread of net profit from ${num(aggregates.minNet, 2)} to ${num(aggregates.maxNet, 2)} USD across successes.`);
  q(37, 'What is the interquartile sense of net profit?', aggregates.q1Net != null ? `Approx Q1 ${num(aggregates.q1Net, 2)}, Q3 ${num(aggregates.q3Net, 2)} USD (simple quartiles on sorted nets).` : 'N/A.');
  q(38, 'Did we validate Strategy Tester was open?', 'ui_open_panel(strategy-tester, open) is invoked once at the start of the run.');
  q(39, 'Why sequential calls?', 'To mirror manual optimization and avoid batch runner quirks with Strategy Tester visibility.');
  q(40, 'Can results differ if rerun?', 'Yes — chart loading, tester completion timing, and session state can shift slightly; rerun for reproducibility logging.');
  q(41, 'What does maxContractsHeld measure?', 'Maximum concurrent contracts the backtest held per reported tester stats — useful for sizing review.');
  q(42, 'Is percentProfitable the same as win rate by count?', 'It is the percentage of winning trades in the sample; verify against totalTrades in the same row.');
  q(43, 'Should you optimize only net profit?', 'No — also consider profit factor, trade count, and stability; your scoring already blends net profit and profit factor.');
  q(44, 'What if grossLoss is very large but net profit is high?', 'You are carrying large loser-side gross; risk controls and tail loss matter even if net is positive.');
  q(45, 'What is a red flag in the top-20 table?', 'Very few trades with high net profit — can be statistical noise; prefer adequate sample size.');
  q(46, 'What is a green flag in the top-20 table?', 'Reasonable trade count, solid profit factor, and net profit not entirely from one outlier bar.');
  q(47, 'Does this sweep tune strategy inputs?', 'No — only chart timeframe (resolution) was swept; strategy inputs stayed as on chart unless manually changed.');
  q(48, 'Can you compare 1m vs 5m fairly?', 'Only with aligned tester settings and awareness that bar count and noise differ; use same date mode when possible.');
  q(49, 'What role does MNQ continuous contract play?', 'Continuations can splice sessions; ensure your contract roll rules match what you trade live.');
  q(50, 'What is the best way to document this run?', 'Keep this report, raw JSON, TradingView layout export, and screenshot of tester settings.');
  q(51, 'How to use totalTrades in decision-making?', 'Higher trades can mean more statistical confidence but also more commission drag — compare commissionPaid if exported.');
  q(52, 'What does profit factor below 1 imply?', 'Gross losses dominate gross profits; such rows should not be candidates unless data error.');
  q(53, 'Are there scenarios with profit factor above 2?', (aggregates.countPfAbove2 ?? 0) > 0
    ? `Yes — ${aggregates.countPfAbove2} successful scenario(s) had profit factor > 2 (max PF ${num(aggregates.maxPf, 4)}).`
    : `No — max profit factor in this sweep was ${aggregates.maxPf != null ? num(aggregates.maxPf, 4) : 'n/a'}.`);
  q(54, 'What timeframe cluster should you forward-test if top is 5m?', 'Forward-test 3, 4, 5, 6, 7 to see local robustness around the peak.');
  q(55, 'Why include abs(grossLoss) in ranking?', 'As a tie-breaker when net profit and profit factor match — prefers smaller loser-side gross magnitude among ties.');
  q(56, 'Is the equity curve analyzed here?', 'Not automatically — this sweep used summary metrics; add data_get_equity for curve review in a follow-up.');
  q(57, 'What is the average winning trade size proxy on the best row?', best?.avgWinTrade != null ? `avgWinTrade ≈ ${num(best.avgWinTrade, 2)} USD (if present in metrics).` : 'avgWinTrade not stored in slim row; see raw JSON if captured.');
  q(58, 'What is the average losing trade size proxy on the best row?', best?.avgLosTrade != null ? `avgLosTrade ≈ ${num(best.avgLosTrade, 2)} USD.` : 'See raw JSON for full metrics on best timeframe.');
  q(59, 'Did we export average trade stats for every row?', 'Slim rows focus on required fields; full tool JSON includes more metrics when needed.');
  q(60, 'How to reduce overfitting risk?', 'Hold out recent months, cross-validate sessions, and avoid cherry-picking only the peak bar duration.');
  q(61, 'What execution stat best complements net profit?', 'Profit factor and total trades together — one scales payoff quality, the other sample breadth.');
  q(62, 'Should you trade the exact top timeframe in live markets?', 'Only after execution model (latency, fills) is validated; backtest fills differ from live.');
  q(63, 'What does a failed scenario imply for trading?', 'Nothing definitive — it usually means metrics could not be read, not that the timeframe is invalid forever.');
  q(64, 'How to retry failed timeframes?', 'Re-open Strategy Tester, wait for calculation, rerun individual chart_set_timeframe + data_get_strategy_results.');
  q(65, 'What is the standard deviation of net profit (rough)?', aggregates.stdNet != null ? `${num(aggregates.stdNet, 2)} USD.` : 'N/A.');
  q(66, 'What fraction of successes fall within one std of mean?', aggregates.within1std != null ? `Approximately ${aggregates.within1std} of ${S} (rule-of-thumb).` : 'N/A.');
  q(67, 'Which is more stable: few large wins or many small wins?', 'Assess largestWinTrade vs numberOfWiningTrades in raw metrics — concentration risk differs.');
  q(68, 'Does this report include margin calls?', 'If marginCalls appears in raw metrics for a row, check JSON; not always in slim table.');
  q(69, 'What is the best practical use of top-20?', 'Shortlist bar durations for deeper analysis and forward testing rather than immediate go-live.');
  q(70, 'How to combine with CBC + MMT v4 context?', 'Treat companion indicator as regime filter — timeframe choice should be validated when those signals are stable.');
  q(71, 'What session effects could bias results?', 'Overnight vs RTH differs; verify tester session settings match how you trade MNQ.');
  q(72, 'What is the smallest net profit among successes?', aggregates.minNet != null ? `${num(aggregates.minNet, 2)} USD.` : 'N/A.');
  q(73, 'What is the largest net profit among successes?', aggregates.maxNet != null ? `${num(aggregates.maxNet, 2)} USD.` : 'N/A.');
  q(74, 'Are results gross or net of commission?', 'netProfit is net; grossProfit/grossLoss are gross components before netting (commissionPaid may appear separately in full metrics).');
  q(75, 'What to do if profit factor is high but net profit is moderate?', 'Check scale — smaller position or fewer trades can yield high PF with moderate net; align with capital goals.');
  q(76, 'What to do if net profit is high but profit factor is low?', 'Loss side is large relative to wins — risk management and tail losses need review.');
  q(77, 'How many top-20 slots should be forward-tested?', 'At minimum test the best plus two neighbors of bar duration (e.g., ±1–2 minutes or scale).');
  q(78, 'What chart resolution is most likely to overfit noise?', 'Very low minute counts can increase trade count and noise — compare with slippage sensitivity.');
  q(79, 'What is a good sanity check on percentProfitable?', 'Cross-check numberOfWiningTrades / totalTrades against percentProfitable for rounding.');
  q(80, 'Why track both grossProfit and grossLoss?', 'They explain how net arises and expose whether edge is from few big winners or broad consistency.');
  q(81, 'Is deep backtesting required?', 'For production confidence, deep backtesting and sufficient history often help — especially on futures.');
  q(82, 'What limitation does this sweep have by design?', 'It only scans bar duration, not full input hyperparameter space of the strategy.');
  q(83, 'How to extend this work?', 'Add sweeps on risk inputs, session filters, and CBC companion settings with the same reporting discipline.');
  q(84, 'What does candidate_count in tool output mean?', 'How many strategy-like sources were considered when picking Secondary — useful if pick looks wrong.');
  q(85, 'What does pick_note mean?', 'Optional disambiguation note from the picker — see raw JSON when non-null.');
  q(86, 'Should you export trades for the best timeframe?', 'Yes — data_get_trades on that resolution validates trade list plausibility.');
  q(87, 'What is the role of commissionPaid in review?', 'Compare across timeframes — higher trade counts often raise commission drag.');
  q(88, 'How to interpret largestWinTrade vs largestLosTrade?', 'Tail events — ensure they are plausible and not data glitches.');
  q(89, 'What market regime risk applies?', 'A single historical window may favor one bar size; multi-regime testing reduces this.');
  q(90, 'What is the minimum trades for basic confidence?', best
    ? `Rule of thumb: dozens+ for rough stability; the current best row shows totalTrades=${best.totalTrades} — treat as moderate sample size and still forward-test.`
    : 'N/A — no best row.');
  q(91, 'Does this sweep set orders to market or limit?', 'Execution assumptions are whatever the strategy uses in Pine — not changed here.');
  q(92, 'What file preserves raw numbers?', 'MNQ_sweep_mcp_raw.json alongside this report.');
  q(93, 'Can you automate this without MCP?', 'Core library could be called directly, but this run used MCP tools for strict compliance.');
  q(94, 'What is the single most important metric for go/no-go?', 'No single metric — net profit with profit factor and adequate trade count is a practical triad.');
  q(95, 'What follow-up metric should you add next?', 'Max drawdown from equity curve and recovery factor — not fully captured by abs(grossLoss).');
  q(96, 'Why might two adjacent timeframes differ sharply?', 'Bar alignment changes signal timing, trade count, and whipsaw characteristics.');
  q(97, 'What does a flat equity curve on the best tf imply?', 'Not assessed here — pull equity series after selecting finalists.');
  q(98, 'How to report to a risk manager?', 'Give best tf, net, PF, trade count, max contracts, and date range of the tester window.');
  q(99, 'Final practical recommendation in one line?', best
    ? `Forward-test timeframe ${best.timeframe} with documented fills/slippage and confirm maxContractsHeld matches your live sizing cap.`
    : 'Fix tester visibility and rerun until successes exist before forward testing.');
  q(100, 'What question should you ask after reading all 99 answers?', 'Do these in-sample results still hold on unseen future data at acceptable drawdown — and did position sizing tests via MCP change maxContractsHeld? See contract section.');

  return lines.join('\n');
}

function computeAggregates(successful) {
  const nets = successful.map((r) => r.netProfit).sort((a, b) => a - b);
  const meanNet = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : null;
  const medianNet = nets.length
    ? (nets.length % 2 === 1
      ? nets[(nets.length - 1) / 2]
      : (nets[nets.length / 2 - 1] + nets[nets.length / 2]) / 2)
    : null;
  const minNet = nets.length ? nets[0] : null;
  const maxNet = nets.length ? nets[nets.length - 1] : null;
  let maxPf = -Infinity;
  let maxPfTf = null;
  let minPf = Infinity;
  let minPfTf = null;
  for (const r of successful) {
    const pf = r.profitFactor;
    if (typeof pf === 'number' && !Number.isNaN(pf)) {
      if (pf > maxPf) {
        maxPf = pf;
        maxPfTf = r.timeframe;
      }
      if (pf < minPf) {
        minPf = pf;
        minPfTf = r.timeframe;
      }
    }
  }
  if (maxPf === -Infinity) {
    maxPf = null;
    maxPfTf = null;
  }
  if (minPf === Infinity) {
    minPf = null;
    minPfTf = null;
  }
  const countPositiveNp = successful.filter((r) => r.netProfit > 0).length;
  const countNonPositiveNp = successful.length - countPositiveNp;
  let maxGrossProfit = null;
  let maxGrossProfitTf = null;
  let maxAbsGl = null;
  let maxAbsGlTf = null;
  let minAbsGl = null;
  let minAbsGlTf = null;
  for (const r of successful) {
    if (typeof r.grossProfit === 'number') {
      if (maxGrossProfit == null || r.grossProfit > maxGrossProfit) {
        maxGrossProfit = r.grossProfit;
        maxGrossProfitTf = r.timeframe;
      }
    }
    const agl = Math.abs(r.grossLoss ?? 0);
    if (maxAbsGl == null || agl > maxAbsGl) {
      maxAbsGl = agl;
      maxAbsGlTf = r.timeframe;
    }
    if (minAbsGl == null || agl < minAbsGl) {
      minAbsGl = agl;
      minAbsGlTf = r.timeframe;
    }
  }
  const trades = successful.map((r) => r.totalTrades).filter((t) => typeof t === 'number');
  const sortedTrades = [...trades].sort((a, b) => a - b);
  const medianTrades = sortedTrades.length
    ? (sortedTrades.length % 2 === 1
      ? sortedTrades[(sortedTrades.length - 1) / 2]
      : (sortedTrades[sortedTrades.length / 2 - 1] + sortedTrades[sortedTrades.length / 2]) / 2)
    : null;
  let maxTrades = null;
  let maxTradesTf = null;
  let minTrades = null;
  let minTradesTf = null;
  for (const r of successful) {
    if (typeof r.totalTrades === 'number') {
      if (maxTrades == null || r.totalTrades > maxTrades) {
        maxTrades = r.totalTrades;
        maxTradesTf = r.timeframe;
      }
      if (minTrades == null || r.totalTrades < minTrades) {
        minTrades = r.totalTrades;
        minTradesTf = r.timeframe;
      }
    }
  }
  let bestPctTf = null;
  let bestPctVal = null;
  let worstPctTf = null;
  let worstPctVal = null;
  for (const r of successful) {
    const p = r.percentProfitable;
    if (typeof p !== 'number') continue;
    if (bestPctVal == null || p > bestPctVal) {
      bestPctVal = p;
      bestPctTf = r.timeframe;
    }
    if (worstPctVal == null || p < worstPctVal) {
      worstPctVal = p;
      worstPctTf = r.timeframe;
    }
  }
  const uniqueMch = [...new Set(successful.map((r) => r.maxContractsHeld).filter((x) => x != null))].sort((a, b) => a - b);
  const mchAbove2 = successful.some((r) => typeof r.maxContractsHeld === 'number' && r.maxContractsHeld > 2);
  const q1Net = nets.length ? nets[Math.floor(0.25 * (nets.length - 1))] : null;
  const q3Net = nets.length ? nets[Math.floor(0.75 * (nets.length - 1))] : null;
  const variance = nets.length > 1 && meanNet != null ? nets.reduce((a, b) => a + (b - meanNet) ** 2, 0) / (nets.length - 1) : null;
  const stdNet = variance != null && variance >= 0 ? Math.sqrt(variance) : null;
  const within1std = meanNet != null && stdNet != null && stdNet > 0
    ? nets.filter((n) => Math.abs(n - meanNet) <= stdNet).length
    : null;
  const countPfAbove2 = successful.filter((r) => typeof r.profitFactor === 'number' && r.profitFactor > 2).length;

  return {
    meanNet,
    medianNet,
    minNet,
    maxNet,
    maxPf,
    maxPfTf,
    minPf,
    minPfTf,
    countPositiveNp,
    countNonPositiveNp,
    maxGrossProfit,
    maxGrossProfitTf,
    maxAbsGl,
    maxAbsGlTf,
    minAbsGl,
    minAbsGlTf,
    uniqueMch,
    mchAbove2,
    medianTrades,
    maxTrades,
    maxTradesTf,
    minTrades,
    minTradesTf,
    bestPctTf,
    bestPctVal,
    worstPctTf,
    worstPctVal,
    q1Net,
    q3Net,
    stdNet,
    within1std,
    countPfAbove2,
  };
}

function buildFullReportText({
  timestamp,
  successful,
  failed,
  top20,
  best,
  aggregates,
  contractSection,
}) {
  const S = successful.length;
  const F = failed.length;
  const lines = [];
  lines.push('MNQ Strategy Optimization Results (strict sequential MCP sweep)');
  lines.push(`Timestamp: ${timestamp}`);
  lines.push('');
  lines.push('=== Sweep method ===');
  lines.push('For each timeframe string "1" through "250": MCP tool chart_set_timeframe(timeframe) then data_get_strategy_results().');
  lines.push('Implemented via official MCP stdio client to tradingview-mcp server (same handlers as Cursor user-tradingview MCP).');
  lines.push('batch_run was NOT used for ranking.');
  lines.push('Preamble: chart_set_symbol(CME_MINI:MNQ1!), chart_set_type(Candles), ui_open_panel(strategy-tester, open).');
  lines.push('');
  lines.push('=== Success / failure counts ===');
  lines.push(`Successful scenarios (valid net profit metric): ${S} / 250`);
  lines.push(`Failed or unusable scenarios: ${F} / 250`);
  lines.push('');
  lines.push('=== Best single scenario (ranking: max netProfit, then max profitFactor, then min abs(grossLoss)) ===');
  if (best) {
    lines.push(`timeframe: ${best.timeframe}`);
    lines.push(`netProfit: ${best.netProfit}`);
    lines.push(`profitFactor: ${best.profitFactor}`);
    lines.push(`maxContractsHeld: ${best.maxContractsHeld}`);
    lines.push(`totalTrades: ${best.totalTrades}`);
    lines.push(`percentProfitable: ${best.percentProfitable}`);
    lines.push(`grossProfit: ${best.grossProfit}`);
    lines.push(`grossLoss: ${best.grossLoss}`);
    lines.push(`strategy_name: ${best.strategy_name || 'n/a'}`);
  } else {
    lines.push('No successful scenario.');
  }
  lines.push('');
  lines.push('=== Top 20 scenarios ===');
  lines.push('Rank | timeframe | netProfit | profitFactor | maxContractsHeld | totalTrades | percentProfitable | grossProfit | grossLoss');
  top20.forEach((r, i) => {
    lines.push(`${i + 1} | ${r.timeframe} | ${num(r.netProfit, 2)} | ${num(r.profitFactor, 6)} | ${r.maxContractsHeld} | ${r.totalTrades} | ${pct(r.percentProfitable)} | ${num(r.grossProfit, 2)} | ${num(r.grossLoss, 2)}`);
  });
  lines.push('');
  lines.push('=== Failed timeframes ===');
  if (failed.length === 0) {
    lines.push('None.');
  } else {
    failed.forEach((f) => {
      lines.push(`timeframe ${f.timeframe}: ${f.reason}`);
    });
  }
  lines.push('');
  lines.push('=== Position sizing via MCP (3–4 contracts target) ===');
  lines.push(contractSection);
  lines.push('');
  lines.push('=== Optimization Q&A (100 items) ===');
  lines.push(buildQa100(successful, failed, best, aggregates));
  lines.push('');
  lines.push('=== Raw data ===');
  lines.push('Full per-scenario rows and failures: C:\\Users\\dypag\\MNQ_sweep_mcp_raw.json');
  return lines.join('\n');
}

// --- main ---
const timestamp = new Date().toString();

const transport = new StdioClientTransport({
  command: 'node',
  args: [join(ROOT, 'src/server.js')],
  cwd: ROOT,
});

const client = new Client({ name: 'mnq-sweep-250', version: '1.0.0' });
await client.connect(transport);

const slimRow = (data, tf) => {
  const m = data.metrics || {};
  return {
    timeframe: tf,
    netProfit: m.netProfit,
    profitFactor: m.profitFactor,
    maxContractsHeld: m.maxContractsHeld,
    totalTrades: m.totalTrades,
    percentProfitable: m.percentProfitable,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    strategy_name: data.strategy_name,
    avgWinTrade: m.avgWinTrade,
    avgLosTrade: m.avgLosTrade,
  };
};

await callJson(client, 'chart_set_symbol', { symbol: 'CME_MINI:MNQ1!' });
await callJson(client, 'chart_set_type', { chart_type: 'Candles' });
await callJson(client, 'ui_open_panel', { panel: 'strategy-tester', action: 'open' });
await new Promise((r) => setTimeout(r, 400));

const successful = [];
const failed = [];

for (let tf = 1; tf <= 250; tf++) {
  const s = String(tf);
  const setRes = await callJson(client, 'chart_set_timeframe', { timeframe: s });
  if (setRes._parseError) {
    failed.push({ timeframe: s, reason: `chart_set_timeframe: ${setRes._parseError}` });
    continue;
  }
  if (setRes.success === false) {
    failed.push({ timeframe: s, reason: `chart_set_timeframe: ${setRes.error || 'failed'}` });
    continue;
  }
  const data = await callJson(client, 'data_get_strategy_results', {});
  if (isSuccessRow(data)) {
    successful.push(slimRow(data, s));
  } else {
    const reason = data.error
      || data.hint
      || (data.metric_count === 0 ? 'empty or incomplete strategy metrics (report not ready or no strategy)' : 'could not parse net profit')
      || data._parseError
      || 'unknown';
    failed.push({ timeframe: s, reason: String(reason) });
  }
}

const sorted = [...successful].sort(compareRows);
const best = sorted[0] || null;
const top20 = sorted.slice(0, 20);
const aggregates = computeAggregates(successful);
aggregates.npPfAligned = best == null
  ? null
  : aggregates.maxPfTf == null
    ? null
    : aggregates.maxPfTf === best.timeframe;

// Contract sizing attempts via MCP
const keys = ['contracts', 'qty', 'quantity', 'default_qty_value', 'order_size', 'positionSize', 'lots', 'tradeSize'];
let m0 = null;
if (best) {
  await callJson(client, 'chart_set_timeframe', { timeframe: best.timeframe });
  const maxBefore = await callJson(client, 'data_get_strategy_results', {});
  m0 = maxBefore.metrics?.maxContractsHeld;
}
const attemptLines = [];
for (const k of keys) {
  const ir = await callJson(client, 'indicator_set_inputs', {
    entity_id: 'KdTSP2',
    inputs: JSON.stringify({ [k]: 4 }),
    persist_layout: false,
  });
  const updated = ir.updated_inputs ?? ir.updatedInputs ?? {};
  attemptLines.push(`indicator_set_inputs KdTSP2 ${k}=4 -> updated_inputs: ${JSON.stringify(updated)}`);
}
if (best) {
  await callJson(client, 'chart_set_timeframe', { timeframe: best.timeframe });
}
const after = await callJson(client, 'data_get_strategy_results', {});
const m1 = after.metrics?.maxContractsHeld;

const contractSection = [
  `Entity tested: KdTSP2 (Sweep Engine v2.0 — Secondary).`,
  `maxContractsHeld before attempts (on best tf ${best?.timeframe ?? 'n/a'}): ${m0 ?? 'n/a'}`,
  ...attemptLines,
  `maxContractsHeld after all attempts: ${m1 ?? 'n/a'}`,
  m1 === m0 || (m0 == null && m1 == null)
    ? 'Conclusion: MCP indicator_set_inputs did not change maxContractsHeld with the tested common keys; position size likely not exposed under those input IDs or is fixed in script.'
    : 'Conclusion: maxContractsHeld changed — review updated_inputs and strategy inputs in TradingView UI.',
].join('\n');

const report = buildFullReportText({
  timestamp,
  successful,
  failed,
  top20,
  best,
  aggregates,
  contractSection,
});

writeFileSync('C:\\Users\\dypag\\MNQ_sweep_mcp_raw.json', JSON.stringify({
  generatedAt: timestamp,
  successCount: successful.length,
  failedCount: failed.length,
  successful,
  failed,
  top20,
  best,
  aggregates,
}, null, 2));

const reportOut = report
  .replace(/\u2014/g, ' - ')
  .replace(/\u2013/g, '-')
  .replace(/\u201c|\u201d/g, '"');
writeFileSync('C:\\Users\\dypag\\MNQ_strategy_optimization_results.txt', reportOut, 'utf8');

await client.close();
console.log(JSON.stringify({ ok: true, successCount: successful.length, failedCount: failed.length, bestTf: best?.timeframe ?? null }, null, 2));
