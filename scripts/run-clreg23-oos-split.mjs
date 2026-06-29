#!/usr/bin/env node
/**
 * Out-of-sample split on ClReg2.3 best spec — 70% train / 30% test by calendar time.
 * Uses Strategy Tester trade list when available; falls back to full-window metrics only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect, evaluate, KNOWN_PATHS } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as indicators from '../src/core/indicators.js';
import * as ui from '../src/core/ui.js';
import { parseTradeLogTable } from './clreg22-grid-utils.mjs';

const ROOT = process.cwd();
const TRAIN_FRAC = Number(process.env.CLREG23_OOS_TRAIN_FRAC ?? 0.7);
const TF = process.env.TV_BACKTEST_TIMEFRAME || '5';

process.env.ADVISOR_STRATEGY_SUBSTRING = 'v2.3';
process.env.TV_MAX_TRADES_HARD_CAP = process.env.TV_MAX_TRADES_HARD_CAP || '600';

const BEST = {
  rsiMode: 'Combined',
  rsiLen: 6,
  confLookback: 3,
  cloudSmooth: 3,
  minBarsBetween: 0,
  minCloudSep: 0,
  riskMode: 'Points',
  tpPoints: 30,
  slPoints: 15,
};

function specToInputs(spec) {
  return {
    in_0: 9,
    in_1: 21,
    in_2: 50,
    in_3: spec.cloudSmooth,
    in_4: spec.rsiLen,
    in_6: spec.rsiMode,
    in_7: 30,
    in_8: 70,
    in_9: 5,
    in_10: spec.tpPoints,
    in_11: spec.slPoints,
    in_12: false,
    in_14: spec.confLookback,
    in_15: 0,
    in_16: 0,
    in_24: 'Points',
  };
}

function pickEntity(state) {
  const forced = (process.env.CLREG22_ENTITY_ID || '').trim();
  if (forced) return forced;
  const hits = (state.studies || []).filter((s) => /v2\.3|ClReg2\.3/i.test(s.name || ''));
  if (!hits.length) throw new Error('ClReg2.3 not on chart');
  return hits[hits.length - 1].id;
}

/** Pair Strategy Tester orders (e=true entry, e=false exit) into round trips. */
function pairOrders(orders) {
  const rounds = [];
  let open = null;
  for (const o of orders) {
    if (o.e === true) {
      open = o;
    } else if (o.e === false && open) {
      const id = String(open.id || '');
      const isLong = /long/i.test(id) && !/short/i.test(id);
      const pts = isLong ? Number(o.p) - Number(open.p) : Number(open.p) - Number(o.p);
      rounds.push({ pts, seq: Number(o.tm ?? rounds.length) });
      open = null;
    }
  }
  return rounds;
}

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

function splitByIndex(rounds, frac) {
  const n = rounds.length;
  const cut = Math.floor(n * frac);
  const trainPnls = rounds.slice(0, cut).map((r) => r.pts);
  const testPnls = rounds.slice(cut).map((r) => r.pts);
  return { train: metricsFromPnls(trainPnls), test: metricsFromPnls(testPnls), cut_index: cut, total_rounds: n };
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
    if (/v2\\.3|ClReg2\\.3/i.test(n)) { strat = s; break; }
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
const entityId = pickEntity(state0);

await indicators.setInputs({
  entity_id: entityId,
  inputs: JSON.stringify(specToInputs(BEST)),
  persist_layout: true,
});
await sleep(12000);
await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5 }).catch(() => {});

const strat = await data.getStrategyResults();
const m = strat.metrics || {};
const dr = m.settings?.dateRange?.trade || m.settings?.dateRange?.backtest;
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

if (closed.length >= 40) {
  train = sliceByTime(closed, fromMs, splitMs);
  test = sliceByTime(closed, splitMs, toMs + 86400000);
  method = `calendar_${Math.round(TRAIN_FRAC * 100)}pct_train_by_exit_time`;
  splitDetail = { report_trades: closed.length, train_trades: train.trades, test_trades: test.trades };
} else {
  const tradesResp = await data.getTrades({ max_trades: 600 });
  const rounds = pairOrders(tradesResp.trades || []);
  if (rounds.length >= 40) {
    splitDetail = splitByIndex(rounds, TRAIN_FRAC);
    train = splitDetail.train;
    test = splitDetail.test;
    method = 'sequential_fallback';
  } else {
    const tbl = await data.getPineTables({ study_filter: 'v2.3' });
    const log = parseTradeLogTable(tbl);
    const pnls = (log.trades || []).map((t) => t.pts).filter((x) => Number.isFinite(x));
    if (pnls.length >= 20) {
      const cut = Math.floor(pnls.length * TRAIN_FRAC);
      train = metricsFromPnls(pnls.slice(0, cut));
      test = metricsFromPnls(pnls.slice(cut));
      method = 'pine_trade_log_partial';
      splitDetail = { cut_index: cut, total: pnls.length };
    } else {
      method = 'insufficient_trade_data';
      train = { trades: m.totalTrades, netProfit: m.netProfit, profitFactor: m.profitFactor };
      test = { ...train, note: 'no split' };
    }
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(ROOT, 'data', 'grid_runs', `clreg23_oos_${stamp}`);
mkdirSync(runDir, { recursive: true });

const oosPass =
  test &&
  test.trades >= 15 &&
  test.profitFactor >= 1.0 &&
  test.netProfit > 0;

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
  oos_pass: oosPass,
  split_detail: splitDetail,
  report_trades_used: closed.length,
};

writeFileSync(join(runDir, 'oos_report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await disconnect().catch(() => {});
