#!/usr/bin/env node
/**
 * Apply a row from data/secondary-sandbox-grid-results.jsonl to
 * Sweep Engine v2.0 — Secondary on the chart (sandbox mode, SL/TP × ATR, low-load flags).
 *
 * Default: best row by `score` (if present, from grid) else highest netProfit.
 *   node scripts/apply-secondary-grid-best.mjs
 * Apply only if grid beats current Strategy Tester (same objective as grid, see GRID_OBJECTIVE):
 *   node scripts/apply-secondary-grid-best.mjs --if-better
 * Specific run:
 *   node scripts/apply-secondary-grid-best.mjs --run=91
 *
 * Env:
 *   TV_GRID_RESULTS — path to JSONL (default: data/secondary-sandbox-grid-results.jsonl)
 *   TV_GRID_RUN — run number (overridden by --run=)
 *   TV_ENTITY_SECONDARY — entity id (default: first study matching /secondary/i)
 *   GRID_OBJECTIVE — net_dd | net | wr | pf (must match grid; default net_dd)
 *   GRID_DD_WEIGHT — for net_dd (default 2)
 *   SWEEP_RESTORE_DEFAULT_FILTERS=1 — also reset cooldown, confluence proximity, and max trades/day
 *     to Pine export defaults (8 bars, 1.5×ATR, 0 = off) to undo ad-hoc grid tuning.
 *   --restore-default-filters — same as the env flag
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tvCli = join(root, 'src/cli/index.js');
const DEFAULT_JSONL = join(root, 'data', 'secondary-sandbox-grid-results.jsonl');

const OBJECTIVE = (process.env.GRID_OBJECTIVE || 'net_dd').toLowerCase();
const DD_WEIGHT = Number(process.env.GRID_DD_WEIGHT || 2);

/** Same merge as scripts/secondary-sandbox-grid.mjs lowLoad */
const LOW_LOAD = { in_21: true, in_20: false };

/** Undo low-trades grid tweaks; matches sweep-engine-v2-export.pine defaults (your chart used these in_* slots). */
const DEFAULT_SIGNAL_FILTERS = {
  in_3: 8,
  in_11: 1.5,
  in_49: 0,
};

function execTv(args) {
  return execFileSync(process.execPath, [tvCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tvJson(args) {
  return JSON.parse(execTv(args));
}

const MODES = new Set(['None', 'VWAP', 'EMA200', 'VWAP+EMA200']);

function resolveSecondary() {
  const ex = (process.env.TV_ENTITY_SECONDARY || '').trim();
  if (ex) return ex;
  const st = tvJson(['state']);
  const hit = (st.studies || []).find((s) => /secondary/i.test(s.name || ''));
  if (!hit) throw new Error('No Secondary strategy on chart. Set TV_ENTITY_SECONDARY.');
  return hit.id;
}

function loadRows(jsonlPath) {
  const text = readFileSync(jsonlPath, 'utf8');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t));
  }
  if (!rows.length) throw new Error(`No rows in ${jsonlPath}`);
  return rows;
}

function parseRunArg(argv) {
  for (const a of argv) {
    const m = /^--run=(\d+)$/.exec(a);
    if (m) return Number(m[1]);
  }
  const i = argv.indexOf('--run');
  if (i >= 0 && argv[i + 1] != null && /^\d+$/.test(argv[i + 1])) {
    return Number(argv[i + 1]);
  }
  const env = (process.env.TV_GRID_RUN || '').trim();
  if (env && /^\d+$/.test(env)) return Number(env);
  return null;
}

function pickRow(rows, runNum) {
  if (runNum != null) {
    const r = rows.find((x) => x.run === runNum);
    if (!r) throw new Error(`Run ${runNum} not found in grid JSONL (${rows.length} rows)`);
    return r;
  }
  const scored = rows.filter((x) => typeof x.score === 'number' && Number.isFinite(x.score));
  if (scored.length === rows.length && scored.length > 0) {
    return scored.reduce((best, x) => {
      if (!best || x.score > best.score) return x;
      if (x.score === best.score && Number(x.netProfit) > Number(best.netProfit)) return x;
      return best;
    });
  }
  return rows.reduce((best, x) => {
    const np = Number(x.netProfit);
    if (!best || np > Number(best.netProfit)) return x;
    if (np === Number(best.netProfit) && x.run < best.run) return x;
    return best;
  });
}

