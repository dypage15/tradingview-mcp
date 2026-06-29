#!/usr/bin/env node
/**
 * Parameter grid for Cloud Regime v2.2 — RSI Confluence (Strategy Tester metrics).
 *
 * Env:
 *   CLREG22_GRID_MAX=48        — cap scenarios (default: all)
 *   CLREG22_GRID_DELAY_MS=3500 — wait after input change
 *   CLREG22_ENTITY_ID=GlA4HY   — optional pin
 *   TV_BACKTEST_TIMEFRAME=5
 *   ADVISOR_STRATEGY_SUBSTRING=ClReg2.2
 *
 * Output: data/grid_runs/clreg22_<stamp>/{scenarios.ndjson,summary.json,input_manifest.json}
 */
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as indicators from '../src/core/indicators.js';
import * as ui from '../src/core/ui.js';
import { parseExecutionTable, mergeMetrics } from './clreg22-grid-utils.mjs';

const ROOT = process.cwd();
const DELAY_MS = Number(process.env.CLREG22_GRID_DELAY_MS ?? 4000);
const MAX_RUNS = process.env.CLREG22_GRID_MAX ? Number(process.env.CLREG22_GRID_MAX) : Infinity;
const MIN_TRADES = Number(process.env.CLREG22_MIN_TRADES ?? 10);
const TF = process.env.TV_BACKTEST_TIMEFRAME || '5';

