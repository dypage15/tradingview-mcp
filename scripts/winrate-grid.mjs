#!/usr/bin/env node
/**
 * Grid-search Sweep Engine v2 strategy inputs via tv CLI.
 *
 * Prereqs:
 *   - TradingView Desktop running with CDP (port 9222).
 *   - Strategy on chart (not indicator-only). Strategy Tester has run at least once.
 *
 * Usage:
 *   node scripts/winrate-grid.mjs
 *   set TV_ENTITY=...  (optional)
 *   set GRID_OBJECTIVE=net | wr | pf | balanced | net_dd
 *   set GRID_PRESET=all  +  GRID_SCENARIO_SUITE=optimal|core|quality|predictive|full
 *   set GRID_MAX_RUNS=200  GRID_TV_RETRIES=3  GRID_TV_RETRY_MS=2000
 *   set GRID_MIN_TRADES=15  (0 = off)
 *
 * Hard drawdown filters (reject combos — score = -∞, never "best"):
 *   set GRID_MAX_DD_PCT=2.5     — max Strategy Tester max DD % (same units as maxStrategyDrawDownPercent; 0 = off)
 *   set GRID_MAX_DD_USD=2000    — max estimated DD in account $ (uses metric $ if present, else pct × GRID_INITIAL_CAPITAL; 0 = off)
 *   set GRID_INITIAL_CAPITAL=100000  — must match strategy initial_capital when converting % → $ for USD cap
 *
 * Internal server / study errors during long grids:
 *   - Default GRID_SAFE_MODE=1 → slower pacing + low-load chart (fewer plots) on each run.
 *   - Override delay: GRID_DELAY_MS=4500
 *   - Disable low-load merge: GRID_LOW_LOAD=0 (more TV load; may error sooner)
 *
 * If the study stays broken until you remove & re-add it manually:
 *   GRID_END_REFRESH=1 — after the grid finishes, remove the study, wait, re-add by name, apply best inputs.
 *   TV_STRATEGY_ADD_NAME="Sweep Engine v2.0" — exact title TradingView uses in Indicators (your Pine name).
 *   GRID_START_REFRESH=1 — optional: remove/re-add once before the grid (clean slate).
 *   GRID_POST_REFRESH_MS=8000 — pause after remove before add (default 8000).
 *
 * Gentle pacing (recommended when TV has been flaky):
 *   GRID_PACE=slow — if unset, sets GRID_DELAY_MS=8000, COOLDOWN_ON_ERROR_MS=15000, POST_REFRESH_MS=15000
 *   (override any of those explicitly to tune).
 *
 * Progressive testing (one axis at a time, carry best forward — no full cartesian grid):
 *   GRID_PROGRESSIVE=1 — phases: tune in_1 → in_2 → in_3 → in_4 using GRID_BASELINE_JSON or grid midpoints as start.
 *   GRID_AXIS_ORDER=in_1,in_2,in_3,in_4 — optional override.
 *   GRID_BASELINE_JSON='{"in_1":4.5,"in_2":6,"in_3":4,"in_4":0}' — starting point before phase 1.
 *   Each log line includes phase, axis, anchor (fixed params), and value_tested so runs are comparable and distinct.
 *
 * PowerShell (progressive, slow pace, end refresh — typical for flaky TV):
 *   $env:GRID_PROGRESSIVE='1'; $env:GRID_PACE='slow'; $env:GRID_END_REFRESH='1'; node scripts/winrate-grid.mjs
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tv = join(root, 'src/cli/index.js');

if ((process.env.GRID_PACE || '').toLowerCase() === 'slow') {
  if (process.env.GRID_DELAY_MS === undefined) process.env.GRID_DELAY_MS = '8000';
  if (process.env.GRID_COOLDOWN_ON_ERROR_MS === undefined) process.env.GRID_COOLDOWN_ON_ERROR_MS = '15000';
  if (process.env.GRID_POST_REFRESH_MS === undefined) process.env.GRID_POST_REFRESH_MS = '15000';
}

const SAFE_GRID = process.env.GRID_SAFE_MODE !== '0'; // default on — reduces TV server overload
const DELAY_MS = Number(
  process.env.GRID_DELAY_MS ?? (SAFE_GRID ? 3500 : 1000)
);
const COOLDOWN_ON_BAD_MS = Number(process.env.GRID_COOLDOWN_ON_ERROR_MS || 8000);
const LOW_LOAD_MERGE = process.env.GRID_LOW_LOAD !== '0'; // merge light chart + no sweep dots
const MAX_RUNS = Number(process.env.GRID_MAX_RUNS || 200);
const OBJECTIVE = (process.env.GRID_OBJECTIVE || 'wr').toLowerCase();
const MIN_TRADES = Number(process.env.GRID_MIN_TRADES || 0);
const BALANCED_TRADE_REF = Number(process.env.GRID_BALANCED_TRADE_REF || 30);
const DD_WEIGHT = Number(process.env.GRID_DD_WEIGHT || 2);
/** 0 = disabled. Reject grid combos when Strategy Tester max DD% exceeds this. */
const GRID_MAX_DD_PCT = Number(process.env.GRID_MAX_DD_PCT || 0);
/** 0 = disabled. Reject when estimated max DD ($) exceeds this (aligns with Pine i_maxDdUsd-style caps). */
const GRID_MAX_DD_USD = Number(process.env.GRID_MAX_DD_USD || 0);
/** For USD cap when only % is available: must match `initial_capital` in the strategy(). */
const GRID_INITIAL_CAPITAL = Number(process.env.GRID_INITIAL_CAPITAL || 100000);
const TV_RETRIES = Number(process.env.GRID_TV_RETRIES || 3);
const TV_RETRY_MS = Number(process.env.GRID_TV_RETRY_MS || 2000);
const STRATEGY_NAME_HINT = (process.env.TV_STRATEGY_NAME || 'Sweep Engine v2.0').trim();
const STRATEGY_ADD_NAME = (process.env.TV_STRATEGY_ADD_NAME || STRATEGY_NAME_HINT).trim();
const POST_REFRESH_MS = Number(process.env.GRID_POST_REFRESH_MS || 8000);
const GRID_END_REFRESH = process.env.GRID_END_REFRESH === '1';
const GRID_START_REFRESH = process.env.GRID_START_REFRESH === '1';
const GRID_PROGRESSIVE = process.env.GRID_PROGRESSIVE === '1';
const BUF_LARGE = 50 * 1024 * 1024;

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

