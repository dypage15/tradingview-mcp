#!/usr/bin/env node
/**
 * Evaluate ClReg2.2 grid run — measurement contract + optimization readout.
 * Usage: node scripts/evaluate-clreg22-grid.mjs [path/to/clreg22_* run dir]
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();

function readNdjson(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function mean(a) {
  const x = a.filter(Number.isFinite);
  return x.length ? x.reduce((s, v) => s + v, 0) / x.length : NaN;
}

function findLatestRun() {
  const base = join(ROOT, 'data', 'grid_runs');
  const dirs = readdirSync(base)
    .filter((d) => d.startsWith('clreg22_'))
    .map((d) => ({ d, m: statSync(join(base, d)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return dirs[0] ? join(base, dirs[0].d) : null;
}

const runDir = resolve(process.argv[2] || process.env.CLREG22_EVAL_DIR || findLatestRun() || '');
if (!runDir || !existsSync(join(runDir, 'scenarios.ndjson'))) {
  console.error('No clreg22 grid run found. Run: node scripts/run-clreg22-grid.mjs');
  process.exit(1);
}

const rows = readNdjson(join(runDir, 'scenarios.ndjson'));
const metric = rows.filter((r) => !r.error && Number.isFinite(r.netProfit));

const report = {
  schema_version: 1,
  evaluator: 'evaluate-clreg22-grid',
  generated_at: new Date().toISOString(),
  run_directory: runDir,
  measurement_contract: {
    primary_objective: 'expectancy (netProfit / totalTrades) with profitFactor >= 1.75 gate',
    secondary: ['netProfit', 'profitFactor', 'maxDrawdown (manual from TV)', 'tradesPerDay'],
    not_sufficient_alone: ['winRate > 50% without positive expectancy'],
    oos_required: 'Hold out last 30% of calendar days before live',
    data_needed_from_strategy: [
      'totalTrades, netProfit, profitFactor, percentProfitable',
      'avgTrade (expectancy), avgWinTrade, avgLosTrade, ratioAvgWinAvgLoss',
      'grossProfit, grossLoss, trade date span (calendarDays)',
      'Per-trade export: entry time, exit reason, PnL pts (for Sharpe/Ulcer)',
      'Signal counts: flips, missed flips, RSI mode (from on-chart table)',
    ],
  },
  distributions: {
    n: metric.length,
    win_rate_pct: { mean: mean(metric.map((r) => r.percentProfitable)), min: Math.min(...metric.map((r) => r.percentProfitable)), max: Math.max(...metric.map((r) => r.percentProfitable)) },
    profit_factor: { mean: mean(metric.map((r) => r.profitFactor)) },
    net_profit: { mean: mean(metric.map((r) => r.netProfit)) },
    expectancy: { mean: mean(metric.map((r) => r.expectancy)) },
  },
  feasible: metric.filter((r) => r.metConstraint).sort((a, b) => b.score - a.score).slice(0, 10),
  best_by_net_profit: [...metric].filter((r) => r.totalTrades >= 10).sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0)).slice(0, 10),
  best_by_pf: [...metric].sort((a, b) => b.profitFactor - a.profitFactor).slice(0, 5),
  best_by_wr: [...metric].sort((a, b) => b.percentProfitable - a.percentProfitable).slice(0, 5),
  best_by_expectancy: [...metric].filter((r) => r.totalTrades >= 10).sort((a, b) => b.expectancy - a.expectancy).slice(0, 5),
  profitable_cells: metric.filter((r) => (r.netProfit ?? 0) > 0 && r.totalTrades >= 10).length,
  marginal: {},
};

for (const field of ['rsiMode', 'rsiLen', 'confLookback', 'tpPoints', 'slPoints', 'cloudSmooth']) {
  const m = new Map();
  for (const r of metric) {
    const k = r.spec?.[field];
    if (k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  const buckets = {};
  for (const [k, arr] of m) {
    buckets[k] = {
      n: arr.length,
      avg_wr: mean(arr.map((x) => x.percentProfitable)),
      avg_pf: mean(arr.map((x) => x.profitFactor)),
      avg_net: mean(arr.map((x) => x.netProfit)),
      avg_exp: mean(arr.map((x) => x.expectancy)),
      feasible: arr.filter((x) => x.metConstraint).length,
    };
  }
  report.marginal[field] = buckets;
}

report.conclusion = {
  can_claim_profitable_yet: report.feasible.length > 0,
  wr_above_50_alone_proves_edge: false,
  recommendation: report.feasible.length
    ? 'Apply best_feasible spec OOS on fresh date range; confirm PF and expectancy hold.'
    : 'No grid cell met PF>=1, net>0, expectancy>0, min trades — do not optimize for WR alone; widen Trend/Combined RSI or fix execution before live.',
};

writeFileSync(join(runDir, 'evaluation_report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.conclusion, null, 2));
console.log('Wrote', join(runDir, 'evaluation_report.json'));
