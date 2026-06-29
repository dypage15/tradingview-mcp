#!/usr/bin/env node
/**
 * 300 cartesian runs on SEv2 Lite strategy (sweep-engine-v2-strategy.pine).
 *
 * Preflight (unless SEV2_GRID_SKIP_PREFLIGHT=1):
 *   - Chart timeframe → 5 (recommended for session sweeps)
 *   - Open Strategy Tester
 *   - Push repo Pine into editor + smart compile
 *   - Pause so the tester can finish one full recalculation before the grid hammers inputs
 *
 * Prereqs: TradingView Desktop + CDP 9222; SEv2 on chart. TV_STRATEGY_NAME defaults to SEv2 Strat.
 * Grid axes use 0-based TV ids: in_1=SL×ATR, in_2=TP×ATR, in_3=cooldown, in_20=sweep depth, in_21=sweep mode.
 *
 * Env:
 *   GRID_DELAY_MS — pause after each input set before reading metrics (default 7000)
 *   SEV2_TF_SETTLE_MS — after switching TF (default 12000)
 *   SEV2_POST_COMPILE_MS — after compile before grid (default 15000)
 *   SEV2_GRID_SKIP_PREFLIGHT=1 — only run winrate-grid
 *   GRID_OBJECTIVE — default balanced
 *
 * Usage: npm run grid:sev2-lite-300
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tvCli = join(root, 'src', 'cli', 'index.js');
const BUF = 50 * 1024 * 1024;

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function tv(args, label) {
  execFileSync(process.execPath, [tvCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    maxBuffer: BUF,
  });
}

const grid = {
  in_1: [3.5, 4.0, 4.5, 5.0, 5.5],
  in_2: [3.5, 4.0, 4.5, 5.0, 5.5],
  in_3: [4, 8, 12],
  in_20: [0, 0.1],
  in_21: [0, 2],
};
const n = grid.in_1.length * grid.in_2.length * grid.in_3.length * grid.in_20.length * grid.in_21.length;
if (n !== 300) {
  console.error(`[sev2-grid-300] Expected 300 combinations, got ${n}. Fix grid definition.`);
  process.exit(1);
}

if (process.env.SEV2_GRID_SKIP_PREFLIGHT !== '1') {
  console.error('[sev2-grid-300] preflight: 5m chart → Strategy Tester → Pine sync → settle...');
  try {
    tv(['timeframe', '5'], 'timeframe 5');
    sleepMs(Number(process.env.SEV2_TF_SETTLE_MS || 12000));
    tv(['ui', 'panel', 'pine-editor', 'open'], 'pine-editor');
    tv(['ui', 'panel', 'strategy-tester', 'open'], 'strategy-tester');
    sleepMs(2000);
    const pinePath = join(root, 'sweep-engine-v2-strategy.pine');
    if (existsSync(pinePath)) {
      tv(['pine', 'set', '--file', pinePath], 'pine set');
      sleepMs(800);
      tv(['pine', 'compile'], 'pine compile');
      sleepMs(Number(process.env.SEV2_POST_COMPILE_MS || 15000));
    } else {
      console.error('[sev2-grid-300] warning: sweep-engine-v2-strategy.pine not found, skip pine push');
    }
  } catch (e) {
    console.error('[sev2-grid-300] preflight error (is TradingView open?):', e?.message || e);
    console.error('[sev2-grid-300] continuing; use SEV2_GRID_SKIP_PREFLIGHT=1 to silence preflight.');
  }
} else {
  console.error('[sev2-grid-300] SEV2_GRID_SKIP_PREFLIGHT=1 — skipping chart/pine preflight');
}

const env = { ...process.env };
if (env.GRID_MAX_RUNS === undefined) env.GRID_MAX_RUNS = '300';
env.GRID_LOW_LOAD = '0';
env.GRID_CONFIG = JSON.stringify(grid);
env.TV_STRATEGY_NAME = env.TV_STRATEGY_NAME || 'SEv2 Strat';
if (!env.GRID_OBJECTIVE) env.GRID_OBJECTIVE = 'balanced';
if (env.GRID_DELAY_MS === undefined) env.GRID_DELAY_MS = '7000';

const capRuns = Number(env.GRID_MAX_RUNS || 300);
console.error(
  `[sev2-grid-300] grid combos=${n} (cartesian) capped at ${capRuns} | objective=${env.GRID_OBJECTIVE} | delayMs=${env.GRID_DELAY_MS} | TV_STRATEGY_NAME=${env.TV_STRATEGY_NAME} | GRID_LOW_LOAD=0`
);

const r = spawnSync(process.execPath, [join(root, 'scripts', 'winrate-grid.mjs')], {
  cwd: root,
  env,
  stdio: 'inherit',
});
process.exit(r.status === 0 ? 0 : r.status ?? 1);