/** Run tv CLI with retries (CDP blips on Windows). */
function execTv(args, label) {
  let lastErr;
  for (let attempt = 1; attempt <= TV_RETRIES; attempt++) {
    try {
      return execFileSync(process.execPath, [tv, ...args], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: BUF_LARGE,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : String(e);
      console.error(`[tv] ${label} failed (${attempt}/${TV_RETRIES}): ${msg}`);
      if (attempt < TV_RETRIES) sleepMs(TV_RETRY_MS);
    }
  }
  throw lastErr;
}

function preflightTv() {
  try {
    const out = execTv(['status'], 'status');
    const j = JSON.parse(out);
    if (!j.success) {
      throw new Error('status returned success:false');
    }
    console.error(
      `[grid] CDP OK — ${j.chart_symbol || '?'} @ ${j.chart_resolution || '?'}`
    );
  } catch (e) {
    console.error(
      '[grid] Cannot reach TradingView (CDP).\n' +
        '  • Start TradingView Desktop with remote debugging on port 9222\n' +
        '  • Or run: node src/cli/index.js launch\n' +
        `  • ${e.message || e}`
    );
    process.exit(2);
  }
}

// Maps to Sweep Engine v2 export: in_1=SL×ATR, in_2=TP×ATR, in_3=cooldown, in_4=min confluence
// 5×5×4×2 = 200 combinations (cap with GRID_MAX_RUNS).
const defaultGrid = {
  in_1: [3.0, 3.5, 4.5, 5.0, 5.5],
  in_2: [4.0, 5.0, 5.5, 6.0, 7.0],
  in_3: [4, 6, 8, 12],
  in_4: [0, 1],
};

const PRESETS = {
  signal: {
    in_2: [3.5, 4.5, 5.5],
    in_3: [5, 5.5, 6],
    in_4: [4, 6, 8],
    in_5: [1, 2, 3],
  },
  trend_chop: {
    in_2: [4, 4.5, 5],
    in_3: [5.5, 6],
    in_4: [4, 6],
    in_5: [2, 3],
    in_27: [true],
    in_28: ['60'],
    in_29: [20],
    in_30: [true],
    in_31: [20],
    in_32: [0.8, 0.85, 0.9],
    in_33: [false],
    in_34: [14],
    in_35: [0],
    in_36: [0],
  },
  trend_chop_adx: {
    in_2: [4, 4.5],
    in_3: [5.5, 6],
    in_4: [4, 6],
    in_5: [2, 3],
    in_27: [true],
    in_28: ['60'],
    in_29: [20],
    in_30: [true],
    in_31: [20],
    in_32: [0.85],
    in_33: [true],
    in_34: [14],
    in_35: [12, 15, 18],
    in_36: [0],
  },
  quality_sample: {
    in_2: [4, 4.5],
    in_3: [5.5, 6],
    in_4: [4, 6],
    in_5: [2, 3],
    in_37: [0, 0.15, 0.25],
    in_38: [false, true],
    in_47: [false, true],
  },
  quality_stack: {
    in_2: [4.5, 5],
    in_3: [5.5, 6],
    in_4: [6, 8],
    in_5: [2, 3],
    in_37: [0, 0.12],
    in_38: [true],
    in_41: [false, true],
    in_47: [false],
  },
  reactive_baseline: {
    in_2: [3.5, 4.5, 5.5],
    in_3: [5, 5.5, 6],
    in_4: [4, 6, 8],
    in_5: [1, 2, 3],
    in_53: ['Reactive sweep (close)'],
  },
  predictive_tuned: {
    in_2: [4.5, 5],
    in_3: [5.5, 6],
    in_4: [6, 8],
    in_5: [2, 3],
    in_53: ['Predictive limit (model)'],
    in_54: [58, 68],
    in_55: [0.06, 0.12],
  },
  regime_adx_tight: {
    in_2: [4, 4.5],
    in_3: [5.5, 6],
    in_4: [4, 6],
    in_5: [2, 3],
    in_27: [true],
    in_28: ['60'],
    in_29: [20],
    in_30: [true],
    in_31: [20],
    in_32: [0.85, 0.9],
    in_33: [true],
    in_34: [14],
    in_35: [15, 18],
    in_36: [0],
  },
};

const SCENARIO_SUITES = {
  core: ['signal', 'trend_chop', 'trend_chop_adx'],
  optimal: ['signal', 'trend_chop', 'trend_chop_adx', 'quality_stack'],
  quality: ['signal', 'quality_stack', 'quality_sample', 'trend_chop'],
  predictive: ['reactive_baseline', 'predictive_tuned', 'signal'],
  full: [
    'signal',
    'trend_chop',
    'trend_chop_adx',
    'regime_adx_tight',
    'quality_stack',
    'quality_sample',
    'reactive_baseline',
    'predictive_tuned',
  ],
};

function tvJson(args, maxBuffer = 10 * 1024 * 1024) {
  const out = execTv(args, args.join(' '));
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`tv JSON parse failed: ${e.message}\nstdout: ${String(out).slice(0, 400)}`);
  }
}

