/**
 * Grid-evaluates Cloud Regime v3.0 inputs across 1m / 2m / 5m chart timeframes.
 * Reads attempts JSON (350 rows), drives TradingView via CDP — same stack as MCP.
 *
 * Usage (from repo root):
 *   node scripts/run-cloud-regime-grid.mjs
 *
 * Env:
 *   TV_ATTEMPTS_JSON — path to attempts array JSON (default: ~/.cursor/tv-cr350-attempts.json)
 *   TV_RESULTS_CSV   — CSV output path (default: ~/.cursor/tv-cr350-results.csv)
 *   TV_GRID_DELAY_MS — pause after changing inputs before reading Strategy Tester (default 900)
 */
import fs from 'node:fs';
import path from 'node:path';
import { disconnect } from '../src/connection.js';
import * as chartCore from '../src/core/chart.js';
import * as indCore from '../src/core/indicators.js';
import * as dataCore from '../src/core/data.js';

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const DEFAULT_JSON = path.join(HOME, '.cursor', 'tv-cr350-attempts.json');
const DEFAULT_CSV = path.join(HOME, '.cursor', 'tv-cr350-results.csv');

const ATTEMPTS_PATH = process.env.TV_ATTEMPTS_JSON || DEFAULT_JSON;
const CSV_PATH = process.env.TV_RESULTS_CSV || DEFAULT_CSV;
const DELAY_MS = Number(process.env.TV_GRID_DELAY_MS || 900);

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function resolveEntityId() {
  const state = await chartCore.getState();
  const study =
    state.studies?.find((s) => /cloud regime/i.test(s.name || '')) ||
    state.studies?.[0];
  if (!study?.id) throw new Error('No study entity id on chart (add Cloud Regime v3.0).');
  return study.id;
}

async function main() {
  console.error(
    '[tv-grid] Not financial advice; historical backtests only. Ensure TradingView Desktop is running with CDP (port 9222).'
  );

  const raw = fs.readFileSync(ATTEMPTS_PATH, 'utf8');
  const attempts = JSON.parse(raw);
  if (!Array.isArray(attempts) || attempts.length === 0) {
    throw new Error(`Invalid attempts file: ${ATTEMPTS_PATH}`);
  }

  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
  fs.writeFileSync(
    CSV_PATH,
    'id,tf,in_0,in_3,in_5,in_6,in_7,in_11,in_13,in_14,in_16,net_profit,profit_factor,total_trades,percent_profitable,gross_profit,gross_loss,strategy_name,error\n'
  );

  let entityId = await resolveEntityId();
  console.error(`[tv-grid] Entity id: ${entityId}`);
  console.error(`[tv-grid] Running ${attempts.length} attempts → ${CSV_PATH}`);

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    process.stderr.write(`\r[tv-grid] ${a.id ?? i + 1}/${attempts.length} TF=${a.tf}   `);
    let errorCell = '';
    let stratName = '';
    try {
      if (!['1', '2', '5'].includes(String(a.tf))) {
        throw new Error(`TF ${a.tf} not in allowed list 1,2,5`);
      }
      await chartCore.setTimeframe({ timeframe: String(a.tf) });

      if ((i + 1) % 40 === 0) {
        entityId = await resolveEntityId();
      }

      await indCore.setInputs({
        entity_id: entityId,
        inputs: JSON.stringify(a.inputs),
        persist_layout: true,
      });
      await new Promise((r) => setTimeout(r, DELAY_MS));

      const res = await dataCore.getStrategyResults();
      stratName = res.strategy_name || res.strategyName || '';
      const m = res.metrics || {};
      const row = [
        a.id ?? i + 1,
        a.tf,
        a.inputs?.in_0,
        a.inputs?.in_3,
        a.inputs?.in_5,
        a.inputs?.in_6,
        a.inputs?.in_7,
        a.inputs?.in_11,
        a.inputs?.in_13,
        a.inputs?.in_14,
        a.inputs?.in_16,
        m.netProfit,
        m.profitFactor,
        m.totalTrades,
        m.percentProfitable,
        m.grossProfit,
        m.grossLoss,
        stratName,
        errorCell,
      ]
        .map(csvEscape)
        .join(',');
      fs.appendFileSync(CSV_PATH, `${row}\n`);
    } catch (e) {
      errorCell = e.message || String(e);
      const row = [
        a.id ?? i + 1,
        a.tf,
        a.inputs?.in_0,
        a.inputs?.in_3,
        a.inputs?.in_5,
        a.inputs?.in_6,
        a.inputs?.in_7,
        a.inputs?.in_11,
        a.inputs?.in_13,
        a.inputs?.in_14,
        a.inputs?.in_16,
        '',
        '',
        '',
        '',
        '',
        '',
        stratName,
        errorCell,
      ]
        .map(csvEscape)
        .join(',');
      fs.appendFileSync(CSV_PATH, `${row}\n`);
    }
  }

  console.error('\n[tv-grid] Complete.');
}

await main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
