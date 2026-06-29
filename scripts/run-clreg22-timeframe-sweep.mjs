#!/usr/bin/env node
/**
 * Sweep timeframes for ClReg2.2 with optimized settings (net profit ranking).
 *
 * Env:
 *   CLREG22_TF_LIST=1,3,5,10,15,30,60
 *   CLREG22_TF_DELAY_MS=10000
 *   CLREG22_ENTITY_ID=goylrR
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect } from '../src/connection.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as indicators from '../src/core/indicators.js';
import * as ui from '../src/core/ui.js';

const ROOT = process.cwd();
const DELAY_MS = Number(process.env.CLREG22_TF_DELAY_MS ?? 12000);
const MIN_TRADES = Number(process.env.CLREG22_MIN_TRADES ?? 20);
const TFS = (process.env.CLREG22_TF_LIST || '1,3,5,10,15,30,60').split(',').map((s) => s.trim());

// Grid winner (MNQ 5m) — override via env JSON if needed
const BEST = process.env.CLREG22_BEST_SPEC
  ? JSON.parse(process.env.CLREG22_BEST_SPEC)
  : {
      rsiMode: 'Combined',
      rsiLen: 6,
      confLookback: 3,
      tpPoints: 30,
      slPoints: 15,
      cloudSmooth: 3,
    };

if (!process.env.ADVISOR_STRATEGY_SUBSTRING) {
  process.env.ADVISOR_STRATEGY_SUBSTRING = 'v2.2';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  };
}

function calendarDays(m) {
  const tw = m?.settings?.dateRange?.trade;
  if (!tw?.from || !tw?.to) return NaN;
  return Math.max((tw.to - tw.from) / 86400000, 1e-6);
}

async function pollResults() {
  for (let i = 0; i < 15; i++) {
    await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 2, pause_ms: 300 }).catch(() => {});
    const strat = await data.getStrategyResults();
    const m = strat.metrics || {};
    if (strat.report_ready || (m.totalTrades ?? 0) > 0) return strat;
    if (Object.keys(m).length > 15) return strat;
    await sleep(600);
  }
  return data.getStrategyResults();
}

function pickEntity(state) {
  const forced = (process.env.CLREG22_ENTITY_ID || '').trim();
  if (forced) return forced;
  const hit = (state.studies || []).find((s) => /v2\.2|ClReg2\.2/i.test(s.name || ''));
  if (!hit?.id) throw new Error('ClReg2.2 not on chart');
  return hit.id;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(ROOT, 'data', 'grid_runs', `clreg22_tf_${stamp}`);
mkdirSync(runDir, { recursive: true });

const state0 = await chart.getState();
const entityId = pickEntity(state0);
console.error(`[tf-sweep] symbol=${state0.symbol} entity=${entityId} spec=`, BEST);

await indicators.setInputs({
  entity_id: entityId,
  inputs: JSON.stringify(specToInputs(BEST)),
  persist_layout: true,
});
await sleep(2000);

const rows = [];

for (const tf of TFS) {
  process.stderr.write(`\r[tf-sweep] ${tf} (${rows.length + 1}/${TFS.length})   `);
  const row = { timeframe: tf, error: null };
  try {
    await chart.setTimeframe({ timeframe: tf });
    await sleep(DELAY_MS);
    const strat = await pollResults();
    const m = strat.metrics || {};
    const days = calendarDays(m);
    const trades = m.totalTrades ?? 0;
    const wrRaw = m.percentProfitable ?? 0;
    row.symbol = (await chart.getState()).symbol;
    row.totalTrades = trades;
    row.percentProfitable = wrRaw <= 1 && wrRaw >= 0 ? wrRaw * 100 : wrRaw;
    row.profitFactor = m.profitFactor ?? 0;
    row.netProfit = m.netProfit ?? 0;
    row.expectancy = trades > 0 ? (m.netProfit ?? 0) / trades : NaN;
    row.avgTrade = m.avgTrade ?? row.expectancy;
    row.grossProfit = m.grossProfit ?? 0;
    row.grossLoss = m.grossLoss ?? 0;
    row.calendarDays = days;
    row.tradesPerDay = days > 0 ? trades / days : NaN;
    row.netPerDay = days > 0 ? row.netProfit / days : NaN;
    row.metConstraint = trades >= MIN_TRADES && row.profitFactor >= 1 && row.netProfit > 0;
    row.score =
      row.metConstraint
        ? row.netProfit * 0.05 + row.profitFactor * 3 + Math.log1p(trades) * 2 + (row.netPerDay ?? 0) * 0.5
        : row.netProfit * 0.02 + row.profitFactor - 1000;
  } catch (e) {
    row.error = e.message || String(e);
    row.score = -Infinity;
  }
  rows.push(row);
}

rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
const feasible = rows.filter((r) => r.metConstraint);
const byNet = [...rows].filter((r) => r.totalTrades >= MIN_TRADES).sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0));

const summary = {
  run_directory: runDir,
  symbol: state0.symbol,
  spec: BEST,
  timeframes_tested: TFS,
  feasible_count: feasible.length,
  best_by_net_profit: byNet[0] ?? null,
  best_feasible_score: feasible[0] ?? null,
  ranking_by_net: byNet.slice(0, 8).map((r) => ({
    tf: r.timeframe,
    net: r.netProfit,
    pf: r.profitFactor,
    wr: r.percentProfitable,
    trades: r.totalTrades,
    tradesPerDay: r.tradesPerDay,
    netPerDay: r.netPerDay,
    feasible: r.metConstraint,
  })),
  all_rows: rows,
  note: 'Cloud flip strategies need enough bars for EMA cloud; very low TFs = noise, very high = few flips.',
};

writeFileSync(join(runDir, 'timeframe_sweep.json'), JSON.stringify(summary, null, 2));
console.error('\n[tf-sweep] done');
console.log(JSON.stringify(summary.ranking_by_net, null, 2));
await disconnect().catch(() => {});
