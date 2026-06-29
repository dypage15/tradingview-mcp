/**
 * Quantitative analysis + lightweight "memory" for scripts/quant-advisor.mjs.
 * Pure functions — no TradingView I/O.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** Best-effort PnL from a TV trade object (field names vary by locale/build). */
export function extractPnl(trade) {
  if (!trade || typeof trade !== 'object') return null;
  const candidates = [
    'profit', 'netProfit', 'netprofit', 'pnl', 'PL', 'pl', 'grossProfit',
    'profitNet', 'tradeProfit', 'value',
  ];
  for (const k of candidates) {
    if (k in trade && typeof trade[k] === 'number' && !Number.isNaN(trade[k])) return trade[k];
  }
  for (const key of Object.keys(trade)) {
    const low = key.toLowerCase();
    if (!/(profit|pnl|net|pl|gain|loss)/i.test(low)) continue;
    const v = trade[key];
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  }
  return null;
}

export function inferSide(trade) {
  if (!trade || typeof trade !== 'object') return 'unknown';
  const raw = `${trade.side ?? ''} ${trade.type ?? ''} ${trade.direction ?? ''} ${trade.text ?? ''}`.toLowerCase();
  if (/\blong\b|\bbuy\b|bull/.test(raw)) return 'long';
  if (/\bshort\b|\bsell\b|bear/.test(raw)) return 'short';
  const n = Number(trade.size ?? trade.qty ?? trade.quantity);
  if (n > 0) return 'long';
  if (n < 0) return 'short';
  return 'unknown';
}

export function analyzeTrades(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const pnls = [];
  const bySide = { long: [], short: [], unknown: [] };

  for (const t of list) {
    const p = extractPnl(t);
    const side = inferSide(t);
    if (p !== null) pnls.push(p);
    if (p !== null) bySide[side]?.push(p);
  }

  const n = pnls.length;
  if (n === 0) {
    return {
      tradeRows: list.length,
      nWithPnl: 0,
      winRate: null,
      profitFactor: null,
      expectancy: null,
      grossProfit: null,
      grossLoss: null,
      avgWin: null,
      avgLoss: null,
      maxConsecLosses: null,
      maxConsecWins: null,
      bestTrade: null,
      worstTrade: null,
      pnlStdDev: null,
      longShort: { long: 0, short: 0, unknown: 0, sumLong: null, sumShort: null },
      note: 'No numeric PnL fields found on trades — TV may use different keys; advisor still uses strategy metrics.',
    };
  }

  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = losses.reduce((a, b) => a + b, 0);

  const winRate = wins.length / n;
  const profitFactor = grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? Infinity : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = pnls.reduce((a, b) => a + b, 0) / n;

  let cl = 0;
  let cw = 0;
  let maxCL = 0;
  let maxCW = 0;
  for (const p of pnls) {
    if (p < 0) {
      cl += 1;
      cw = 0;
      maxCL = Math.max(maxCL, cl);
    } else if (p > 0) {
      cw += 1;
      cl = 0;
      maxCW = Math.max(maxCW, cw);
    }
  }

  const mean = expectancy;
  const variance = n > 1 ? pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / (n - 1) : 0;
  const pnlStdDev = Math.sqrt(Math.max(0, variance));

  const sum = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) : null);

  return {
    tradeRows: list.length,
    nWithPnl: n,
    winRate,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
    expectancy,
    grossProfit,
    grossLoss,
    avgWin: wins.length ? avgWin : null,
    avgLoss: losses.length ? avgLoss : null,
    maxConsecLosses: maxCL,
    maxConsecWins: maxCW,
    bestTrade: Math.max(...pnls),
    worstTrade: Math.min(...pnls),
    pnlStdDev,
    longShort: {
      long: bySide.long.length,
      short: bySide.short.length,
      unknown: bySide.unknown.length,
      sumLong: sum(bySide.long),
      sumShort: sum(bySide.short),
    },
    note: null,
  };
}

