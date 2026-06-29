#!/usr/bin/env node
/**
 * Export CR3 Full Stack research table → data/grid_runs/cr3_research_<stamp>/summary.json
 *
 * Env:
 *   CLOUD_REGIME_SRC — path to full-stack pine (optional push)
 *   CR3_PUSH=1        — push pine before snapshot
 *   ADVISOR_STRATEGY_SUBSTRING=Full Stack
 *   TV_BACKTEST_TIMEFRAME=5
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { disconnect } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as ui from '../src/core/ui.js';
import {
  CR3_DEFAULT_SPEC,
  parseResearchTable,
  pickCr3Entity,
  randomEntryBaseline,
  specToInputs,
} from './cr3-grid-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TF = process.env.TV_BACKTEST_TIMEFRAME || '5';
const STUDY_FILTER = process.env.ADVISOR_STRATEGY_SUBSTRING || 'Full Stack';

process.env.ADVISOR_STRATEGY_SUBSTRING = STUDY_FILTER;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.CR3_PUSH === '1') {
  const srcPath =
    process.env.CLOUD_REGIME_SRC || join(ROOT, 'cloud-regime-v3-full-stack-strategy.pine');
  const push = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts/push-cloud-regime-v3.mjs')],
    {
      cwd: ROOT,
      env: { ...process.env, CLOUD_REGIME_SRC: srcPath },
      encoding: 'utf8',
    },
  );
  console.error('[cr3-snapshot] push:', push.stdout || push.stderr || push.status);
  await sleep(3000);
}

await health.healthCheck();
await ui.openPanel({ panel: 'pine-editor', action: 'open' }).catch(() => {});

let state = await chart.getState();
if (String(state.resolution) !== String(TF)) {
  await chart.setTimeframe({ timeframe: TF });
  await sleep(2500);
  state = await chart.getState();
}

const entityId = pickCr3Entity(state);
await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5 }).catch(() => {});
await sleep(2000);

const tablesRaw = await data.getPineTables({ study_filter: STUDY_FILTER });
const research = parseResearchTable(tablesRaw);
const strat = await data.getStrategyResults();
const m = strat.metrics || {};

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(ROOT, 'data', 'grid_runs', `cr3_research_${stamp}`);
mkdirSync(runDir, { recursive: true });

const spec = { ...CR3_DEFAULT_SPEC };
const baseline = randomEntryBaseline({
  tradeCount: Math.max(m.totalTrades ?? 0, 100),
  tpPts: spec.tpPoints,
  slPts: spec.slPoints,
});

const summary = {
  run_directory: runDir,
  timestamp: new Date().toISOString(),
  symbol: state.symbol,
  timeframe: TF,
  entity_id: entityId,
  spec,
  inputs_applied: specToInputs(spec),
  research,
  strategy_tester: {
    totalTrades: m.totalTrades ?? 0,
    netProfit: m.netProfit ?? 0,
    profitFactor: m.profitFactor ?? 0,
    percentProfitable: m.percentProfitable ?? 0,
    dateRange: m.settings?.dateRange?.trade?.from
      ? m.settings.dateRange.trade
      : m.settings?.dateRange?.backtest || null,
  },
  random_baseline: baseline,
  success_criteria: {
    clustered_wick_n_lt_raw_labels: true,
    bucket_win_gt_55: (research.bestByWin?.winPct ?? 0) > 55,
    bucket_avg_pts_gt_5: (research.bestByWin?.avgPts ?? 0) > 5,
    bucket_n_gte_30: (research.bestByWin?.n ?? 0) >= 30,
  },
};

writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
await disconnect().catch(() => {});
