#!/usr/bin/env node
/**
 * 300 scenarios — exit / runner management for "CBC Asia Sweep v4 Daily50 — Sec (Ticks)".
 *
 * Grid (5 * 5 * 4 * 3 = 300): in_11 trailTicks, in_12 trailActivateTicks, in_20 moveToBEafterTicks, in_21 runnerCapTicks.
 *
 * Autonomy / resilience:
 *   - Retries each `tv` call with backoff (CDP blips on Windows).
 *   - Checkpoint file every 25 OK rows (resume with RESUME=1).
 *
 * Env: SEC_ENTITY_ID, INPUT_DELAY_MS, ADVISOR_STRATEGY_SUBSTRING, TV_RETRIES, TV_RETRY_MS
 *      RESUME=1 — continue from data/sec_ticks_exits_300_checkpoint.json if present
 *      GRID_SLICE="0:100" — optional half-open range [start, end) into the 300 scenario list
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'src/cli/index.js');
const BUF = 50 * 1024 * 1024;
const CHECKPOINT = join(ROOT, 'data', 'sec_ticks_exits_300_checkpoint.json');

const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS || 4000);
const SUB = (process.env.ADVISOR_STRATEGY_SUBSTRING || process.env.TV_STRATEGY_NAME || 'Sec (Ticks)').trim();
const TV_RETRIES = Number(process.env.TV_RETRIES || 4);
const TV_RETRY_MS = Number(process.env.TV_RETRY_MS || 2000);

const TRAIL_TICKS = [8, 12, 16, 20, 24];
const TRAIL_ACT = [4, 8, 12, 16, 20];
const MOVE_BE = [10, 14, 18, 26];
const RUNNER_CAP = [0, 100, 140];

function sleepMs(ms) {
  const t = Date.now() + ms;
  while (Date.now() < t) {}
}

function execTvOnce(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, ADVISOR_STRATEGY_SUBSTRING: SUB };
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: BUF,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

function execTvRetry(args, extraEnv = {}, label = 'tv') {
  let lastErr;
  for (let attempt = 1; attempt <= TV_RETRIES; attempt++) {
    try {
      return execTvOnce(args, extraEnv);
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : String(e);
      console.error(`[${label}] attempt ${attempt}/${TV_RETRIES} failed: ${msg}`);
      if (attempt < TV_RETRIES) sleepMs(TV_RETRY_MS * attempt);
    }
  }
  throw lastErr;
}

function tvJson(args, extraEnv = {}) {
  return JSON.parse(execTvRetry(args, extraEnv, args[0] || 'tv'));
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
  for (const tr of TRAIL_TICKS) {
    for (const ta of TRAIL_ACT) {
      for (const be of MOVE_BE) {
        for (const cap of RUNNER_CAP) {
          out.push({ scenarioId: id++, in_11: tr, in_12: ta, in_20: be, in_21: cap });
        }
      }
    }
  }
  return out;
}

function applySlice(all) {
  const raw = (process.env.GRID_SLICE || '').trim();
  if (!raw) return all;
  const [a, b] = raw.split(':').map((x) => Number(x.trim()));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
    throw new Error(`Invalid GRID_SLICE="${raw}" (use start:end, e.g. 0:100)`);
  }
  return all.slice(a, b);
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
  const dd = Number(m.maxStrategyDrawDownPercent ?? m.maxDrawdownPercent ?? 0);
  const ddSafe = Number.isFinite(dd) ? dd : 0;
  const pf = m.profitFactor ?? 0;
  const n = m.totalTrades ?? 0;
  if (n < 6) return np - 800;
  return np - 42 * ddSafe + 0.06 * pf * Math.sign(np) * Math.min(Math.abs(np), 8000);
}

let scenarios = applySlice(buildScenarios());
if (scenarios.length === 0) {
  throw new Error('No scenarios after GRID_SLICE');
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const sliceTag = (process.env.GRID_SLICE || 'full').replace(':', '-');
const outPath = join(ROOT, 'data', `sec_ticks_exits_300_${sliceTag}_${ts}.json`);
const ndPath = join(ROOT, 'data', `sec_ticks_exits_300_${sliceTag}_${ts}.ndjson`);

const results = [];
const failed = [];
let skipUntil = -1;

if (process.env.RESUME === '1' && existsSync(CHECKPOINT)) {
  try {
    const cp = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
    if (Array.isArray(cp.results)) results.push(...cp.results);
    if (Array.isArray(cp.failed)) failed.push(...cp.failed);
    skipUntil = Number(cp.lastScenarioId);
    console.error(
      JSON.stringify(
        { resume: true, loadedOk: results.length, loadedFail: failed.length, lastScenarioId: skipUntil },
        null,
        2
      )
    );
  } catch (e) {
    console.error(JSON.stringify({ resume: false, checkpointError: String(e.message || e) }));
  }
}

tvJson(['status']);
try {
  tvJson(['ui', 'panel', 'strategy-tester', 'open']);
} catch {
  /* ignore */
}
sleepMs(600);