function isPineStrategyInputs(inputs) {
  if (!Array.isArray(inputs)) return false;
  const pf = inputs.find((i) => i.id === 'pineFeatures');
  if (!pf || typeof pf.value !== 'string') return false;
  try {
    const j = JSON.parse(pf.value);
    return j.strategy === 1;
  } catch {
    return false;
  }
}

/**
 * Remove + re-add study (same workaround as doing it manually when TV gets stuck after many indicator sets).
 * Returns new entity id, or null on failure.
 */
function refreshStudyRemoveAdd(oldEntity) {
  console.error(
    `[grid] Refresh: remove ${oldEntity} → wait ${POST_REFRESH_MS}ms → add "${STRATEGY_ADD_NAME}"`
  );
  try {
    execTv(['indicator', 'remove', oldEntity], 'indicator remove');
  } catch (e) {
    console.error('[grid] refresh remove failed:', e.message);
    return null;
  }
  sleepMs(POST_REFRESH_MS);
  try {
    const out = execTv(['indicator', 'add', STRATEGY_ADD_NAME], 'indicator add');
    const j = JSON.parse(out);
    if (!j.success) console.error('[grid] indicator add returned success:false', out);
  } catch (e) {
    console.error(
      '[grid] refresh add failed — re-add your Pine strategy manually from the editor:',
      e.message
    );
    return null;
  }
  sleepMs(4000);
  try {
    const next = resolveStrategyEntity();
    console.error(`[grid] Refreshed study entity: ${next}`);
    return next;
  } catch (e) {
    console.error('[grid] Could not resolve strategy after re-add:', e.message);
    return null;
  }
}

