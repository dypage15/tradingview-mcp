#!/usr/bin/env node
/**
 * Out-of-sample split for Cloud Regime v3 Full Stack — 70% train / 30% test.
 * Includes research table snapshot + strategy trade OOS.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect, evaluate, KNOWN_PATHS } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as indicators from '../src/core/indicators.js';
import * as ui from '../src/core/ui.js';
import {
  CR3_DEFAULT_SPEC,
  parseResearchTable,
  pickCr3Entity,
  randomEntryBaseline,
  specToInputs,
} from './cr3-grid-utils.mjs';

const ROOT = process.cwd();
const TRAIN_FRAC = Number(process.env.CR3_OOS_TRAIN_FRAC ?? 0.7);
const TF = process.env.TV_BACKTEST_TIMEFRAME || '5';

process.env.ADVISOR_STRATEGY_SUBSTRING = process.env.ADVISOR_STRATEGY_SUBSTRING || 'Full Stack';

const BEST = { ...CR3_DEFAULT_SPEC };

function metricsFromPnls(pnls) {
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const net = pnls.reduce((a, b) => a + b, 0);
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return {
    trades: pnls.length,
    netProfit: net,
    profitFactor: pf,
    percentProfitable: pnls.length ? (wins.length / pnls.length) * 100 : 0,
    expectancy: pnls.length ? net / pnls.length : NaN,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHART_API = KNOWN_PATHS.chartApi;

async function fetchReportTrades() {
  return evaluate(`
(function() {
  var chart = ${CHART_API}._chartWidget;
  var sources = chart.model().model().dataSources();
  var strat = null;
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    if (!s || !s.metaInfo) continue;
    var n = (s.metaInfo().description || s.metaInfo().shortDescription || '');
    if (/Full Stack|CR_v3|Cloud Regime v3/i.test(n) && !/v2\\./i.test(n)) { strat = s; break; }
  }
  if (!strat) return { trades: [], error: 'no strat' };
  var rd = strat.reportData ? (typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData) : null;
  if (rd && typeof rd.value === 'function') rd = rd.value();
  var trades = rd && rd.trades ? (typeof rd.trades.value === 'function' ? rd.trades.value() : rd.trades) : [];
  if (!Array.isArray(trades)) return { trades: [], error: 'no trades array' };
  var out = [];
  for (var t = 0; t < trades.length; t++) {
    var tr = trades[t];
    var exitTm = tr.x && tr.x.tm != null ? tr.x.tm : null;
    var pnl = tr.tp && tr.tp.v != null ? tr.tp.v : null;
    if (exitTm != null && pnl != null) out.push({ exitMs: exitTm, pnl: pnl });
  }
  return { trades: out, count: out.length };
})()
`);
}

function sliceByTime(trades, fromMs, toMs) {
  const pnls = trades
    .filter((t) => t.exitMs >= fromMs && t.exitMs < toMs)
    .map((t) => t.pnl)
    .filter((x) => Number.isFinite(x));
  return metricsFromPnls(pnls);
}

await health.healthCheck();
let state0 = await chart.getState();
if (String(state0.resolution) !== String(TF)) {
  await chart.setTimeframe({ timeframe: TF });
  await sleep(2000);
}
const entityId = pickCr3Entity(state0);

await indicators.setInputs({
  entity_id: entityId,
  inputs: JSON.stringify(specToInputs(BEST)),
  persist_layout: true,
});
await sleep(12000);
await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5 }).catch(() => {});

const strat = await data.getStrategyResults();
const m = strat.metrics || {};
const dr = m.settings?.dateRange?.trade?.from
  ? m.settings.dateRange.trade
  : m.settings?.dateRange?.backtest;
if (!dr?.from || !dr?.to) {
  console.error('No date range on strategy metrics');
  process.exit(1);
}

const fromMs = dr.from;
const toMs = dr.to;
const splitMs = fromMs + (toMs - fromMs) * TRAIN_FRAC;

const reportTrades = await fetchReportTrades();
const closed = reportTrades.trades || [];

let train = null;
let test = null;
let method = 'calendar_split_by_exit_time';
let splitDetail = null;

if (closed.length >= 20) {
  train = sliceByTime(closed, fromMs, splitMs);
  test = sliceByTime(closed, splitMs, toMs + 86400000);
  method = `calendar_${Math.round(TRAIN_FRAC * 100)}pct_train_by_exit_time`;
  splitDetail = { report_trades: closed.length, train_trades: train.trades, test_trades: test.trades };
} else {
  method = 'insufficient_trade_data';
  train = { trades: m.totalTrades, netProfit: m.netProfit, profitFactor: m.profitFactor };
  test = { ...train, note: 'no split — fewer than 20 closed trades' };
}

const research = parseResearchTable(
  await data.getPineTables({ study_filter: process.env.ADVISOR_STRATEGY_SUBSTRING }),
);

const trainTestRatio =
  train?.netProfit && test?.netProfit && train.netProfit !== 0
    ? test.netProfit / train.netProfit
    : null;

const oosWithin80Pct =
  train?.profitFactor > 0 && test?.profitFactor > 0
    ? test.profitFactor >= train.profitFactor * 0.8
    : null;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(ROOT, 'data', 'grid_runs', `cr3_oos_${stamp}`);
mkdirSync(runDir, { recursive: true });

const baseline = randomEntryBaseline({
  tradeCount: Math.max(m.totalTrades ?? 0, 100),
  tpPts: BEST.tpPoints,
  slPts: BEST.slPoints,
});

const report = {
  run_directory: runDir,
  method,
  spec: BEST,
  entity_id: entityId,
  symbol: state0.symbol,
  timeframe: TF,
  date_range: {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    split: new Date(splitMs).toISOString(),
    train_frac: TRAIN_FRAC,
  },
  full_window: {
    trades: m.totalTrades,
    netProfit: m.netProfit,
    profitFactor: m.profitFactor,
    percentProfitable: m.percentProfitable,
  },
  train,
  test,
  oos_within_80pct_pf: oosWithin80Pct,
  train_test_net_ratio: trainTestRatio,
  research_buckets_full_window: research.buckets || [],
  research_best_bucket: research.bestByWin || null,
  random_baseline: baseline,
  split_detail: splitDetail,
  report_trades_used: closed.length,
};

writeFileSync(join(runDir, 'oos_report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await disconnect().catch(() => {});
