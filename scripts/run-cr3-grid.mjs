#!/usr/bin/env node
/**
 * Parameter grid for Cloud Regime v3 Full Stack (MNQ 5m).
 *
 * Sweeps:
 *   wickMinConf: 2, 3, 4
 *   zOptLow/zOptHigh/adxEntryHigh bands
 *   outcomeLB: 8, 10, 20 (research)
 *   session: 0930-1200, 0930-1600
 *
 * Env:
 *   CR3_GRID_MAX — cap scenarios
 *   CR3_GRID_DELAY_MS — wait after input change (default 10000)
 *   TV_BACKTEST_TIMEFRAME=5
 */
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as indicators from '../src/core/indicators.js';
import * as ui from '../src/core/ui.js';
import {
  CR3_DEFAULT_SPEC,
  parseResearchTable,
  pickCr3Entity,
  specToInputs,
} from './cr3-grid-utils.mjs';

const ROOT = process.cwd();
const DELAY_MS = Number(process.env.CR3_GRID_DELAY_MS ?? 10000);
const MAX_RUNS = process.env.CR3_GRID_MAX ? Number(process.env.CR3_GRID_MAX) : Infinity;
const MIN_TRADES = Number(process.env.CR3_MIN_TRADES ?? 10);
const TF = process.env.TV_BACKTEST_TIMEFRAME || '5';

process.env.ADVISOR_STRATEGY_SUBSTRING = process.env.ADVISOR_STRATEGY_SUBSTRING || 'Full Stack';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildScenarios() {
  const wickMinConfs = [2, 3, 4];
  const adxBands = [
    { zOptLow: 18, zOptHigh: 35, adxEntryHigh: 35, label: '18-35' },
    { zOptLow: 20, zOptHigh: 40, adxEntryHigh: 40, label: '20-40' },
    { zOptLow: 20, zOptHigh: 45, adxEntryHigh: 45, label: '20-45' },
  ];
  const outcomeLBs = [8, 10, 20];
  const sessions = [
    { sessStart: '0930-1200', sessionLabel: 'morning' },
    { sessStart: '0930-1600', sessionLabel: 'rth' },
  ];
  const out = [];
  let id = 0;
  for (const wickMinConf of wickMinConfs) {
    for (const band of adxBands) {
      for (const outcomeLB of outcomeLBs) {
        for (const sess of sessions) {
          out.push({
            scenarioId: id++,
            spec: {
              ...CR3_DEFAULT_SPEC,
              wickMinConf,
              zOptLow: band.zOptLow,
              zOptHigh: band.zOptHigh,
              adxEntryHigh: band.adxEntryHigh,
              adxBandLabel: band.label,
              outcomeLB,
              sessStart: sess.sessStart,
              sessionLabel: sess.sessionLabel,
              useWickTier: false,
            },
          });
        }
      }
    }
  }
  return out;
}

async function pollResults() {
  for (let i = 0; i < 18; i++) {
    await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 2, pause_ms: 300 }).catch(() => {});
    const strat = await data.getStrategyResults();
    const m = strat.metrics || {};
    if (strat.report_ready || (m.totalTrades ?? 0) >= 0) return strat;
    await sleep(700);
  }
  return data.getStrategyResults();
}

const scenarios = buildScenarios().slice(0, MAX_RUNS);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(ROOT, 'data', 'grid_runs', `cr3_grid_${stamp}`);
mkdirSync(runDir, { recursive: true });
const out = createWriteStream(join(runDir, 'scenarios.ndjson'));

writeFileSync(
  join(runDir, 'input_manifest.json'),
  JSON.stringify({ scenario_count: scenarios.length, base: CR3_DEFAULT_SPEC }, null, 2),
);

await health.healthCheck();
let state0 = await chart.getState();
if (String(state0.resolution) !== String(TF)) {
  await chart.setTimeframe({ timeframe: TF });
  await sleep(2000);
}
const entityId = pickCr3Entity(state0);
console.error(`[cr3-grid] ${scenarios.length} scenarios → ${runDir} entity=${entityId}`);

const rows = [];
for (let i = 0; i < scenarios.length; i++) {
  const { scenarioId, spec } = scenarios[i];
  process.stderr.write(`\r[cr3-grid] ${i + 1}/${scenarios.length} id=${scenarioId}  `);
  const row = { scenarioId, spec, error: null };
  try {
    await indicators.setInputs({
      entity_id: entityId,
      inputs: JSON.stringify(specToInputs(spec)),
      persist_layout: true,
    });
    await sleep(DELAY_MS);
    const strat = await pollResults();
    const m = strat.metrics || {};
    const research = parseResearchTable(
      await data.getPineTables({ study_filter: 'Full Stack' }).catch(() => ({ studies: [] })),
    );
    row.totalTrades = m.totalTrades ?? 0;
    const wrRaw = m.percentProfitable ?? 0;
    row.percentProfitable = wrRaw <= 1 && wrRaw >= 0 ? wrRaw * 100 : wrRaw;
    row.profitFactor = m.profitFactor ?? 0;
    row.netProfit = m.netProfit ?? 0;
    row.expectancy = row.totalTrades > 0 ? row.netProfit / row.totalTrades : NaN;
    row.research = {
      parsed: research.parsed,
      bestBucket: research.bestByWin || null,
      trendTL: research.trendRows?.find((b) => b.signal === 'T_L'),
      trendTS: research.trendRows?.find((b) => b.signal === 'T_S'),
    };
    row.metConstraint =
      row.totalTrades >= MIN_TRADES && row.profitFactor >= 1.0 && row.netProfit > 0;
    row.score = row.metConstraint
      ? row.netProfit * 0.08 + row.profitFactor * 4
      : row.netProfit - 5000;
  } catch (e) {
    row.error = e.message;
    row.score = -Infinity;
  }
  rows.push(row);
  out.write(`${JSON.stringify(row)}\n`);
}
out.end();

const profitable = rows.filter((r) => r.metConstraint).sort((a, b) => b.netProfit - a.netProfit);
const byResearch = [...rows]
  .filter((r) => r.research?.bestBucket?.n >= 30)
  .sort((a, b) => (b.research.bestBucket.winPct ?? 0) - (a.research.bestBucket.winPct ?? 0));

const summary = {
  run_directory: runDir,
  scenario_count: scenarios.length,
  profitable_count: profitable.length,
  best_trades: profitable[0] ?? null,
  best_research: byResearch[0] ?? null,
  top_trades: profitable.slice(0, 5).map((r) => ({
    id: r.scenarioId,
    wickMinConf: r.spec.wickMinConf,
    adx: r.spec.adxBandLabel,
    outcomeLB: r.spec.outcomeLB,
    session: r.spec.sessionLabel,
    net: r.netProfit,
    pf: r.profitFactor,
    trades: r.totalTrades,
  })),
};
writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.error('\n[cr3-grid] done', JSON.stringify(summary.top_trades?.slice(0, 3), null, 2));
await disconnect().catch(() => {});