function applyBestInputs(entityId, bestResult) {
  if (!entityId || !bestResult || !bestResult.inputs || typeof bestResult.inputs !== 'object') return;
  try {
    const inputs = JSON.stringify(bestResult.inputs);
    execTv(['indicator', 'set', entityId, '-i', inputs], 'apply best after refresh');
    console.error('[grid] Best grid inputs applied to refreshed study.');
  } catch (e) {
    console.error('[grid] apply best inputs failed:', e.message);
  }
}

function resolveStrategyEntity() {
  const explicit = (process.env.TV_ENTITY || '').trim();
  if (explicit) {
    console.error(`Using TV_ENTITY=${explicit}`);
    return explicit;
  }
  const state = tvJson(['state']);
  const studies = state.studies || [];
  const hint = STRATEGY_NAME_HINT.toLowerCase();
  const candidates = hint
    ? studies.filter((s) => (s.name || '').toLowerCase().includes(hint))
    : studies;
  const ordered = candidates.length ? candidates : studies;
  for (const s of ordered) {
    try {
      const info = tvJson(['indicator', 'get', s.id]);
      if (info.success && isPineStrategyInputs(info.inputs)) {
        console.error(`Auto-selected Pine strategy: ${s.id} — ${s.name}`);
        return s.id;
      }
    } catch {
      /* next */
    }
  }
  throw new Error(
    'No Pine strategy on chart (pineFeatures.strategy). Set TV_ENTITY or TV_STRATEGY_NAME.'
  );
}

/** Fewer plots/markers while grid runs — matches Sweep v2: in_20=raw sweeps, in_21=light chart */
const LOW_LOAD_INPUTS = { in_21: true, in_20: false };

function mergeInputs(overrides) {
  if (!LOW_LOAD_MERGE) return overrides;
  return { ...LOW_LOAD_INPUTS, ...overrides };
}

function fetchStrategyMetrics(entity) {
  const out = execTv(['data', 'strategy'], 'data strategy');
  return JSON.parse(out);
}

/** Wait for tester/strategy after input churn; retry once if empty/error */
function fetchStrategyMetricsStable(entity, label) {
  let data = fetchStrategyMetrics(entity);
  const bad = (d) => {
    if (!d) return true;
    if (d.error) return true;
    const m = d.metrics || {};
    return Object.keys(m).length === 0;
  };
  if (bad(data)) {
    console.error(`[${label}] soft-fail metrics, cooling ${COOLDOWN_ON_BAD_MS}ms then retry once`);
    sleepMs(COOLDOWN_ON_BAD_MS);
    data = fetchStrategyMetrics(entity);
  }
  return data;
}

function slimMetrics(m) {
  if (!m || typeof m !== 'object') return m;
  const keep = [
    'netProfit',
    'netProfitPercent',
    'percentProfitable',
    'profitFactor',
    'totalTrades',
    'grossProfit',
    'grossLoss',
    'maxStrategyDrawDownPercent',
    'maxStrategyDrawDown',
    'commissionPaid',
  ];
  const o = {};
  for (const k of keep) {
    if (m[k] !== undefined && m[k] !== null) o[k] = m[k];
  }
  return Object.keys(o).length ? o : { note: 'no KPI keys' };
}

function extractWinRate(metrics) {
  if (!metrics || typeof metrics !== 'object') return { value: -1, raw: null };
  const keys = Object.keys(metrics);
  const prefer = [
    'percentProfitable',
    'Percent profitable',
    'Profitable trades',
    'percent_profitable',
    'winRate',
    'Win rate',
  ];
  for (const k of prefer) {
    if (metrics[k] !== undefined && metrics[k] !== null) {
      const v = metrics[k];
      if (typeof v === 'number' && !Number.isNaN(v)) return { value: v, raw: { key: k, v } };
      if (typeof v === 'string') {
        const m = v.match(/([\d.]+)\s*%/);
        if (m) return { value: parseFloat(m[1]), raw: { key: k, v } };
      }
    }
  }
  for (const k of keys) {
    const v = metrics[k];
    if (typeof v === 'string' && /%/.test(v) && /win|profit|percent/i.test(k)) {
      const m = v.match(/([\d.]+)/);
      if (m) return { value: parseFloat(m[1]), raw: { key: k, v } };
    }
  }
  return { value: -1, raw: metrics };
}