/** Match scripts/secondary-sandbox-grid.mjs scoreObjective(metrics) */
function scoreFromMetrics(metrics) {
  const m = metrics || {};
  const net = m.netProfit;
  const dd = m.maxStrategyDrawDownPercent;
  const ddNum = typeof dd === 'number' && !Number.isNaN(dd) ? Math.abs(dd) : 0;
  if (OBJECTIVE === 'net') return typeof net === 'number' ? net : -1e30;
  if (OBJECTIVE === 'pf') return m.profitFactor ?? -1e30;
  if (OBJECTIVE === 'net_dd') {
    if (typeof net !== 'number') return -1e30;
    return net - DD_WEIGHT * ddNum;
  }
  const wr = m.percentProfitable;
  return typeof wr === 'number' ? wr : -1e30;
}

function resolveSandboxKey(row, indicatorInputs) {
  if (row.sandboxKey && typeof row.sandboxKey === 'string') {
    return row.sandboxKey;
  }
  for (const x of indicatorInputs || []) {
    if (MODES.has(x.value)) return x.id;
  }
  return 'in_61';
}

function wantRestoreFilters(argv) {
  if (argv.includes('--restore-default-filters')) return true;
  return process.env.SWEEP_RESTORE_DEFAULT_FILTERS === '1';
}

function wantIfBetter(argv) {
  return argv.includes('--if-better');
}

function main() {
  const argv = process.argv.slice(2);
  const jsonlPath = resolve(
    (process.env.TV_GRID_RESULTS || '').trim() || DEFAULT_JSONL
  );
  const rows = loadRows(jsonlPath);
  const runArg = parseRunArg(argv);
  const row = pickRow(rows, runArg);

  const entity = resolveSecondary();
  const j = tvJson(['indicator', 'get', entity]);
  const sandboxKey = resolveSandboxKey(row, j.inputs);

  if (!MODES.has(row.mode)) {
    throw new Error(`Invalid mode in JSONL run ${row.run}: ${JSON.stringify(row.mode)}`);
  }

  const maxDay =
    typeof row.maxTradesPerDay === 'number' && row.maxTradesPerDay >= 0
      ? row.maxTradesPerDay
      : Number(process.env.GRID_MAX_TRADES_PER_DAY ?? 1);

  const patch = {
    in_1: row.sl,
    in_2: row.tp,
    [sandboxKey]: row.mode,
    ...LOW_LOAD,
  };
  if (wantRestoreFilters(argv)) {
    Object.assign(patch, DEFAULT_SIGNAL_FILTERS);
  }
  if (maxDay > 0) {
    patch.in_49 = maxDay;
  }

  if (wantIfBetter(argv)) {
    process.env.ADVISOR_STRATEGY_SUBSTRING = process.env.ADVISOR_STRATEGY_SUBSTRING || 'Secondary';
    const cur = tvJson(['data', 'strategy']);
    const curMetrics = cur.metrics || {};
    const currentScore = scoreFromMetrics(curMetrics);
    const gridScore =
      typeof row.score === 'number' && Number.isFinite(row.score)
        ? row.score
        : scoreFromMetrics({
            netProfit: row.netProfit,
            maxStrategyDrawDownPercent: row.maxStrategyDrawDownPercent,
            profitFactor: row.profitFactor,
            percentProfitable: row.percentProfitable,
          });

    console.error(
      `[apply-grid] --if-better objective=${OBJECTIVE} currentScore=${currentScore} gridRun=${row.run} gridScore=${gridScore} (net=${curMetrics.netProfit} → grid net=${row.netProfit})`
    );

    if (!(gridScore > currentScore + 1e-9)) {
      console.error('[apply-grid] Skip: chart is not worse than grid best (no indicator changes).');
      return;
    }
    console.error('[apply-grid] Grid wins — applying inputs.');
  }

  console.error(
    `[apply-grid] jsonl=${jsonlPath} run=${row.run} netProfit=${row.netProfit} mode=${row.mode} sl=${row.sl} tp=${row.tp} maxTradesPerDay=${maxDay}${wantRestoreFilters(argv) ? ' +defaultFilters' : ''}`
  );
  console.error(`[apply-grid] entity=${entity} sandboxKey=${sandboxKey} patch=${JSON.stringify(patch)}`);
  execTv(['indicator', 'set', entity, '-i', JSON.stringify(patch)]);
  console.error('[apply-grid] Done. Strategy Tester will recalculate.');
}

main();
