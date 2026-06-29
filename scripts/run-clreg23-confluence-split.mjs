#!/usr/bin/env node
/**
 * A/B: Cloud + RSI vs Cloud + BB (same cloud, session, risk).
 * Uses Arizona Asia+NY session settings from apply-clreg23-asia-ny.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as indicators from '../src/core/indicators.js';
import * as ui from '../src/core/ui.js';
import { parseExecutionTable, mergeMetrics } from './clreg22-grid-utils.mjs';

const ROOT = process.cwd();
const DELAY_MS = Number(process.env.CLREG22_GRID_DELAY_MS ?? 12000);
const TF = process.env.TV_BACKTEST_TIMEFRAME || '5';

process.env.ADVISOR_STRATEGY_SUBSTRING = 'v2.3';

const BASE = {
  in_0: 9,
  in_1: 21,
  in_2: 50,
  in_3: 3,
  in_4: 6,
  in_6: 'Combined',
  in_7: 30,
  in_8: 70,
  in_9: 5,
  in_10: 30,
  in_11: 15,
  in_12: true,
  in_14: 3,
  in_15: 0,
  in_16: 0,
  in_24: 'Points',
  in_28: 'Asia + NY',
  in_29: '1800-0100',
  in_30: '0830-1500',
  in_31: true,
  in_32: true,
  in_33: true,
  in_37: 20,
  in_38: 2.0,
  in_39: 'Proximity',
  in_40: 3.0,
  in_41: 14,
};

const SCENARIOS = [
  { label: 'Cloud+RSI', in_35: true, in_36: false },
  { label: 'Cloud+BB', in_35: false, in_36: true },
  { label: 'Cloud only', in_35: false, in_36: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const runDir = join(ROOT, 'data', 'grid_runs', `clreg23_conf_split_${stamp}`);
mkdirSync(runDir, { recursive: true });

await health.healthCheck();
let state0 = await chart.getState();
if (String(state0.resolution) !== String(TF)) {
  await chart.setTimeframe({ timeframe: TF });
  await sleep(2000);
}
const entityId = pickEntity(state0);
console.error(`[conf-split] entity=${entityId} MNQ ${TF}m Asia+NY`);

const rows = [];
for (let i = 0; i < SCENARIOS.length; i++) {
  const sc = SCENARIOS[i];
  const inputs = { ...BASE, in_35: sc.in_35, in_36: sc.in_36 };
  process.stderr.write(`\r[conf-split] ${i + 1}/2 ${sc.label}  `);
  await indicators.setInputs({ entity_id: entityId, inputs: JSON.stringify(inputs), persist_layout: true });
  await sleep(DELAY_MS);
  const strat = await pollResults();
  const m = strat.metrics || {};
  const exec = parseExecutionTable(await data.getPineTables({ study_filter: 'v2.3' }).catch(() => ({ studies: [] })));
  const wrRaw = m.percentProfitable ?? 0;
  const row = {
    label: sc.label,
    useRsiConfluence: sc.in_35,
    useBbConfluence: sc.in_36,
    totalTrades: m.totalTrades ?? 0,
    percentProfitable: wrRaw <= 1 && wrRaw >= 0 ? wrRaw * 100 : wrRaw,
    profitFactor: m.profitFactor ?? 0,
    netProfit: m.netProfit ?? 0,
    expectancy: (m.totalTrades ?? 0) > 0 ? (m.netProfit ?? 0) / m.totalTrades : NaN,
  };
  Object.assign(row, mergeMetrics(row, exec));
  rows.push(row);
}

const winner = [...rows].sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0))[0];
const summary = {
  run_directory: runDir,
  symbol: state0.symbol,
  timeframe: TF,
  session: 'Asia + NY (Arizona)',
  cloud: { smooth: 3, tp: 30, sl: 15, confLookback: 3 },
  rsi_spec: { mode: 'Combined', len: 6 },
  bb_spec: { len: 20, mult: 2, mode: 'Proximity', buffer: 1.5 },
  results: rows,
  winner: winner?.label,
};
writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.error('\n[conf-split] done\n', JSON.stringify(summary, null, 2));
await disconnect().catch(() => {});
