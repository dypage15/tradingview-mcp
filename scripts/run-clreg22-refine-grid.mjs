#!/usr/bin/env node
/**
 * Refinement grid for ClReg2.3 — cooldown, cloud width, risk mode, TP/SL.
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
const DELAY_MS = Number(process.env.CLREG22_GRID_DELAY_MS ?? 10000);
const MIN_TRADES = Number(process.env.CLREG22_MIN_TRADES ?? 30);
const TF = process.env.TV_BACKTEST_TIMEFRAME || '5';

process.env.ADVISOR_STRATEGY_SUBSTRING = process.env.ADVISOR_STRATEGY_SUBSTRING || 'v2.3';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildScenarios() {
  const out = [];
  let id = 0;
  const cool = [0, 3, 6, 10];
  const sep = [0, 3, 6];
  const risks = [
    { riskMode: 'Points', tpPoints: 30, slPoints: 15, tpAtrMult: 2, slAtrMult: 1 },
    { riskMode: 'Points', tpPoints: 25, slPoints: 12, tpAtrMult: 2, slAtrMult: 1 },
    { riskMode: 'Points', tpPoints: 35, slPoints: 18, tpAtrMult: 2, slAtrMult: 1 },
    { riskMode: 'ATR Multiple', tpPoints: 30, slPoints: 15, tpAtrMult: 1.5, slAtrMult: 0.75 },
    { riskMode: 'ATR Multiple', tpPoints: 30, slPoints: 15, tpAtrMult: 2.0, slAtrMult: 1.0 },
    { riskMode: 'ATR Multiple', tpPoints: 30, slPoints: 15, tpAtrMult: 2.5, slAtrMult: 1.25 },
  ];
  for (const minBarsBetween of cool) {
    for (const minCloudSep of sep) {
      for (const r of risks) {
        out.push({
          scenarioId: id++,
          spec: {
            rsiMode: 'Combined',
            rsiLen: 6,
            confLookback: 3,
            cloudSmooth: 3,
            minBarsBetween,
            minCloudSep,
            ...r,
          },
        });
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
    in_15: spec.minBarsBetween,
    in_16: spec.minCloudSep,
    in_24: spec.riskMode,
    in_25: 14,
    in_26: spec.tpAtrMult,
    in_27: spec.slAtrMult,
  };
}

async function pollResults() {
  for (let i = 0; i < 18; i++) {
    await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 2, pause_ms: 300 }).catch(() => {});
    const strat = await data.getStrategyResults();
    const m = strat.metrics || {};
    if (strat.report_ready || (m.totalTrades ?? 0) > 0) return strat;
    await sleep(700);
  }
  return data.getStrategyResults();
}

function pickEntity(state) {
  const forced = (process.env.CLREG22_ENTITY_ID || '').trim();
  if (forced) return forced;
  const hit = (state.studies || []).find((s) => /v2\.3|ClReg2\.3|v2\.2|ClReg2\.2/i.test(s.name || ''));
  if (!hit?.id) throw new Error('ClReg2.3 not on chart');
  return hit.id;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(ROOT, 'data', 'grid_runs', `clreg23_refine_${stamp}`);
mkdirSync(runDir, { recursive: true });
const scenarios = buildScenarios();
const out = createWriteStream(join(runDir, 'scenarios.ndjson'));

await health.healthCheck();
let state0 = await chart.getState();
if (String(state0.resolution) !== String(TF)) {
  await chart.setTimeframe({ timeframe: TF });
  await sleep(2000);
}
let entityId = pickEntity(state0);
console.error(`[refine] ${scenarios.length} scenarios → ${runDir}`);

const rows = [];
for (let i = 0; i < scenarios.length; i++) {
  const { scenarioId, spec } = scenarios[i];
  process.stderr.write(`\r[refine] ${i + 1}/${scenarios.length} cd${spec.minBarsBetween} sep${spec.minCloudSep} ${spec.riskMode}  `);
  const row = { scenarioId, spec, error: null };
  try {
    await indicators.setInputs({ entity_id: entityId, inputs: JSON.stringify(specToInputs(spec)), persist_layout: true });
    await sleep(DELAY_MS);
    const strat = await pollResults();
    const m = strat.metrics || {};
    const exec = parseExecutionTable(await data.getPineTables({ study_filter: 'v2.3' }).catch(() => ({ studies: [] })));
    row.totalTrades = m.totalTrades ?? 0;
    const wrRaw = m.percentProfitable ?? 0;
    row.percentProfitable = wrRaw <= 1 && wrRaw >= 0 ? wrRaw * 100 : wrRaw;
    row.profitFactor = m.profitFactor ?? 0;
    row.netProfit = m.netProfit ?? 0;
    row.expectancy = row.totalTrades > 0 ? row.netProfit / row.totalTrades : NaN;
    Object.assign(row, mergeMetrics(row, exec));
    row.metConstraint = row.totalTrades >= MIN_TRADES && row.profitFactor >= 1.05 && row.netProfit > 0 && row.expectancy > 0;
    row.score = row.metConstraint ? row.netProfit * 0.08 + row.profitFactor * 4 + Math.log1p(row.totalTrades) : row.netProfit - 5000;
  } catch (e) {
    row.error = e.message;
    row.score = -Infinity;
  }
  rows.push(row);
  out.write(`${JSON.stringify(row)}\n`);
}
out.end();

const profitable = rows.filter((r) => r.metConstraint).sort((a, b) => b.netProfit - a.netProfit);
const byNet = [...rows].filter((r) => r.totalTrades >= MIN_TRADES).sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0));
const summary = {
  run_directory: runDir,
  scenario_count: scenarios.length,
  profitable_count: profitable.length,
  best: profitable[0] ?? byNet[0] ?? null,
  top8: byNet.slice(0, 8).map((r) => ({ spec: r.spec, net: r.netProfit, pf: r.profitFactor, wr: r.percentProfitable, trades: r.totalTrades })),
};
writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.error('\n[refine] done', JSON.stringify(summary.top8?.[0] ?? summary.best, null, 2));
await disconnect().catch(() => {});