function num(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

/** Pull common strategy metrics into a flat, numeric-friendly object. */
export function normalizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') {
      const n = parseFloat(v.replace(/[^0-9.\-]/g, ''));
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

export function pickKey(obj, patterns) {
  const keys = Object.keys(obj);
  for (const p of patterns) {
    const hit = keys.find((k) => p.test(k));
    if (hit !== undefined) return obj[hit];
  }
  return null;
}

/** Dollar drawdown only — avoid matching maxStrategyDrawDownPercent. */
function extractMaxDdDollars(m) {
  if (!m || typeof m !== 'object') return null;
  const direct = num(m.maxStrategyDrawDown) ?? num(m.maxDrawdown);
  if (direct !== null) return direct;
  for (const key of Object.keys(m)) {
    if (!/drawdown/i.test(key) || /percent/i.test(key)) continue;
    if (/^max/i.test(key) || /strategy.*drawdown/i.test(key)) {
      const v = num(m[key]);
      if (v !== null) return v;
    }
  }
  return null;
}

export function summarizeMetrics(m) {
  const net =
    num(pickKey(m, [/^netProfit$/i, /^net_profit$/i, /net.*profit/i])) ??
    num(m.netProfit) ??
    num(m.netprofit);
  const dd = extractMaxDdDollars(m);
  const ddPct =
    num(pickKey(m, [/maxStrategyDrawDownPercent/i])) ?? num(m.maxStrategyDrawDownPercent);
  const pf = num(pickKey(m, [/profitFactor/i, /^profit.*factor$/i])) ?? num(m.profitFactor);
  const wr = num(pickKey(m, [/percentProfitable/i, /win.*rate/i, /^percent.*profitable$/i]));
  const trades = num(pickKey(m, [/totalTrades/i, /^trades$/i, /total.*trade/i]));
  const sharpe = num(pickKey(m, [/sharpe/i, /sortino/i]));

  const cap = Number(process.env.ADVISOR_INITIAL_CAPITAL || 100000);
  let ddUsdEst =
    num(pickKey(m, [/^maxStrategyDrawDown$/i])) ?? num(m.maxStrategyDrawDown);
  if ((ddUsdEst === null || ddUsdEst === undefined) && ddPct !== null && cap > 0) {
    ddUsdEst = (cap * Math.abs(ddPct)) / 100;
  }

  return {
    netProfit: net,
    maxDrawdown: dd,
    profitFactor: pf,
    percentProfitable: wr,
    totalTrades: trades,
    sharpe,
    maxStrategyDrawDownPercent: ddPct,
    estimatedMaxDdUsd: ddUsdEst,
  };
}

function equityMaxDrawdown(equityData) {
  if (!Array.isArray(equityData) || equityData.length < 2) return null;
  let peak = -Infinity;
  let maxDd = 0;
  for (const row of equityData) {
    const eq = row.equity ?? row.value ?? row[1];
    if (typeof eq !== 'number' || !Number.isFinite(eq)) continue;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

export function analyzeEquity(equityPayload) {
  const data = equityPayload?.data;
  if (!Array.isArray(data) || data.length === 0) {
    return { curvePoints: 0, equityMaxDrawdownFrac: null };
  }
  return {
    curvePoints: data.length,
    equityMaxDrawdownFrac: equityMaxDrawdown(data),
  };
}

/**
 * Last N net-profit snapshots for this chart (from JSONL memory). Excludes the run about to be appended.
 */
export function memoryTrendForChart(memoryRows, chartKey, maxRuns = 10) {
  const same = memoryRows.filter((r) => r.chartKey === chartKey);
  const nets = same
    .slice(-maxRuns)
    .map((r) => r.metricsSummary?.netProfit)
    .filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (nets.length === 0) {
    return {
      runCount: same.length,
      sampleSize: 0,
      nets: [],
      avgNet: null,
      direction: null,
      netDelta: null,
    };
  }
  const avgNet = nets.reduce((a, b) => a + b, 0) / nets.length;
  let direction = null;
  let netDelta = null;
  if (nets.length >= 2) {
    const first = nets[0];
    const last = nets[nets.length - 1];
    netDelta = last - first;
    if (last > first * 1.08) direction = 'up';
    else if (last < first * 0.92) direction = 'down';
    else direction = 'flat';
  }
  return {
    runCount: same.length,
    sampleSize: nets.length,
    nets,
    avgNet,
    direction,
    netDelta,
    firstNet: nets[0],
    lastNet: nets[nets.length - 1],
  };
}

/**
 * Concrete next steps derived from rule codes (for JSON consumers + UI).
 */
export function buildSuggestedActions(priorities) {
  const codes = new Set(priorities.map((p) => p.code));
  const actions = [];
  if (codes.has('DD_CAP') || codes.has('HIGH_DD_PCT')) {
    actions.push({
      kind: 'grid',
      title: 'Constrain drawdown in search',
      detail:
        'Set GRID_OBJECTIVE=net_dd, tune GRID_DD_WEIGHT, and use GRID_MAX_DD_USD or GRID_MAX_DD_PCT (see winrate-grid.mjs). Match GRID_INITIAL_CAPITAL to strategy().',
    });
  }
  if (codes.has('NEG_NET') || codes.has('PF_LT_1')) {
    actions.push({
      kind: 'research',
      title: 'Treat edge as unproven on this window',
      detail: 'Narrow session filters, raise quality gates, or re-test a different date range before sizing up.',
    });
  }
  if (codes.has('LOW_TRADES_STAT')) {
    actions.push({
      kind: 'sample',
      title: 'Increase statistical power',
      detail: 'Extend backtest range, relax a single filter, or accept that conclusions are fragile with few fills.',
    });
  }
  if (codes.has('STREAK') || codes.has('NEG_EXPECT')) {
    actions.push({
      kind: 'risk',
      title: 'Stress-test loss clusters',
      detail: 'Review cooldown, SL×ATR, and max trades/day; consider regime filter (HTF/ATR/ADX) in Sweep v2.',
    });
  }
  if (codes.has('SIDE_SKEW')) {
    actions.push({
      kind: 'bias',
      title: 'Check directional bias',
      detail: 'Disable the weak side temporarily or verify the symbol regime matches the strategy.',
    });
  }
  if (codes.has('TRADE_EXPORT_GAP')) {
    actions.push({
      kind: 'data',
      title: 'Fix trade export parsing',
      detail: 'TV locale may hide PnL fields — advisor still uses Strategy Tester metrics; compare win rate vs trade list manually once.',
    });
  }
  if (codes.has('MEMORY_TREND')) {
    actions.push({
      kind: 'memory',
      title: 'Stabilize before trusting changes',
      detail: 'Net profit drifting across runs on the same chart — freeze inputs and confirm date range/symbol.',
    });
  }
  if (actions.length === 0) {
    actions.push({
      kind: 'general',
      title: 'Walk-forward or hold-out test',
      detail: 'No severe flags — validate on unseen data and track MEMORY deltas when you change inputs.',
    });
  }
  return actions;
}

/**
 * Rule-based recommendations with explicit numeric thresholds (transparent "quant" logic).
 */
export function buildRecommendations({ tradeStats, metricsSummary, equityInfo, memoryDelta, memoryTrend }) {
  const lines = [];
  const pri = [];

  const pf = metricsSummary.profitFactor;
  const net = metricsSummary.netProfit;
  const wr = metricsSummary.percentProfitable;
  const tExp = tradeStats.expectancy;
  const tpf = tradeStats.profitFactor;
  const minTrades = Number(process.env.ADVISOR_MIN_TRADES || 15);
  const warnDdPct = Number(process.env.ADVISOR_WARN_DD_PCT || 5);
  const ddPct = metricsSummary.maxStrategyDrawDownPercent;

  const totalT = metricsSummary.totalTrades;
  if (minTrades > 0 && totalT !== null && typeof totalT === 'number' && totalT < minTrades) {
    pri.push({
      level: 'medium',
      code: 'LOW_TRADES_STAT',
      text: `Only ${totalT} trades in report (threshold ${minTrades}) — statistics are noisy; set ADVISOR_MIN_TRADES=0 to silence.`,
    });
  }

  if (tradeStats.tradeRows > 0 && tradeStats.nWithPnl === 0) {
    pri.push({
      level: 'low',
      code: 'TRADE_EXPORT_GAP',
      text: `Exported ${tradeStats.tradeRows} trade rows but none had parseable PnL — per-trade stats unavailable (locale/API).`,
    });
  }

  if (net !== null && net < 0) {
    pri.push({ level: 'high', code: 'NEG_NET', text: `Net profit is negative (${net.toFixed(2)}). Edge may be absent on this sample — verify sample size and regime.` });
  }
  if (pf !== null && pf < 1) {
    pri.push({ level: 'high', code: 'PF_LT_1', text: `Profit factor ${pf.toFixed(3)} < 1 — gross losses dominate gross wins at the strategy level.` });
  }
  if (wr !== null && wr < 0.4 && pf !== null && pf >= 1) {
    pri.push({ level: 'medium', code: 'LOW_WR_HIGH_PF', text: `Win rate ${(wr * 100).toFixed(1)}% is low while PF ≥ 1 — expectancy likely comes from skewed payoffs; watch tail losses.` });
  }
  if (tExp !== null && tExp < 0 && tradeStats.nWithPnl > 3) {
    pri.push({ level: 'high', code: 'NEG_EXPECT', text: `Sample per-trade expectancy from exported trades is ${tExp.toFixed(4)} (on ${tradeStats.nWithPnl} trades with PnL).` });
  }
  if (tpf !== null && tpf < 1 && tradeStats.nWithPnl > 3) {
    pri.push({ level: 'medium', code: 'TRADE_PF', text: `Trade-list profit factor ≈ ${tpf.toFixed(3)} — aligns with reviewing losers vs winners.` });
  }
  if (tradeStats.maxConsecLosses !== null && tradeStats.maxConsecLosses >= 5) {
    pri.push({ level: 'medium', code: 'STREAK', text: `Max consecutive losing trades in sample: ${tradeStats.maxConsecLosses} — size or cooldown may need stress-testing.` });
  }

  const { sumLong, sumShort, long, short } = tradeStats.longShort || {};
  if (sumLong !== null && sumShort !== null && long + short > 3) {
    const dom = Math.abs(sumLong) >= Math.abs(sumShort) ? 'long' : 'short';
    const ratio = Math.abs(sumLong - sumShort) / (Math.abs(sumLong) + Math.abs(sumShort) + 1e-9);
    if (ratio > 0.45) {
      pri.push({
        level: 'low',
        code: 'SIDE_SKEW',
        text: `PnL skew: ${dom}-biased in this export (long sum ${sumLong?.toFixed?.(2) ?? 'n/a'} vs short ${sumShort?.toFixed?.(2) ?? 'n/a'}).`,
      });
    }
  }

  if (equityInfo.equityMaxDrawdownFrac !== null && equityInfo.equityMaxDrawdownFrac > 0.2) {
    pri.push({
      level: 'medium',
      code: 'EQ_DD',
      text: `Approx equity curve max drawdown from peak ~${(equityInfo.equityMaxDrawdownFrac * 100).toFixed(1)}% (from ${equityInfo.curvePoints} points).`,
    });
  }

  const advDdCap = Number(process.env.ADVISOR_MAX_DD_USD || 0);
  const ddUsd = metricsSummary.estimatedMaxDdUsd;
  if (advDdCap > 0 && ddUsd !== null && typeof ddUsd === 'number' && Number.isFinite(ddUsd) && ddUsd > advDdCap) {
    pri.push({
      level: 'high',
      code: 'DD_CAP',
      text: `Estimated Strategy Tester max DD (~$${ddUsd.toFixed(2)}) exceeds ADVISOR_MAX_DD_USD (${advDdCap}). Tighten params, raise capital in env for fair compare, or align Pine i_maxDdUsd.`,
    });
  } else if (warnDdPct > 0 && ddPct !== null && typeof ddPct === 'number' && Number.isFinite(ddPct) && ddPct > warnDdPct) {
    pri.push({
      level: 'medium',
      code: 'HIGH_DD_PCT',
      text: `Strategy Tester max DD ${ddPct.toFixed(2)}% exceeds ADVISOR_WARN_DD_PCT (${warnDdPct}) — consider net_dd grid or tighter risk inputs.`,
    });
  }

  const sharpe = metricsSummary.sharpe;
  if (sharpe !== null && typeof sharpe === 'number' && Number.isFinite(sharpe) && sharpe < 0 && net !== null && net > 0) {
    pri.push({
      level: 'low',
      code: 'SHARPE_NEG',
      text: `Sharpe ${sharpe.toFixed(3)} is negative while net profit > 0 — volatile path; check drawdown depth vs return.`,
    });
  }

  if (memoryTrend?.direction === 'down' && memoryTrend.sampleSize >= 3) {
    pri.push({
      level: 'medium',
      code: 'MEMORY_TREND',
      text: `Net profit on this chart slipped over the last ${memoryTrend.sampleSize} saved runs (${memoryTrend.firstNet?.toFixed?.(2)} → ${memoryTrend.lastNet?.toFixed?.(2)}).`,
    });
  }

  if (memoryDelta?.netChangePct !== null && memoryDelta.prevNet !== null) {
    const pct = memoryDelta.netChangePct;
    const dir = pct > 0 ? 'improved' : 'worsened';
    pri.push({
      level: Math.abs(pct) > 15 ? 'medium' : 'low',
      code: 'MEMORY',
      text: `Vs last saved snapshot on this chart: net profit ${dir} by ${Math.abs(pct).toFixed(1)}% (was ${memoryDelta.prevNet?.toFixed?.(2)}, now ${memoryDelta.nowNet?.toFixed?.(2)}).`,
    });
  }

  pri.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.level] - order[b.level];
  });

  for (const p of pri) lines.push(`[${p.level.toUpperCase()}] ${p.text}`);

  if (lines.length === 0) {
    lines.push('[INFO] No hard flags from default quantitative rules — still review OOS / walk-forward.');
  }

  const suggested_actions = buildSuggestedActions(pri);

  return { priorities: pri, advisorLines: lines, suggested_actions: suggested_actions };
}