function numMetric(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

/** Strategy Tester max equity drawdown % (same key the net_dd objective uses). */
function extractDdPct(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const prefer = ['maxStrategyDrawDownPercent'];
  for (const k of prefer) {
    if (metrics[k] !== undefined && metrics[k] !== null) {
      const v = numMetric(metrics[k]);
      if (v !== null) return Math.abs(v);
    }
  }
  for (const key of Object.keys(metrics)) {
    if (/maxStrategyDrawDownPercent/i.test(key)) {
      const v = numMetric(metrics[key]);
      if (v !== null) return Math.abs(v);
    }
  }
  return null;
}

/** Prefer explicit $ DD from tester; else pct × initial capital (percent is 0–100, e.g. 2.5 = 2.5%). */
function estimateDdUsdFromMetrics(metrics, initialCapital) {
  if (!metrics || typeof metrics !== 'object') return null;
  const usdKeys = ['maxStrategyDrawDown', 'maxDrawdown'];
  for (const k of usdKeys) {
    if (metrics[k] !== undefined && metrics[k] !== null) {
      const v = numMetric(metrics[k]);
      if (v !== null) return Math.abs(v);
    }
  }
  const pct = extractDdPct(metrics);
  if (pct !== null && initialCapital > 0) return (initialCapital * pct) / 100;
  return null;
}

/** Optional hard caps — combos that violate never win the grid. */
function hardDdReject(metrics) {
  if (GRID_MAX_DD_PCT > 0) {
    const pct = extractDdPct(metrics);
    if (pct !== null && pct > GRID_MAX_DD_PCT) {
      return { reject: true, reason: 'dd_pct', detail: `${pct} > ${GRID_MAX_DD_PCT}` };
    }
  }
  if (GRID_MAX_DD_USD > 0) {
    const usd = estimateDdUsdFromMetrics(metrics, GRID_INITIAL_CAPITAL);
    if (usd !== null && usd > GRID_MAX_DD_USD) {
      return { reject: true, reason: 'dd_usd', detail: `${usd.toFixed(2)} > ${GRID_MAX_DD_USD}` };
    }
  }
  return { reject: false };
}

function scoreForObjective(metrics) {
  const trades = metrics.totalTrades;
  if (MIN_TRADES > 0 && (typeof trades !== 'number' || trades < MIN_TRADES)) {
    return {
      value: Number.NEGATIVE_INFINITY,
      key: 'minTrades',
      raw: { trades, required: MIN_TRADES },
    };
  }
  if (OBJECTIVE === 'net') {
    const v = metrics.netProfit;
    if (typeof v === 'number' && !Number.isNaN(v)) return { value: v, key: 'netProfit' };
    return { value: Number.NEGATIVE_INFINITY, key: 'netProfit' };
  }
  if (OBJECTIVE === 'pf') {
    const v = metrics.profitFactor;
    if (typeof v === 'number' && !Number.isNaN(v)) return { value: v, key: 'profitFactor' };
    return { value: Number.NEGATIVE_INFINITY, key: 'profitFactor' };
  }
  if (OBJECTIVE === 'balanced') {
    const net = metrics.netProfit;
    const pf = metrics.profitFactor;
    const t = typeof trades === 'number' ? trades : 0;
    if (typeof net !== 'number' || Number.isNaN(net)) {
      return { value: Number.NEGATIVE_INFINITY, key: 'balanced' };
    }
    const tradeScale = Math.min(1, t / Math.max(BALANCED_TRADE_REF, 1));
    const pfBoost = typeof pf === 'number' && !Number.isNaN(pf) && pf > 0 ? Math.min(pf / 1.4, 1.35) : 0.65;
    return { value: net * tradeScale * pfBoost, key: 'balanced' };
  }
  if (OBJECTIVE === 'net_dd') {
    const net = metrics.netProfit;
    const dd = metrics.maxStrategyDrawDownPercent;
    if (typeof net !== 'number' || Number.isNaN(net)) {
      return { value: Number.NEGATIVE_INFINITY, key: 'net_dd' };
    }
    const ddNum = typeof dd === 'number' && !Number.isNaN(dd) ? Math.abs(dd) : 0;
    return { value: net - DD_WEIGHT * ddNum, key: 'net_dd' };
  }
  const wr = extractWinRate(metrics);
  const v = wr.value < 0 ? Number.NEGATIVE_INFINITY : wr.value;
  return { value: v, key: 'percentProfitable', raw: wr.raw };
}

function cartesianProduct(grid) {
  const keys = Object.keys(grid);
  let rows = [{}];
  for (const k of keys) {
    const next = [];
    for (const row of rows) {
      for (const v of grid[k]) {
        next.push({ ...row, [k]: v });
      }
    }
    rows = next;
  }
  return rows;
}

function resolveGrid() {
  if (process.env.GRID_CONFIG) {
    return JSON.parse(process.env.GRID_CONFIG);
  }
  const preset = (process.env.GRID_PRESET || '').trim().toLowerCase();
  if (preset && preset !== 'default' && preset !== 'all' && PRESETS[preset]) {
    console.error(`Using GRID_PRESET=${preset}`);
    return PRESETS[preset];
  }
  if (preset === 'default' || !preset || preset === 'all') {
    return defaultGrid;
  }
  console.error(`Unknown GRID_PRESET="${preset}", using default`);
  return defaultGrid;
}

const DEFAULT_AXIS_ORDER = ['in_1', 'in_2', 'in_3', 'in_4'];

function orderedAxes(grid) {
  const envOrder = (process.env.GRID_AXIS_ORDER || '').trim();
  if (envOrder) {
    return envOrder
      .split(',')
      .map((s) => s.trim())
      .filter((k) => k && grid[k] && Array.isArray(grid[k]));
  }
  const keys = Object.keys(grid);
  const head = DEFAULT_AXIS_ORDER.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !head.includes(k));
  return head.concat(rest);
}

