#!/usr/bin/env node
/**
 * Does the hands-on TradingView Desktop steps you'd otherwise do manually:
 * 1. Ensure CDP (optional launch)
 * 2. Set chart symbol + timeframe (defaults: MNQ continuous, 5m)
 * 3. Open Pine editor (retries — TV sometimes needs a beat after focus)
 * 4. Inject data/erl-irl-evaluator-strategy.pine
 * 5. Smart compile (no stale-parse recovery unless ERL_TV_COMPILE_RECOVER=1)
 * 6. Open Strategy Tester
 * 7. Optional: attach study by title (ERL_TV_INDICATOR_ADD=1)
 *
 * Env:
 *   ERL_TV_SYMBOL   — default CME_MINI:MNQ1!
 *   ERL_TV_TIMEFRAME — default 5
 *   ERL_TV_SKIP_LAUNCH — set 1 if TV is already up (still checks status first)
 *   ERL_TV_PINE_PATH — absolute path override to .pine file
 *   ERL_TV_INDICATOR_ADD — set 1 to run: tv indicator add "ERL IRL Evaluator [NLF]"
 *   ERL_TV_COMPILE_RECOVER — set 1 to pass pine compile --recover
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TV = join(ROOT, 'src', 'cli', 'index.js');
const NODE = process.execPath;
const BUF = 50 * 1024 * 1024;

const SYMBOL = process.env.ERL_TV_SYMBOL || 'CME_MINI:MNQ1!';
const TF = process.env.ERL_TV_TIMEFRAME || '5';
const SKIP_LAUNCH = process.env.ERL_TV_SKIP_LAUNCH === '1';
const PINE_PATH =
  process.env.ERL_TV_PINE_PATH || join(ROOT, 'data', 'erl-irl-evaluator-strategy.pine');
const DO_INDICATOR_ADD = process.env.ERL_TV_INDICATOR_ADD === '1';
const COMPILE_FLAGS = process.env.ERL_TV_COMPILE_RECOVER === '1' ? ['--recover'] : [];

function log(...a) {
  console.error('[erl-eval-sync]', ...a);
}

function tv(args, inherit = false) {
  const r = spawnSync(NODE, [TV, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: BUF,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (inherit) return { ok: r.status === 0, stderr: r.stderr || '' };
  const out = String(r.stdout || '').trim();
  let json = null;
  try {
    json = out ? JSON.parse(out) : null;
  } catch {
    json = { _raw: out, _stderr: r.stderr };
  }
  return { ok: r.status === 0, json, stderr: r.stderr || '', raw: out };
}

function tvJson(args) {
  const { ok, json, stderr, raw } = tv(args);
  return { ok, json, stderr, raw };
}

function tryStatus() {
  const j = tvJson(['status']);
  return j.ok && j.json?.success === true ? j.json : null;
}

function launchTv() {
  execFileSync(NODE, [TV, 'launch'], { cwd: ROOT, stdio: 'inherit', maxBuffer: BUF });
}

async function ensureCdp() {
  let st = tryStatus();
  if (st) {
    log('CDP OK', st.chart_symbol || '?', '@', st.chart_resolution || '?');
    return true;
  }
  if (SKIP_LAUNCH) {
    log('Not connected — start TradingView Desktop with debugging (port 9222) or omit ERL_TV_SKIP_LAUNCH=1.');
    return false;
  }
  log('Launching TradingView (tv launch)...');
  try {
    launchTv();
  } catch (e) {
    log('Launch failed:', e.message || e);
    return false;
  }
  for (let i = 0; i < 30; i++) {
    await delay(2000);
    st = tryStatus();
    if (st) {
      log('CDP OK after wait');
      return true;
    }
  }
  log('Timed out waiting for CDP.');
  return false;
}

async function pineEditorOpenRetries() {
  for (let a = 1; a <= 5; a++) {
    const r = tvJson(['ui', 'panel', 'pine-editor', 'open']);
    if (r.json?.success) {
      log('Pine editor open OK (attempt', a + ')');
      return true;
    }
    log('Pine editor open attempt', a, 'failed:', r.json?.error || r.stderr || r.raw);
    await delay(1500);
  }
  return false;
}

async function pineSetRetries() {
  if (!existsSync(PINE_PATH)) {
    throw new Error(`Missing Pine file: ${PINE_PATH}`);
  }
  for (let a = 1; a <= 8; a++) {
    const r = tvJson(['pine', 'set', '-f', PINE_PATH]);
    if (r.json?.success) {
      log('pine set OK, lines:', r.json.lines_set ?? '?');
      return true;
    }
    log('pine set attempt', a, ':', r.json?.error || r.stderr || 'failed');
    await delay(2500);
  }
  return false;
}

async function main() {
  if (!(await ensureCdp())) {
    console.log(JSON.stringify({ success: false, step: 'cdp', error: 'No CDP / TradingView' }, null, 2));
    process.exitCode = 2;
    return;
  }

  let r = tvJson(['symbol', SYMBOL]);
  log('symbol', r.json?.success ? 'OK' : r.json?.error || r.raw);

  r = tvJson(['timeframe', TF]);
  log('timeframe', r.json?.success ? 'OK' : r.json?.error || r.raw);

  if (!(await pineEditorOpenRetries())) {
    console.log(
      JSON.stringify(
        {
          success: false,
          step: 'pine_editor',
          hint: 'Click Pine Editor manually in TV, focus the desktop window, re-run.',
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  await delay(1800);

  if (!(await pineSetRetries())) {
    console.log(
      JSON.stringify(
        { success: false, step: 'pine_set', pine_path: PINE_PATH.replace(/\\/g, '/') },
        null,
      ),
      2,
    );
    process.exitCode = 1;
    return;
  }

  r = tvJson(['pine', 'compile', ...COMPILE_FLAGS]);
  const compileRes = r.json;
  log('pine compile', compileRes?.success !== false && !compileRes?.has_errors ? 'done' : compileRes?.error || r.stderr);

  r = tvJson(['ui', 'panel', 'strategy-tester', 'open']);
  log('strategy tester panel', r.json?.success ? 'open' : r.json?.error || r.stderr);

  let attach = null;
  if (DO_INDICATOR_ADD) {
    attach = tvJson(['indicator', 'add', 'ERL IRL Evaluator [NLF]']);
    log(
      'indicator add',
      attach.json?.success ? 'OK entity=' + attach.json.entity_id : attach.json?.error || attach.stderr,
    );
  }

  const state = tvJson(['state']);

  console.log(
    JSON.stringify(
      {
        success: true,
        symbol: SYMBOL,
        timeframe: TF,
        pine_path: PINE_PATH.replace(/\\/g, '/'),
        compile: compileRes,
        chart_state: state.json,
        indicator_add_attempted: DO_INDICATOR_ADD,
        indicator_add: attach?.json ?? null,
        note:
          'If the chart does not show the strategy, click "Add to chart" in the Pine editor for this script (local strategies may not resolve via indicator add by name until saved to TV cloud).',
      },
      null,
      2,
    ),
  );
}

await main();
