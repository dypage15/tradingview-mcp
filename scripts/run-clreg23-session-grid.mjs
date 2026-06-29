#!/usr/bin/env node
/**
 * Session-filter grid for ClReg2.3 with optimized spec (MNQ 5m).
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

const BASE = {
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

const SESSIONS = [
  { label: 'off', useSession: false, sessStart: '0930-1600' },
  { label: 'rth_0930_1600', useSession: true, sessStart: '0930-1600' },
  { label: 'morning_0930_1200', useSession: true, sessStart: '0930-1200' },
  { label: 'extended_0800_1600', useSession: true, sessStart: '0800-1600' },
  { label: 'globex_evening_1800_2359', useSession: true, sessStart: '1800-2359' },
  { label: 'london_0700_1100', useSession: true, sessStart: '0700-1100' },
  { label: 'ny_open_0830_1130', useSession: true, sessStart: '0830-1130' },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    in_12: spec.useSession,
    in_13: spec.sessStart,
    in_14: spec.confLookback,
    in_15: spec.minBarsBetween ?? 0,
    in_16: spec.minCloudSep ?? 0,
    in_24: spec.riskMode ?? 'Points',
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
  const hits = (state.studies || []).filter((s) => /v2\.3|ClReg2\.3/i.test(s.name || ''));
  if (!hits.length) throw new Error('ClReg2.3 not on chart');
  return hits[hits.length - 1].id;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(ROOT, 'data', 'grid_runs', `clreg23_session_${stamp}`);
mkdirSync(runDir, { recursive: true });
const out = createWriteStream(join(runDir, 'scenarios.ndjson'));

await health.healthCheck();
let state0 = await chart.getState();
if (String(state0.resolution) !== String(TF)) {
  await chart.setTimeframe({ timeframe: TF });
  await sleep(2000);
}
const entityId = pickEntity(state0);
console.error(`[session] ${SESSIONS.length} scenarios → ${runDir} entity=${entityId}`);

const rows = [];
for (let i = 0; i < SESSIONS.length; i++) {
  const s = SESSIONS[i];
  const spec = { ...BASE, useSession: s.useSession, sessStart: s.sessStart, sessionLabel: s.label };
  process.stderr.write(`\r[session] ${i + 1}/${SESSIONS.length} ${s.label}  `);
  const row = { scenarioId: i, spec, error: null };
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
    row.score = row.metConstraint ? row.netProfit * 0.08 + row.profitFactor * 4 : row.netProfit - 5000;
  } catch (e) {
    row.error = e.message;
    row.score = -Infinity;
  }
  rows.push(row);
  out.write(`${JSON.stringify(row)}\n`);
}
out.end();

const profitable = rows.filter((r) => r.metConstraint).sort((a, b) => b.netProfit - a.netProfit);
const byNet = [...rows].filter((r) => r.totalTrades >= 10).sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0));
const summary = {
  run_directory: runDir,
  scenario_count: SESSIONS.length,
  profitable_count: profitable.length,
  best: profitable[0] ?? byNet[0] ?? null,
  top_all: byNet.map((r) => ({
    session: r.spec.sessionLabel,
    net: r.netProfit,
    pf: r.profitFactor,
    wr: r.percentProfitable,
    trades: r.totalTrades,
  })),
};
writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.error('\n[session] done', JSON.stringify(summary.top_all?.slice(0, 4), null, 2));
await disconnect().catch(() => {});