function parseBaseline(grid) {
  if (process.env.GRID_BASELINE_JSON) {
    try {
      return JSON.parse(process.env.GRID_BASELINE_JSON);
    } catch (e) {
      console.error('[grid] GRID_BASELINE_JSON parse failed, using midpoints:', e.message);
    }
  }
  const o = {};
  for (const k of Object.keys(grid)) {
    const arr = grid[k];
    o[k] = arr[Math.floor(arr.length / 2)];
  }
  return o;
}

function stripGridParams(merged, grid) {
  const o = {};
  for (const k of Object.keys(grid)) {
    if (merged[k] !== undefined) o[k] = merged[k];
  }
  return o;
}

/**
 * One indicator set + metrics read. Returns null on failure.
 */
function evaluateCombo(entity, merged, label, n, extraMeta = {}) {
  const inputs = JSON.stringify(merged);
  try {
    execTv(['indicator', 'set', entity, '-i', inputs], 'indicator set');
  } catch (e) {
    console.error('indicator set failed after retries', e.message);
    sleepMs(COOLDOWN_ON_BAD_MS);
    return null;
  }
  sleepMs(DELAY_MS);
  let data;
  try {
    data = fetchStrategyMetricsStable(entity, `${label}#${n}`);
  } catch (e) {
    console.error('data strategy failed', e.message);
    sleepMs(COOLDOWN_ON_BAD_MS);
    return null;
  }
  if (!data.success && data.error) {
    console.error('strategy metrics error', data.error);
    sleepMs(COOLDOWN_ON_BAD_MS);
    return null;
  }
  const metrics = data.metrics || (data.result && data.result.metrics) || {};
  const hard = hardDdReject(metrics);
  if (hard.reject) {
    const score = Number.NEGATIVE_INFINITY;
    const line = {
      ...extraMeta,
      scenario: extraMeta.scenario != null ? extraMeta.scenario : label,
      n,
      score,
      key: 'hard_dd',
      hard_reject: true,
      hard_reason: hard.reason,
      hard_detail: hard.detail,
      overrides: merged,
      dd_pct: extractDdPct(metrics),
      dd_usd_est: estimateDdUsdFromMetrics(metrics, GRID_INITIAL_CAPITAL),
    };
    console.log(JSON.stringify(line));
    return { score, key: 'hard_dd', raw: hard, metrics, merged, hardReject: true };
  }
  const { value: score, key, raw } = scoreForObjective(metrics);
  const line = {
    ...extraMeta,
    scenario: extraMeta.scenario != null ? extraMeta.scenario : label,
    n,
    score,
    key,
    overrides: merged,
    raw_hint: raw ?? null,
    dd_pct: extractDdPct(metrics),
    dd_usd_est: estimateDdUsdFromMetrics(metrics, GRID_INITIAL_CAPITAL),
  };
  console.log(JSON.stringify(line));
  return { score, key, raw, metrics, merged, hardReject: false };
}

