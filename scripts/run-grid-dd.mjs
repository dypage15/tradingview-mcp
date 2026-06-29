#!/usr/bin/env node
/**
 * Opinionated grid search: optimize for net profit minus drawdown penalty, with optional hard DD caps.
 * Defaults align with a $100k account and ~$2k DD budget — override any var in the environment first.
 *
 * Usage:
 *   npm run grid:dd
 *   GRID_MAX_DD_USD=0 npm run grid:dd   — disable USD hard cap (still net_dd objective)
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const grid = join(root, 'scripts', 'winrate-grid.mjs');

if (process.env.GRID_OBJECTIVE === undefined) process.env.GRID_OBJECTIVE = 'net_dd';
if (process.env.GRID_DD_WEIGHT === undefined) process.env.GRID_DD_WEIGHT = '3';
if (process.env.GRID_INITIAL_CAPITAL === undefined) process.env.GRID_INITIAL_CAPITAL = '100000';
if (process.env.GRID_MAX_DD_USD === undefined) process.env.GRID_MAX_DD_USD = '2000';

const child = spawn(process.execPath, [grid], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