if (!process.env.ADVISOR_STRATEGY_SUBSTRING) {
  process.env.ADVISOR_STRATEGY_SUBSTRING = 'v2.2';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildScenarios() {
  const modes = ['Trend', 'Combined', 'Momentum'];
  const rsiLens = [6, 14];
  const confLbs = [0, 3, 6];
  const risk = [
    { tp: 15, sl: 8 },
    { tp: 20, sl: 10 },
    { tp: 25, sl: 12 },
    { tp: 30, sl: 15 },
  ];
  const smooths = [2, 3];
  const out = [];
  let id = 0;
  for (const rsiMode of modes) {
    for (const rsiLen of rsiLens) {
      for (const confLookback of confLbs) {
        for (const { tp: tpPoints, sl: slPoints } of risk) {
          for (const cloudSmooth of smooths) {
            out.push({
              scenarioId: id++,
              spec: { rsiMode, rsiLen, confLookback, tpPoints, slPoints, cloudSmooth },
            });
          }
        }
      }
    }
  }
  return out;
}

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

function calendarDays(metrics) {
  const tw = metrics?.settings?.dateRange?.trade;
  if (!tw?.from || !tw?.to) return NaN;
  return Math.max((tw.to - tw.from) / 86400000, 1e-6);
}

function expectancy(m) {
  const t = m.totalTrades;
  if (!t || t <= 0) return NaN;
  return m.netProfit / t;
}

function scoreRow(row) {
  if (!row.metConstraint) return -Infinity;
  const net = row.netProfit ?? 0;
  const pf = row.profitFactor ?? 0;
  const exp = row.expectancy ?? 0;
  const trades = row.totalTrades ?? 0;
  // Primary: net profit; secondary PF and sample size
  return net * 0.1 + pf * 2 + exp * 0.5 + Math.log1p(trades) * 0.4;
}

function scoreRowProfit(row) {
  if (!row.totalTrades || row.totalTrades < MIN_TRADES) return -Infinity;
  return row.netProfit ?? -Infinity;
}

async function pollResults() {
  for (let i = 0; i < 20; i++) {
    await ui.strategyTesterClickUpdateReportIfPresent?.({ max_attempts: 3, pause_ms: 300 }).catch(() => {});
    const strat = await data.getStrategyResults();
    const m = strat.metrics || {};
    if (strat.report_ready || (typeof m.totalTrades === 'number' && m.totalTrades > 0)) {
      return strat;
    }
    if (Object.keys(m).length > 15) return strat;
    await sleep(800);
  }
  return data.getStrategyResults();
}

function pickEntity(state) {
  const forced = (process.env.CLREG22_ENTITY_ID || '').trim();
  if (forced) return forced;
  const hit = (state.studies || []).find((s) => /v2\.2|ClReg2\.2/i.test(s.name || ''));
  if (!hit?.id) throw new Error('ClReg2.2 not on chart — add Cloud Regime v2.2 and set CLREG22_ENTITY_ID');
  return hit.id;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(ROOT, 'data', 'grid_runs', `clreg22_${stamp}`);
mkdirSync(runDir, { recursive: true });
const ndjsonPath = join(runDir, 'scenarios.ndjson');
const out = createWriteStream(ndjsonPath, { flags: 'a' });

const scenarios = buildScenarios().slice(0, MAX_RUNS);
writeFileSync(
  join(runDir, 'input_manifest.json'),
  JSON.stringify(
    {
      strategy: 'Cloud Regime v2.2 — RSI Confluence',
      timeframe: TF,
      scenario_count: scenarios.length,
      dimensions: ['rsiMode', 'rsiLen', 'confLookback', 'tpPoints', 'slPoints', 'cloudSmooth'],
      defaults: { fast: 9, slow: 21, sma: 50, session: false },
    },
    null,
    2,
  ),
);

console.error(`[clreg22-grid] ${scenarios.length} scenarios → ${runDir}`);

await health.healthCheck();
const state0 = await chart.getState();
let entityId = pickEntity(state0);
console.error(`[clreg22-grid] entity=${entityId} symbol=${state0.symbol}`);

if (TF && String(state0.resolution) !== String(TF)) {
  await chart.setTimeframe({ timeframe: TF });
  await sleep(2000);
}

const rows = [];

for (let i = 0; i < scenarios.length; i++) {
  const { scenarioId, spec } = scenarios[i];
  process.stderr.write(`\r[clreg22-grid] ${i + 1}/${scenarios.length} ${spec.rsiMode} rsi${spec.rsiLen} lb${spec.confLookback} tp${spec.tpPoints}  `);
  const row = { scenarioId, spec, error: null };
  try {
    if ((i + 1) % 25 === 0) entityId = pickEntity(await chart.getState());

    await indicators.setInputs({
      entity_id: entityId,
      inputs: JSON.stringify(specToInputs(spec)),
      persist_layout: true,
    });
    await sleep(DELAY_MS);

    const strat = await pollResults();
    const m = strat.metrics || {};
    const pineTbl = await data.getPineTables({ study_filter: 'v2.2' }).catch(() => ({ studies: [] }));
    const exec = parseExecutionTable(pineTbl);
    row.strategy_name = strat.strategy_name;
    row.report_ready = strat.report_ready;
    row.totalTrades = m.totalTrades ?? 0;
    const wrRaw = m.percentProfitable ?? 0;
    row.percentProfitable = wrRaw <= 1 && wrRaw >= 0 ? wrRaw * 100 : wrRaw;
    row.profitFactor = m.profitFactor ?? 0;
    row.netProfit = m.netProfit ?? 0;
    row.grossProfit = m.grossProfit ?? 0;
    row.grossLoss = m.grossLoss ?? 0;
    row.avgTrade = m.avgTrade ?? expectancy(m);
    row.expectancy = expectancy(m);
    row.avgWinTrade = m.avgWinTrade ?? NaN;
    row.avgLosTrade = m.avgLosTrade ?? NaN;
    row.ratioWinLoss = m.ratioAvgWinAvgLoss ?? NaN;
    row.calendarDays = calendarDays(m);
    row.tradesPerDay = row.calendarDays > 0 ? row.totalTrades / row.calendarDays : NaN;
    const merged = mergeMetrics(row, exec);
    Object.assign(row, merged);
    row.metConstraint =
      row.totalTrades >= MIN_TRADES &&
      row.profitFactor >= 1.0 &&
      row.netProfit > 0 &&
      row.expectancy > 0;
    row.score = scoreRow(row);
  } catch (e) {
    row.error = e.message || String(e);
    row.metConstraint = false;
    row.score = -Infinity;
  }
  rows.push(row);
  out.write(`${JSON.stringify(row)}\n`);
}

out.end();
await disconnect?.().catch(() => {});

const ok = rows.filter((r) => !r.error && r.totalTrades > 0);
const feasible = rows.filter((r) => r.metConstraint);
feasible.sort((a, b) => b.score - a.score);
const byNet = [...ok].filter((r) => r.totalTrades >= MIN_TRADES).sort((a, b) => scoreRowProfit(b) - scoreRowProfit(a));
const profitable = ok.filter((r) => r.netProfit > 0 && r.totalTrades >= MIN_TRADES);
profitable.sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0));

const summary = {
  run_directory: runDir,
  scenario_count: scenarios.length,
  with_trades: ok.length,
  feasible_count: feasible.length,
  profitable_count: profitable.length,
  min_trades_gate: MIN_TRADES,
  best_by_net_profit: byNet[0] ?? null,
  best_feasible: feasible[0] ?? null,
  best_pf_any: [...ok].sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0))[0] ?? null,
  best_wr_any: [...ok].sort((a, b) => (b.percentProfitable ?? 0) - (a.percentProfitable ?? 0))[0] ?? null,
  top5_net: byNet.slice(0, 5).map((r) => ({ spec: r.spec, net: r.netProfit, pf: r.profitFactor, wr: r.percentProfitable, trades: r.totalTrades })),
  note: 'Feasible = PF>=1, net>0, expectancy>0, trades>=min. best_by_net_profit ranks all cells with min trades.',
};

writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.error('\n[clreg22-grid] done', JSON.stringify(summary, null, 2));