function runProgressiveGrid(entity, grid, scenarioLabel) {
  const axes = orderedAxes(grid);
  const label = scenarioLabel || 'progressive';
  let anchor = parseBaseline(grid);
  for (const k of axes) {
    if (anchor[k] === undefined && grid[k]?.length) anchor[k] = grid[k][0];
  }
  console.error(
    `[${label}] PROGRESSIVE mode — ${axes.length} phases (${axes.join(' → ')}), objective=${OBJECTIVE}` +
      ` delayMs=${DELAY_MS} anchor=${JSON.stringify(anchor)}`
  );
  if (LOW_LOAD_MERGE) {
    console.error('[grid] Low-load merge still applied each run (in_21, in_20).');
  }

  let bestOverall = {
    score: Number.NEGATIVE_INFINITY,
    objective: OBJECTIVE,
    inputs: null,
    metrics: null,
    key: null,
    entity_id: entity,
    scenario: label,
  };
  let n = 0;

  phaseLoop: for (let p = 0; p < axes.length; p++) {
    const axis = axes[p];
    const values = grid[axis];
    if (!values || !values.length) continue;

    let bestPhase = {
      score: Number.NEGATIVE_INFINITY,
      inputs: null,
      metrics: null,
      key: null,
      value: null,
    };

    console.error(`\n--- Phase ${p + 1}/${axes.length}: vary ${axis} (${values.length} values), fixed others=${JSON.stringify(anchor)} ---`);

    for (const value of values) {
      if (n >= MAX_RUNS) {
        console.error(`[${label}] stopped: reached GRID_MAX_RUNS=${MAX_RUNS}`);
        break phaseLoop;
      }
      n++;
      const overrides = { ...anchor, [axis]: value };
      const merged = mergeInputs(overrides);
      const fixedOthers = { ...anchor };
      const meta = {
        mode: 'progressive',
        phase: p + 1,
        phase_total: axes.length,
        axis,
        value_tested: value,
        anchor_before: { ...fixedOthers },
        scenario: label,
      };
      const ev = evaluateCombo(entity, merged, label, n, meta);
      if (!ev) continue;
      if (ev.score > bestOverall.score) {
        bestOverall = {
          score: ev.score,
          objective: OBJECTIVE,
          key: ev.key,
          inputs: ev.merged,
          metrics: slimMetrics(ev.metrics),
          entity_id: entity,
          scenario: label,
        };
      }
      if (ev.score > bestPhase.score) {
        bestPhase = {
          score: ev.score,
          inputs: ev.merged,
          metrics: ev.metrics,
          key: ev.key,
          value,
        };
      }
    }

    if (n >= MAX_RUNS) break;

    if (bestPhase.inputs) {
      anchor = stripGridParams(bestPhase.inputs, grid);
      console.error(
        `[${label}] phase ${p + 1} best ${axis}=${bestPhase.value} score=${bestPhase.score} → carry forward anchor=${JSON.stringify(anchor)}`
      );
    } else {
      console.error(`[${label}] phase ${p + 1} had no valid runs; anchor unchanged`);
    }
  }

  console.error(`\n=== BEST [${label}] progressive (by ${OBJECTIVE}) ===`);
  console.log(JSON.stringify(bestOverall, null, 2));
  return bestOverall;
}

