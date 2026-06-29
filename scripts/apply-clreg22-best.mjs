#!/usr/bin/env node
/**
 * Apply best spec from clreg22/clreg23 grid summary to chart.
 * Usage: node scripts/apply-clreg22-best.mjs [path/to/summary.json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { disconnect } from '../src/connection.js';
import * as chart from '../src/core/chart.js';
import * as indicators from '../src/core/indicators.js';
import * as data from '../src/core/data.js';
import * as ui from '../src/core/ui.js';

const ROOT = process.cwd();

function findLatestSummary() {
  const base = join(ROOT, 'data', 'grid_runs');
  const dirs = readdirSync(base)
    .filter((d) => d.startsWith('clreg22_') || d.startsWith('clreg23_refine_'))
    .map((d) => ({ d, m: statSync(join(base, d)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return dirs[0] ? join(base, dirs[0].d, 'summary.json') : null;
}

const summaryPath = resolve(process.argv[2] || process.env.CLREG22_SUMMARY || findLatestSummary() || '');
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const best = summary.best_by_net_profit || summary.best_feasible || summary.best;
if (!best?.spec) {
  console.error('No best spec in summary:', summaryPath);
  process.exit(1);
}

function specToInputs(spec) {
  const inputs = {
    in_0: 9,
    in_1: 21,
    in_2: 50,
    in_3: spec.cloudSmooth ?? 3,
    in_4: spec.rsiLen ?? 6,
    in_6: spec.rsiMode ?? 'Combined',
    in_7: 30,
    in_8: 70,
    in_9: 5,
    in_10: spec.tpPoints ?? spec.tp ?? 30,
    in_11: spec.slPoints ?? spec.sl ?? 15,
    in_12: false,
    in_14: spec.confLookback ?? 3,
    in_15: spec.minBarsBetween ?? 0,
    in_16: spec.minCloudSep ?? 0,
  };
  if (spec.riskMode) {
    inputs.in_24 = spec.riskMode;
    inputs.in_25 = spec.atrLen ?? 14;
    inputs.in_26 = spec.tpAtrMult ?? 2;
    inputs.in_27 = spec.slAtrMult ?? 1;
  }
  return inputs;
}

const state = await chart.getState();
const hit = (state.studies || []).find((s) => /v2\.3|ClReg2\.3|v2\.2|ClReg2\.2/i.test(s.name || ''));
if (!hit?.id) throw new Error('ClReg not on chart');

await indicators.setInputs({
  entity_id: hit.id,
  inputs: JSON.stringify(specToInputs(best.spec)),
  persist_layout: true,
});
await new Promise((r) => setTimeout(r, 8000));
await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5 }).catch(() => {});
process.env.ADVISOR_STRATEGY_SUBSTRING = 'v2.3';
const strat = await data.getStrategyResults();
console.log('Summary:', summaryPath);
console.log('Applied spec:', best.spec);
console.log('Results:', {
  trades: strat.metrics?.totalTrades,
  net: strat.metrics?.netProfit,
  pf: strat.metrics?.profitFactor,
  wr: strat.metrics?.percentProfitable,
});
await disconnect().catch(() => {});