let entityId = findSecEntityId();
if (!entityId) {
  console.error(JSON.stringify({ success: false, error: 'Sec (Ticks) study not on chart' }, null, 2));
  process.exit(1);
}

function writeCheckpoint(lastScenarioId) {
  writeFileSync(
    CHECKPOINT,
    JSON.stringify(
      {
        lastScenarioId,
        results,
        failed,
        updatedAt: new Date().toISOString(),
        slice: process.env.GRID_SLICE || 'full',
      },
      null,
      2
    ),
    'utf8'
  );
}

for (const sc of scenarios) {
  if (sc.scenarioId <= skipUntil) continue;

  if (sc.scenarioId > 0 && sc.scenarioId % 50 === 0) {
    try {
      entityId = findSecEntityId() || entityId;
    } catch {
      /* keep */
    }
  }

  const payload = JSON.stringify({
    in_11: sc.in_11,
    in_12: sc.in_12,
    in_20: sc.in_20,
    in_21: sc.in_21,
  });
  let setRes;
  try {
    setRes = tvJson(['indicator', 'set', entityId, '-i', payload, '--no-persist']);
  } catch (e) {
    failed.push({ ...sc, reason: String(e.message || e) });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc, reason: String(e) })}\n`, { flag: 'a' });
    sleepMs(3000);
    continue;
  }
  if (setRes.success === false) {
    failed.push({ ...sc, reason: setRes.error || 'indicator set failed' });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc, setRes })}\n`, { flag: 'a' });
    sleepMs(3000);
    continue;
  }

  sleepMs(INPUT_DELAY_MS);

  let data;
  try {
    data = tvJson(['data', 'strategy']);
  } catch (e) {
    failed.push({ ...sc, reason: `data strategy: ${e.message || e}` });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc, reason: String(e) })}\n`, { flag: 'a' });
    sleepMs(3000);
    continue;
  }

  if (!isSuccessRow(data)) {
    failed.push({ ...sc, reason: 'metrics missing', raw: data });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc, data })}\n`, { flag: 'a' });
    sleepMs(3000);
    continue;
  }

  const m = data.metrics;
  const row = {
    scenarioId: sc.scenarioId,
    in_11: sc.in_11,
    in_12: sc.in_12,
    in_20: sc.in_20,
    in_21: sc.in_21,
    netProfit: m.netProfit,
    profitFactor: m.profitFactor,
    percentProfitable: m.percentProfitable,
    totalTrades: m.totalTrades,
    maxStrategyDrawDownPercent: m.maxStrategyDrawDownPercent,
    maxStrategyDrawDown: m.maxStrategyDrawDown,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    strategy_name: data.strategy_name,
    pick_note: data.strategy_pick_note,
    score: scoreRow(m),
  };
  results.push(row);
  writeFileSync(ndPath, `${JSON.stringify({ type: 'ok', ...row })}\n`, { flag: 'a' });

  const doneInSlice = results.length + failed.length;
  if (doneInSlice % 25 === 0) {
    writeCheckpoint(sc.scenarioId);
    console.error(`[progress] scenario ${sc.scenarioId} slice_rows=${doneInSlice} ok=${results.length} fail=${failed.length}`);
  }
}

writeCheckpoint(scenarios[scenarios.length - 1]?.scenarioId ?? -1);

const sorted = [...results].sort((a, b) => b.score - a.score);
const top = sorted.slice(0, 25);

writeFileSync(
  outPath,
  JSON.stringify(
    {
      success: true,
      generatedAt: new Date().toISOString(),
      entityId,
      advisorSubstring: SUB,
      grid: {
        in_11_trailTicks: TRAIL_TICKS,
        in_12_trailActivateTicks: TRAIL_ACT,
        in_20_moveToBEafterTicks: MOVE_BE,
        in_21_runnerCapTicks: RUNNER_CAP,
      },
      gridSlice: process.env.GRID_SLICE || null,
      countOk: results.length,
      countFail: failed.length,
      top25: top,
      failedSample: failed.slice(0, 40),
      all: sorted,
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
      checkpoint: CHECKPOINT,
      countOk: results.length,
      countFail: failed.length,
      best: top[0] || null,
      top5: top.slice(0, 5),
    },
    null,
    2
  )
);
