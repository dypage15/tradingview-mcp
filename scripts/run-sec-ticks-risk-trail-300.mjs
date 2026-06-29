#!/usr/bin/env node
/**
 * 300 scenarios — wider stop/TP (more tick risk), trail offset, and risk % per trade.
 * Fixed for this study: trailActivateTicks=18, moveToBE / runner cap / entry grid unchanged.
 *
 * Cartesian (5 * 5 * 4 * 3 = 300):
 *   in_6   stopTicks        [44, 56, 68, 80, 92]
 *   in_7   tpLegTicks       [34, 46, 58, 70, 82]
 *   in_11  trailTicks       [8, 14, 24, 34]
 *   in_1   riskPerTrade     [0.75, 1.0, 1.25]
 *
 * Also sets in_12 trailActivateTicks to 18 every run (explicit) so trail "arms" consistently
 * while we learn sensitivity to trail *offset* (ticks).
 *
 * Env: GRID_SLICE, SEC_ENTITY_ID, INPUT_DELAY_MS, ADVISOR_STRATEGY_SUBSTRING, TV_RETRIES, RESUME
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'src/cli/index.js');
const BUF = 50 * 1024 * 1024;
const CHECKPOINT = join(ROOT, 'data', 'sec_ticks_risk_trail_300_checkpoint.json');

const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS || 4000);
const SUB = (process.env.ADVISOR_STRATEGY_SUBSTRING || process.env.TV_STRATEGY_NAME || 'Sec (Ticks)').trim();
const TV_RETRIES = Number(process.env.TV_RETRIES || 4);
const TV_RETRY_MS = Number(process.env.TV_RETRY_MS || 2000);

const STOP = [44, 56, 68, 80, 92];
const TP = [34, 46, 58, 70, 82];
const TRAIL = [8, 14, 24, 34];
const RISK = [0.75, 1.0, 1.25];
const TRAIL_ACT_FIXED = 18;

function sleepMs(ms) {
  const t = Date.now() + ms;
  while (Date.now() < t) {}
}

function execTvRetry(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, ADVISOR_STRATEGY_SUBSTRING: SUB };
  let lastErr;
  for (let attempt = 1; attempt <= TV_RETRIES; attempt++) {
    try {
      return execFileSync(process.execPath, [CLI, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: BUF,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (e) {
      lastErr = e;
      console.error(`[tv] ${args[0]} fail ${attempt}/${TV_RETRIES}: ${e.message || e}`);
      if (attempt < TV_RETRIES) sleepMs(TV_RETRY_MS * attempt);
    }
  }
  throw lastErr;
}

function tvJson(args) {
  return JSON.parse(execTvRetry(args));
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
  for (const st of STOP) {
    for (const tp of TP) {
      for (const tr of TRAIL) {
        for (const rk of RISK) {
          out.push({ scenarioId: id++, in_6: st, in_7: tp, in_11: tr, in_1: rk });
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
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new Error(`Bad GRID_SLICE=${raw}`);
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
  if (n < 6) return np - 900;
  return np - 45 * ddSafe + 0.07 * pf * Math.sign(np) * Math.min(Math.abs(np), 10000);
}

let scenarios = applySlice(buildScenarios());
if (scenarios.length === 0) throw new Error('empty scenarios');

mkdirSync(join(ROOT, 'data'), { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const sliceTag = (process.env.GRID_SLICE || 'full').replace(':', '-');
const outPath = join(ROOT, 'data', `sec_ticks_risk_trail_300_${sliceTag}_${ts}.json`);
const ndPath = join(ROOT, 'data', `sec_ticks_risk_trail_300_${sliceTag}_${ts}.ndjson`);

const results = [];
const failed = [];
let skipUntil = -1;

if (process.env.RESUME === '1' && existsSync(CHECKPOINT)) {
  try {
    const cp = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
    if (Array.isArray(cp.results)) results.push(...cp.results);
    if (Array.isArray(cp.failed)) failed.push(...cp.failed);
    skipUntil = Number(cp.lastScenarioId);
    console.error(JSON.stringify({ resume: true, ok: results.length, fail: failed.length, skipUntil }, null, 2));
  } catch (e) {
    console.error(String(e));
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
  console.error(JSON.stringify({ success: false, error: 'Sec (Ticks) not on chart' }));
  process.exit(1);
}

function writeCheckpoint(lastId) {
  writeFileSync(
    CHECKPOINT,
    JSON.stringify({ lastScenarioId: lastId, results, failed, at: new Date().toISOString() }, null, 2),
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
    in_6: sc.in_6,
    in_7: sc.in_7,
    in_11: sc.in_11,
    in_1: sc.in_1,
    in_12: TRAIL_ACT_FIXED,
  });

  let setRes;
  try {
    setRes = tvJson(['indicator', 'set', entityId, '-i', payload, '--no-persist']);
  } catch (e) {
    failed.push({ ...sc, reason: String(e.message || e) });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc })}\n`, { flag: 'a' });
    sleepMs(3000);
    continue;
  }
  if (setRes.success === false) {
    failed.push({ ...sc, reason: setRes.error || 'set failed' });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc, setRes })}\n`, { flag: 'a' });
    sleepMs(3000);
    continue;
  }

  sleepMs(INPUT_DELAY_MS);

  let data;
  try {
    data = tvJson(['data', 'strategy']);
  } catch (e) {
    failed.push({ ...sc, reason: String(e.message || e) });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc })}\n`, { flag: 'a' });
    sleepMs(3000);
    continue;
  }

  if (!isSuccessRow(data)) {
    failed.push({ ...sc, reason: 'no metrics', raw: data });
    writeFileSync(ndPath, `${JSON.stringify({ type: 'fail', ...sc })}\n`, { flag: 'a' });
    sleepMs(3000);
    continue;
  }

  const m = data.metrics;
  const row = {
    scenarioId: sc.scenarioId,
    in_6: sc.in_6,
    in_7: sc.in_7,
    in_11: sc.in_11,
    in_1: sc.in_1,
    in_12: TRAIL_ACT_FIXED,
    netProfit: m.netProfit,
    profitFactor: m.profitFactor,
    percentProfitable: m.percentProfitable,
    totalTrades: m.totalTrades,
    maxStrategyDrawDownPercent: m.maxStrategyDrawDownPercent,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    strategy_name: data.strategy_name,
    score: scoreRow(m),
  };
  results.push(row);
  writeFileSync(ndPath, `${JSON.stringify({ type: 'ok', ...row })}\n`, { flag: 'a' });

  if ((results.length + failed.length) % 25 === 0) {
    writeCheckpoint(sc.scenarioId);
    console.error(`[progress] id=${sc.scenarioId} ok=${results.length} fail=${failed.length}`);
  }
}

writeCheckpoint(scenarios[scenarios.length - 1]?.scenarioId ?? -1);

const sorted = [...results].sort((a, b) => b.score - a.score);
const top = sorted.slice(0, 30);

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const top15 = sorted.slice(0, 15);
const insights = {
  best: sorted[0] || null,
  medianTop15: {
    in_6: median(top15.map((r) => r.in_6)),
    in_7: median(top15.map((r) => r.in_7)),
    in_11: median(top15.map((r) => r.in_11)),
    in_1: median(top15.map((r) => r.in_1)),
  },
  note:
    'Higher in_6/in_7 = more tick risk/reward; in_11 is runner trail offset (ticks). in_1 scales position size.',
};

writeFileSync(
  outPath,
  JSON.stringify(
    {
      success: true,
      generatedAt: new Date().toISOString(),
      entityId,
      grid: { STOP, TP, TRAIL, RISK, trailActivateFixed: TRAIL_ACT_FIXED },
      gridSlice: process.env.GRID_SLICE || null,
      countOk: results.length,
      countFail: failed.length,
      insights,
      top30: top,
      failedSample: failed.slice(0, 30),
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
      countOk: results.length,
      countFail: failed.length,
      best: sorted[0] || null,
      insights,
    },
    null,
    2
  )
);
