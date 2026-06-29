#!/usr/bin/env node
/**
 * Launcher for scenario grid with defaults and optional retries on CDP failure (exit 2).
 *
 * Usage:
 *   node scripts/run-scenarios.mjs
 *   GRID_SMOKE=1 node scripts/run-scenarios.mjs   (small grid for testing)
 *
 * Env (optional):
 *   GRID_PRESET=all (default)
 *   GRID_SCENARIO_SUITE=optimal
 *   GRID_OBJECTIVE=net
 *   GRID_MAX_RUNS=120
 *   GRID_RUN_ATTEMPTS=3
 *   GRID_SAFE_MODE=1 (default in winrate-grid) — slower pacing + low-load chart to avoid TV internal server errors
 */

import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gridScript = join(root, 'scripts', 'winrate-grid.mjs');

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

const env = { ...process.env };
if (!env.GRID_PRESET) env.GRID_PRESET = 'all';
if (!env.GRID_SCENARIO_SUITE) env.GRID_SCENARIO_SUITE = 'optimal';
if (!env.GRID_OBJECTIVE) env.GRID_OBJECTIVE = 'net';
if (env.GRID_SMOKE === '1') {
  env.GRID_MAX_RUNS = env.GRID_MAX_RUNS || '12';
  env.GRID_DELAY_MS = env.GRID_DELAY_MS || '2500';
  env.GRID_SCENARIO_SUITE = env.GRID_SCENARIO_SUITE || 'core';
}

const maxAttempts = Number(env.GRID_RUN_ATTEMPTS || 3);

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const r = spawnSync(process.execPath, [gridScript], {
    cwd: root,
    env,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  const code = r.status ?? 1;
  if (code === 0) {
    process.exit(0);
  }
  if (code === 2 && attempt < maxAttempts) {
    console.error(`\n[run-scenarios] CDP / TV not ready (exit ${code}). Retry ${attempt + 1}/${maxAttempts} in 4s...\n`);
    sleepMs(4000);
    continue;
  }
  console.error(`\n[run-scenarios] stopped with exit ${code}`);
  process.exit(code);
}