function fmtNum(n, digits = 4) {
  if (n === null || n === undefined || typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  const d = Math.abs(n) >= 1000 ? 2 : digits;
  return n.toFixed(d);
}

/**
 * Structured package for an external LLM (Cursor, API): quant facts + constraints + paste-ready user message.
 * Keeps numbers verbatim from the script (no hallucinated metrics).
 */
export function buildLlmBrief({
  chart,
  tv_strategy,
  metricsSummary,
  tradeStats,
  equityInfo,
  memory,
  quantitative,
  advisor,
}) {
  const facts = [
    `Symbol ${chart.symbol}  timeframe ${chart.resolution}`,
    tv_strategy
      ? `TV strategy read: ${tv_strategy.strategy_name ?? 'n/a'} (candidates on chart: ${tv_strategy.candidate_count ?? 'n/a'})${tv_strategy.pick_note ? ` — ${tv_strategy.pick_note}` : ''}`
      : `TV strategy read: not attached to this brief — if numbers mismatch Strategy Tester, set ADVISOR_STRATEGY_SUBSTRING`,
    `Net profit (strategy): ${fmtNum(metricsSummary.netProfit, 2)}`,
    `Profit factor: ${fmtNum(metricsSummary.profitFactor)}`,
    `Percent profitable (strategy): ${metricsSummary.percentProfitable == null ? 'n/a' : `${(metricsSummary.percentProfitable * 100).toFixed(2)}%`}`,
    `Total trades (strategy): ${metricsSummary.totalTrades == null ? 'n/a' : String(metricsSummary.totalTrades)}`,
    `Max drawdown (raw metric): ${fmtNum(metricsSummary.maxDrawdown, 4)}`,
    `Max DD % (tester): ${metricsSummary.maxStrategyDrawDownPercent == null ? 'n/a' : fmtNum(metricsSummary.maxStrategyDrawDownPercent, 4) + '%'}`,
    `Estimated max DD $ (from tester $ or % × ADVISOR_INITIAL_CAPITAL): ${metricsSummary.estimatedMaxDdUsd == null ? 'n/a' : fmtNum(metricsSummary.estimatedMaxDdUsd, 2)}`,
    `Trade export: rows=${tradeStats.tradeRows} with PnL fields=${tradeStats.nWithPnl}`,
    tradeStats.nWithPnl > 0
      ? `Per-trade sample: winRate=${tradeStats.winRate == null ? 'n/a' : fmtNum(tradeStats.winRate * 100, 2) + '%'} expectancy=${fmtNum(tradeStats.expectancy)} tradePF=${tradeStats.profitFactor == null ? 'n/a' : fmtNum(tradeStats.profitFactor)}`
      : 'Per-trade PnL not available in export — interpret using strategy-level metrics only.',
    `Equity curve points: ${equityInfo.curvePoints}${equityInfo.equityMaxDrawdownFrac != null ? `; approx max DD from curve ${(equityInfo.equityMaxDrawdownFrac * 100).toFixed(2)}%` : ''}`,
  ];

  if (!memory?.skipped && memory?.delta?.netChangePct != null && memory.delta.prevNet != null) {
    facts.push(
      `Memory vs prior snapshot on this chart: net change ${fmtNum(memory.delta.netChangePct, 2)}% (prev ${fmtNum(memory.delta.prevNet, 2)} → now ${fmtNum(memory.delta.nowNet, 2)})`
    );
  }

  if (memory?.trend && memory.trend.sampleSize >= 2) {
    facts.push(
      `Memory trend (${memory.trend.sampleSize} runs): direction=${memory.trend.direction ?? 'n/a'} first=${fmtNum(memory.trend.firstNet, 2)} last=${fmtNum(memory.trend.lastNet, 2)} avg=${fmtNum(memory.trend.avgNet, 2)}`
    );
  }

  const codes = advisor.priorities.map((p) => p.code).join(', ') || 'none';

  const actionLines =
    (advisor.suggested_actions || []).length > 0
      ? [
          '',
          '--- SUGGESTED ACTIONS ---',
          ...advisor.suggested_actions.map((a) => `• [${a.kind}] ${a.title}: ${a.detail}`),
        ]
      : [];

  const user_message = [
    'You are assisting with strategy review. A local Node script pulled these numbers from TradingView (Strategy Tester).',
    'Rules: do not invent statistics. If a value is n/a, acknowledge gap. Ground reasoning in the facts and priority codes.',
    '',
    '--- QUANT FACTS ---',
    ...facts.map((f) => `• ${f}`),
    '',
    '--- RULE ENGINE FLAGS (codes) ---',
    codes,
    '',
    '--- FLAG DETAIL ---',
    ...advisor.priorities.map((p) => `[${p.level}] ${p.code}: ${p.text}`),
    ...actionLines,
    '',
    '--- REQUEST ---',
    'Respond with: (1) Two to four sentences interpreting edge vs noise for this sample.',
    '(2) Top risks (numbered).',
    '(3) Two or three specific next experiments (parameters, session filter, walk-forward, or risk) tied to the codes above.',
    '(4) If trade-level PnL was missing, say what you cannot conclude from trades alone.',
    '(5) If suggested_actions are present in the JSON, reference at least one.',
  ].join('\n');

  const followups = [
    'Does the story from net profit match profit factor and win rate?',
    'If code MEMORY fired, what changed in the run (inputs, date range, symbol) before trusting the delta?',
    'What single filter would most reduce tail losses given SIDE_SKEW or STREAK codes?',
  ];
  if ((advisor.suggested_actions || []).length) {
    followups.push('Which suggested_actions row (grid / risk / sample) matches your next step?');
  }
  if (advisor.priorities.some((p) => p.code === 'DD_CAP' || p.code === 'HIGH_DD_PCT')) {
    followups.push('Does estimatedMaxDdUsd align with GRID_MAX_DD_USD when re-optimizing?');
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    tv_strategy: tv_strategy || null,
    model_role:
      'Quantitative strategy advisor. Interpret only the supplied numbers; flag uncertainty where data is missing.',
    constraints: [
      'Do not fabricate or adjust metrics — all figures come from the quant-advisor script + TradingView.',
      'When nWithPnl is 0, do not infer per-trade statistics.',
      'Distinguish backtest noise from structural issues; suggest validation steps.',
      'If DD_CAP code appears, compare estimatedMaxDdUsd to the user risk cap; grid search can use GRID_MAX_DD_USD / GRID_MAX_DD_PCT in winrate-grid.mjs.',
    ],
    quant_facts: facts,
    priority_codes: advisor.priorities.map((p) => p.code),
    priorities: advisor.priorities,
    quantitative,
    user_message,
    suggested_actions: advisor.suggested_actions || [],
    suggested_followups: followups,
  };
}

export function chartKey(state) {
  const sym = state?.symbol ?? state?.Symbol ?? '';
  const res = state?.resolution ?? state?.interval ?? '';
  return `${sym}|${res}`;
}

export function loadMemory(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip bad line */
    }
  }
  return rows;
}

export function compareToLastMemory(memoryRows, key, nowNet) {
  const same = memoryRows.filter((r) => r.chartKey === key);
  if (same.length === 0 || nowNet === null || typeof nowNet !== 'number') {
    return { netChangePct: null, prevNet: null, nowNet };
  }
  const prev = same[same.length - 1];
  const pNet = prev?.metricsSummary?.netProfit;
  if (typeof pNet !== 'number' || !Number.isFinite(pNet) || pNet === 0) {
    return { netChangePct: null, prevNet: pNet ?? null, nowNet };
  }
  return {
    netChangePct: ((nowNet - pNet) / Math.abs(pNet)) * 100,
    prevNet: pNet,
    nowNet,
  };
}

export function appendMemoryRecord(path, record) {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}