function runOneGrid(entity, grid, scenarioLabel) {
  const combos = cartesianProduct(grid);
  const runs = combos.slice(0, MAX_RUNS);
  const label = scenarioLabel || 'grid';
  console.error(
    `[${label}] combinations (capped at ${MAX_RUNS}): ${runs.length}, objective=${OBJECTIVE}` +
      ` delayMs=${DELAY_MS} safeMode=${SAFE_GRID} lowLoadMerge=${LOW_LOAD_MERGE}`
  );
  if (LOW_LOAD_MERGE) {
    console.error(
      '[grid] Low-load display merged each run (in_21=true, in_20=false). Set GRID_LOW_LOAD=0 for full chart draw load.'
    );
  }

  let best = {
    score: Number.NEGATIVE_INFINITY,
    objective: OBJECTIVE,
    inputs: null,
    metrics: null,
    key: null,
    entity_id: entity,
    scenario: scenarioLabel || null,
  };
  let n = 0;
  for (const overrides of runs) {
    n++;
    const merged = mergeInputs(overrides);
    const ev = evaluateCombo(entity, merged, label, n, {
      mode: 'cartesian',
      scenario: scenarioLabel || label,
    });
    if (!ev) continue;
    if (ev.score > best.score) {
      best = {
        score: ev.score,
        objective: OBJECTIVE,
        key: ev.key,
        inputs: ev.merged,
        metrics: slimMetrics(ev.metrics),
        entity_id: entity,
        scenario: scenarioLabel || null,
      };
    }
  }

  console.error(`\n=== BEST [${label}] (by ${OBJECTIVE}) ===`);
  console.log(JSON.stringify(best, null, 2));
  return best;
}

function main() {
  preflightTv();
  if (GRID_MAX_DD_PCT > 0 || GRID_MAX_DD_USD > 0) {
    console.error(
      `[grid] Hard DD filters: GRID_MAX_DD_PCT=${GRID_MAX_DD_PCT || 'off'} GRID_MAX_DD_USD=${GRID_MAX_DD_USD || 'off'} GRID_INITIAL_CAPITAL=${GRID_INITIAL_CAPITAL} (must match strategy initial_capital for USD cap from %)`
    );
  }

  let entity;
  try {
    entity = resolveStrategyEntity();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const multi = (process.env.GRID_PRESET || '').trim().toLowerCase() === 'all';
  if (multi) {
    const suiteKey = (process.env.GRID_SCENARIO_SUITE || 'optimal').trim().toLowerCase();
    const scenarioNames = SCENARIO_SUITES[suiteKey];
    if (!scenarioNames || !scenarioNames.length) {
      console.error(`Unknown GRID_SCENARIO_SUITE="${suiteKey}". Use: ${Object.keys(SCENARIO_SUITES).join(', ')}`);
      process.exit(1);
    }
    const missing = scenarioNames.filter((n) => !PRESETS[n]);
    if (missing.length) {
      console.error(`Missing PRESETS: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.error(
      `GRID_PRESET=all suite="${suiteKey}" scenarios: ${scenarioNames.join(' → ')} objective=${OBJECTIVE}` +
        (MIN_TRADES > 0 ? ` minTrades=${MIN_TRADES}` : '')
    );
    const results = [];
    for (const name of scenarioNames) {
      results.push(runOneGrid(entity, PRESETS[name], name));
    }
    const ranked = results
      .filter((r) => r && typeof r.score === 'number' && r.score > Number.NEGATIVE_INFINITY)
      .sort((a, b) => b.score - a.score);
    console.error(`\n=== TOP ACROSS SCENARIOS (by ${OBJECTIVE}) ===`);
    console.log(JSON.stringify(ranked[0] || { note: 'no valid runs' }, null, 2));
    console.error('\n=== RANKED SCENARIOS ===');
    console.log(
      JSON.stringify(
        ranked.map((r) => ({ scenario: r.scenario, score: r.score, key: r.key, metrics: r.metrics })),
        null,
        2
      )
    );
    if (GRID_END_REFRESH && ranked[0]) {
      const ne = refreshStudyRemoveAdd(entity);
      applyBestInputs(ne, ranked[0]);
    }
    process.exit(0);
  }

  const grid = resolveGrid();
  if (GRID_START_REFRESH) {
    const ne = refreshStudyRemoveAdd(entity);
    if (ne) entity = ne;
  }
  const presetLabel = process.env.GRID_PRESET || 'default';
  const best = GRID_PROGRESSIVE
    ? runProgressiveGrid(entity, grid, presetLabel)
    : runOneGrid(entity, grid, presetLabel);
  if (GRID_END_REFRESH) {
    const ne = refreshStudyRemoveAdd(entity);
    applyBestInputs(ne, best);
  }
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error('[grid] fatal:', e.message || e);
  process.exit(1);
}
