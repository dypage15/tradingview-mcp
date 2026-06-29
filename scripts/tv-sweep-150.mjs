#!/usr/bin/env node
/**
 * Run all scenarios from data/sweep_tv_scenarios_150.json on TradingView Strategy Tester.
 *
 * Prerequisites:
 *   - TradingView Desktop (or browser tab) with CDP on localhost:9222
 *   - Chart: MNQ (or target symbol), same range as your test
 *   - Strategy "Sweep Engine v2.0 — Secondary" on chart (save latest Pine from repo for in_0 contracts)
 *   - Optional: hide other strategies or ensure tester targets Secondary (ADVISOR_STRATEGY_SUBSTRING)
 *
 * Env:
 *   TV_ENTITY_SECONDARY  — study entity id (default: auto-detect name contains "Secondary")
 *   GRID_DELAY_MS        — wait after each indicator set for tester to recompute (default 4000)
 *   TV_MAX_SCENARIOS     — cap runs for smoke tests (default 150 = all)
 *
 * Usage (from repo root):
 *   node scripts/tv-sweep-150.mjs
 *   $env:TV_MAX_SCENARIOS=3; node scripts/tv-sweep-150.mjs
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tv = join(root, 'src/cli/index.js');
const SCENARIO_FILE = join(root, 'data', 'sweep_tv_scenarios_150.json');
const OUT = join(root, 'data', 'sweep_tv_optimizer_tv_results.jsonl');
const BUF = 50 * 1024 * 1024;

const DELAY_MS = Number(process.env.GRID_DELAY_MS || 4000);
const MAX_RUNS = Number(process.env.TV_MAX_SCENARIOS || 150);

const ENTRY_OPTIONS = new Set([
  'Reactive sweep (close)',
  'Reactive limit (swept level)',
  'Predictive limit (model)',
]);

const EXPECTED_ENTRY_IN = 52;
const PINE_MAX_EXCL = 63;

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function execTv(args) {
  return execFileSync(process.execPath, [tv, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: BUF,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tvJson(args) {
  return JSON.parse(execTv(args));
}

function resolveSecondaryEntity() {
  const ex = (process.env.TV_ENTITY_SECONDARY || '').trim();
  if (ex) return ex;
  const st = tvJson(['state']);
  const studies = st.studies || [];
  const hit = studies.find((s) => /secondary/i.test(s.name || ''));
  if (!hit) {
    throw new Error(
      'Secondary strategy not found. Add "Sweep Engine v2.0 — Secondary" or set TV_ENTITY_SECONDARY.'
    );
  }
  return hit.id;
}

function detectEntryModeIndex(inputs) {
  if (!Array.isArray(inputs)) return null;
  for (const row of inputs) {
    if (!row || !/^in_\d+$/.test(row.id)) continue;
    if (ENTRY_OPTIONS.has(row.value)) return Number(row.id.slice(3));
  }
  return null;
}

function findDefaultQtyInputId(inputs) {
  if (!Array.isArray(inputs)) return 'in_64';
  const arr = inputs.filter((i) => i && /^in_\d+$/.test(i.id));
  for (let i = 0; i < arr.length - 1; i++) {
    if (
      arr[i].value === 'fixed' &&
      typeof arr[i + 1].value === 'number' &&
      arr[i + 1].value >= 1 &&
      arr[i + 1].value <= 100
    ) {
      return arr[i + 1].id;
    }
  }
  return 'in_64';
}

/**
 * Map canonical repo Pine in_* (with i_contracts at in_0) onto the chart's actual indices.
 */
function buildShiftedOverrides(tvInputsCanonical, shift, contracts, strategyQtyId) {
  const out = {};
  for (const [key, val] of Object.entries(tvInputsCanonical)) {
    const m = /^in_(\d+)$/.exec(key);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= PINE_MAX_EXCL) continue;

    if (n === 0) {
      if (shift === 0) {
        out.in_0 = val;
      } else {
        out[strategyQtyId] = contracts;
      }
      continue;
    }

    const nn = n + shift;
    if (nn < 0) continue;
    out[`in_${nn}`] = val;
  }
  return out;
}

function main() {
  mkdirSync(join(root, 'data'), { recursive: true });
  process.env.ADVISOR_STRATEGY_SUBSTRING = process.env.ADVISOR_STRATEGY_SUBSTRING || 'Secondary';

  const raw = JSON.parse(readFileSync(SCENARIO_FILE, 'utf8'));
  const scenarios = raw.scenarios || [];
  if (scenarios.length === 0) {
    throw new Error(`No scenarios in ${SCENARIO_FILE}. Run: python sweep_optimizer.py --export-tv-json-only`);
  }

  tvJson(['status']);
  const entityId = resolveSecondaryEntity();
  const ig = tvJson(['indicator', 'get', entityId]);
  const inputsArr = ig.inputs || [];
  const entryN = detectEntryModeIndex(inputsArr);
  if (entryN == null) {
    throw new Error('Could not find Entry style input on study. Update/save Secondary Pine from repo.');
  }
  const shift = entryN - EXPECTED_ENTRY_IN;
  const qtyId = findDefaultQtyInputId(inputsArr);

  console.error(
    `[tv-sweep-150] entity=${entityId} entryMode=in_${entryN} shift=${shift} strategyQty=${qtyId} delayMs=${DELAY_MS} runs=${Math.min(MAX_RUNS, scenarios.length)}`
  );
  if (shift !== 0) {
    console.error(
      '[tv-sweep-150] WARN: Chart Pine looks older than repo (no i_contracts row). Contracts applied via strategy qty; save latest sweep-engine-v2-secondary.pine for accurate parity.'
    );
  }

  writeFileSync(OUT, '', 'utf8');

  let run = 0;
  for (const sc of scenarios) {
    if (run >= MAX_RUNS) break;
    run++;
    const contracts = sc.contracts ?? sc.semantic?.contracts ?? 2;
    const merged = buildShiftedOverrides(sc.tv_inputs, shift, contracts, qtyId);

    try {
      execTv(['indicator', 'set', entityId, '--no-persist', '-i', JSON.stringify(merged)]);
    } catch (e) {
      console.error(JSON.stringify({ run, id: sc.id, error: 'indicator set', message: e.message }));
      sleepMs(8000);
      continue;
    }
    sleepMs(DELAY_MS);

    let data;
    try {
      data = tvJson(['data', 'strategy']);
    } catch (e) {
      console.error(JSON.stringify({ run, id: sc.id, error: 'data strategy', message: e.message }));
      sleepMs(8000);
      continue;
    }

    const metrics = data.metrics || {};
    const line = {
      run,
      scenario_id: sc.id,
      contracts,
      shift,
      netProfit: metrics.netProfit,
      profitFactor: metrics.profitFactor,
      percentProfitable: metrics.percentProfitable,
      totalTrades: metrics.totalTrades,
      maxStrategyDrawDownPercent: metrics.maxStrategyDrawDownPercent,
      grossProfit: metrics.grossProfit,
      grossLoss: metrics.grossLoss,
      strategy_name: data.strategy_name,
      pick_note: data.pick_note,
      candidate_count: data.candidate_count,
    };
    console.log(JSON.stringify(line));
    writeFileSync(OUT, `${JSON.stringify(line)}\n`, { flag: 'a' });
  }

  console.error(`[tv-sweep-150] done. Wrote ${OUT}`);
}

main();
