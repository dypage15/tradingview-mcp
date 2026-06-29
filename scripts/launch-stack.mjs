#!/usr/bin/env node
/**
 * One-shot launcher: ensures TradingView (CDP), optionally warms advisor data, starts the web dashboard.
 *
 * Usage:
 *   node scripts/launch-stack.mjs
 *   Double-click Launch-Everything.cmd (Windows)
 *   npm run stack
 *
 * Env (see .env.example):
 *   LAUNCH_STACK_SKIP_TV=1  — do not run `tv launch`; only wait for existing CDP
 *   LAUNCH_STACK_NO_WARM=1  — skip the initial quant-advisor snapshot
 */

import { execFileSync, spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { loadEnvFromRoot } from './lib/load-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tv = join(root, 'src/cli/index.js');
const node = process.execPath;
const BUF = 50 * 1024 * 1024;

const SKIP_TV = process.env.LAUNCH_STACK_SKIP_TV === '1';
const NO_WARM = process.env.LAUNCH_STACK_NO_WARM === '1';

function log(...a) {
  console.error('[stack]', ...a);
}

function tryStatus() {
  try {
    const o = execFileSync(node, [tv, 'status'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: BUF,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(o);
  } catch {
    return { success: false };
  }
}

function launchTv() {
  log('Starting TradingView with remote debugging (tv launch)...');
  execFileSync(node, [tv, 'launch'], {
    cwd: root,
    stdio: 'inherit',
    maxBuffer: BUF,
  });
}

async function ensureCdp() {
  let j = tryStatus();
  if (j.success) {
    log('Connected —', j.chart_symbol || '?', '@', j.chart_resolution || '?');
    return true;
  }

  if (SKIP_TV) {
    log('LAUNCH_STACK_SKIP_TV=1 but CDP is not up. Start TradingView with debugging on port 9222, then retry.');
    return false;
  }

  try {
    launchTv();
  } catch (e) {
    log('tv launch failed:', e.message || e);
    return false;
  }

  log('Waiting for Chrome DevTools (CDP)...');
  for (let i = 0; i < 25; i++) {
    await delay(2000);
    j = tryStatus();
    if (j.success) {
      log('Connected —', j.chart_symbol || '?', '@', j.chart_resolution || '?');
      return true;
    }
    log(`  ...still waiting (${i + 1}/25)`);
  }

  log('Could not connect to TradingView. Is the app running with remote debugging?');
  return false;
}

function warmAdvisorSnapshot() {
  const child = spawn(node, [join(root, 'scripts', 'quant-advisor.mjs')], {
    cwd: root,
    env: { ...process.env, ADVISOR_QUIET: '1' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  log('Background: quant-advisor snapshot started (see data/advisor-latest.json when done).');
}

async function main() {
  loadEnvFromRoot();

  log('Sweep stack launcher — TV CDP + advisor dashboard');
  log('');

  const ok = await ensureCdp();
  if (!ok) {
    process.exit(2);
  }

  if (!NO_WARM) {
    await delay(2500);
    warmAdvisorSnapshot();
  } else {
    log('Skipping warm snapshot (LAUNCH_STACK_NO_WARM=1).');
  }

  log('');
  log('Starting dashboard (close this window or Ctrl+C to stop the server)...');
  log('If port 4890 is busy, advisor-ui picks the next free port automatically.');
  log('');

  execFileSync(node, [join(root, 'scripts', 'advisor-ui.mjs')], {
    cwd: root,
    stdio: 'inherit',
    maxBuffer: BUF,
    env: process.env,
  });
}

main().catch((e) => {
  console.error('[stack] fatal:', e.message || e);
  process.exit(1);
});
