#!/usr/bin/env node
/**
 * 300 Strategy Tester scenarios — Sec (Ticks) with large TP leg (NQ ~$700–$1150+ per contract at limit).
 *
 * Grid (5 * 5 * 3 * 4 = 300):
 *   in_5   slLookback       [2, 3, 4, 5, 6]
 *   in_25  setupExpiryBars  [2, 3, 4, 5, 6]
 *   in_6   stopTicks        [44, 52, 60]   (wider stops vs small-TP grid)
 *   in_7   tpLegTicks       [140, 170, 200, 230]  (~$700 / $850 / $1000 / $1150 @ ~$5/tick)
 *
 * Pins Strategy Tester via ADVISOR_STRATEGY_SUBSTRING=Sec (Ticks).
 *
 * Env: SEC_ENTITY_ID, INPUT_DELAY_MS, ADVISOR_STRATEGY_SUBSTRING, TV_STRATEGY_NAME
 *
 * Usage: node scripts/run-sec-ticks-tp-targets-300.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'src/cli/index.js');
const BUF = 50 * 1024 * 1024;

const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS || 4000);
const SUB = (process.env.ADVISOR_STRATEGY_SUBSTRING || process.env.TV_STRATEGY_NAME || 'Sec (Ticks)').trim();

const SL_LOOKBACK = [2, 3, 4, 5, 6];
const SETUP_EXPIRY = [2, 3, 4, 5, 6];
const STOP_TICKS = [44, 52, 60];
const TP_LEG_TICKS = [140, 170, 200, 230];

function execTv(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, ADVISOR_STRATEGY_SUBSTRING: SUB };
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: BUF,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

function tvJson(args, extraEnv = {}) {
  return JSON.parse(execTv(args, extraEnv));
}

function sleepMs(ms) {
  const t = Date.now() + ms;
  while (Date.now() < t) {}
}

function findSecEntityId() {
  const ex = (process.env.SEC_ENTITY_ID || '').trim();
  if (ex) return ex;
  const st = tvJson(['state']);
  const hit = (st.studies || []).find((s) => /Sec \(Ticks\)/i.test(s.name || ''));
  return hit?.id || null;
}

function buildScenarios() {
  const out = [];
  let id = 0;
  for (const sl of SL_LOOKBACK) {
    for (const ex of SETUP_EXPIRY) {
      for (const st of STOP_TICKS) {
        for (const tp of TP_LEG_TICKS) {
          out.push({
            scenarioId: id++,
            in_5: sl,
            in_25: ex,
            in_6: st,
            in_7: tp,
          });
        }
      }
    }
  }
  return out;
}

function isSuccessRow(data) {
  if (!data || data.success === false) return false;
  const m = data.metrics;
  if (!m || typeof m !== 'object') return false;
  if (typeof m.netProfit !== 'number' || Number.isNaN(m.netProfit)) return false;
  return true;
}

function scoreRow(m) {
  const np = m.netProfit ?? -Infinity;
  const pf = m.profitFactor ?? 0;
  const wr = m.percentProfitable ?? 0;
  const n = m.totalTrades ?? 0;
  return np + 0.05 * pf * np + 0.02 * wr * Math.sign(np) * Math.min(n, 50);
}

const scenarios = buildScenarios();
if (scenarios.length !== 300) {
  throw new Error(`Expected 300 scenarios, got ${scenarios.length}`);
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(ROOT, 'data', `sec_ticks_tp_targets_300_${ts}.json`);
const ndPath = join(ROOT, 'data', `sec_ticks_tp_targets_300_${ts}.ndjson`);

tvJson(['status']);
try {
  tvJson(['ui', 'panel', 'strategy-tester', 'open']);
} catch {
  /* ignore */
}
sleepMs(600);

const entityId = findSecEntityId();
if (!entityId) {
  console.error(
    JSON.stringify(
      { success: false, error: 'Sec (Ticks) study not on chart; add strategy or set SEC_ENTITY_ID' },
      null,
      2
    )
  );
  process.exit(1);
}

const results = [];
const failed = [];

for (const sc of scenarios) {
  const payload = JSON.stringify({
    in_5: sc.in_5,
    in_25: sc.in_25,
    in_6: sc.in_6,
    in_7: sc.in_7,
  });
  let setRes;
  try {
    setRes = tvJson(['indicator', 'set', entityId, '-i', payload, '--no-persist']);
  } catch (e) {
    failed.push({ ...sc, reason: String(e.message || e) });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc, reason: String(e) })}\n`, { flag: 'a' });
    sleepMs(2000);
    continue;
  }
  if (setRes.success === false) {
    failed.push({ ...sc, reason: setRes.error || 'indicator set failed' });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc, setRes })}\n`, { flag: 'a' });
    sleepMs(2000);
    continue;
  }

  sleepMs(INPUT_DELAY_MS);

  let data;
  try {
    data = tvJson(['data', 'strategy']);
  } catch (e) {
    failed.push({ ...sc, reason: `data strategy: ${e.message || e}` });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc, reason: String(e) })}\n`, { flag: 'a' });
    sleepMs(2000);
    continue;
  }

  if (!isSuccessRow(data)) {
    failed.push({ ...sc, reason: 'metrics missing or tester not ready', raw: data });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc, data })}\n`, { flag: 'a' });
    sleepMs(2000);
    continue;
  }

  const m = data.metrics;
  const row = {
    scenarioId: sc.scenarioId,
    in_5: sc.in_5,
    in_25: sc.in_25,
    in_6: sc.in_6,
    in_7: sc.in_7,
    netProfit: m.netProfit,
    profitFactor: m.profitFactor,
    percentProfitable: m.percentProfitable,
    totalTrades: m.totalTrades,
    maxStrategyDrawDown: m.maxStrategyDrawDown,
    maxStrategyDrawDownPercent: m.maxStrategyDrawDownPercent,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    strategy_name: data.strategy_name,
    pick_note: data.strategy_pick_note,
    score: scoreRow(m),
  };
  results.push(row);
  writeFileSync(ndPath, `${JSON.stringify({ type: 'ok', ...row })}\n`, { flag: 'a' });

  if ((sc.scenarioId + 1) % 25 === 0) {
    console.error(`[progress] ${sc.scenarioId + 1}/300 ok=${results.length} fail=${failed.length}`);
  }
}

results.sort((a, b) => b.score - a.score);
const top = results.slice(0, 25);

writeFileSync(
  outPath,
  JSON.stringify(
    {
      success: true,
      generatedAt: new Date().toISOString(),
      entityId,
      advisorSubstring: SUB,
      note: 'tpLegTicks grid targets ~$700–$1150 per contract on TP leg for NQ-class (~$5/tick); scale for other symbols.',
      grid: {
        in_5_slLookback: SL_LOOKBACK,
        in_25_setupExpiryBars: SETUP_EXPIRY,
        in_6_stopTicks: STOP_TICKS,
        in_7_tpLegTicks: TP_LEG_TICKS,
      },
      countOk: results.length,
      countFail: failed.length,
      top25: top,
      failedSample: failed.slice(0, 40),
      all: results,
    },
    null,
    2
  ),
  'utf8'
);

console.log(
  JSON.stringify(
    {
      success: true,
      outPath,
      ndPath,
      countOk: results.length,
      countFail: failed.length,
      best: top[0] || null,
      top5: top.slice(0, 5),
    },
    null,
    2
  )
);
