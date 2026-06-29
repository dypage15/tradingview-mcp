#!/usr/bin/env node
/**
 * 800 Strategy Tester scenarios — Sec (Ticks): London H/L vs IB H/L sweep sources + flip entries,
 * with TP leg sized toward ~$700–$1000 per contract on NQ-class symbols (tick targets).
 *
 * Cartesian (2 * 4 * 5 * 5 * 4 = 800):
 *   SEC_SWEEP_INPUT (default in_44)  sweepLevelSource  [1, 2]   (1=London H/L, 2=IB H/L)
 *   in_6   stopTicks        [40, 44, 52, 60]
 *   in_7   tpLegTicks       [150, 170, 190, 210]
 *   in_5   slLookback       [2, 3, 4, 5, 6]
 *   in_25  setupExpiryBars  [2, 3, 4, 5, 6]
 *
 * Requires Pine update: sweepLevelSource input on Sec (Ticks). If `indicator set` fails,
 * open chart properties → count to "Sweep level source" and set SEC_SWEEP_INPUT=in_N.
 *
 * Env: GRID_SLICE, SEC_ENTITY_ID, INPUT_DELAY_MS, ADVISOR_STRATEGY_SUBSTRING, TV_RETRIES, RESUME,
 *      SEC_SWEEP_INPUT — Pine input id for sweep level source (default in_44)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'src/cli/index.js');
const BUF = 50 * 1024 * 1024;
const CHECKPOINT = join(ROOT, 'data', 'sec_sweep_london_ib_800_checkpoint.json');

const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS || 4000);
const SUB = (process.env.ADVISOR_STRATEGY_SUBSTRING || process.env.TV_STRATEGY_NAME || 'Sec (Ticks)').trim();
const TV_RETRIES = Number(process.env.TV_RETRIES || 4);
const TV_RETRY_MS = Number(process.env.TV_RETRY_MS || 2000);
const SWEEP_KEY = (process.env.SEC_SWEEP_INPUT || 'in_44').trim();

const SWEEP_MODES = [1, 2];
const STOP_TICKS = [40, 44, 52, 60];
const TP_LEG_TICKS = [150, 170, 190, 210];
const SL_LOOKBACK = [2, 3, 4, 5, 6];
const SETUP_EXPIRY = [2, 3, 4, 5, 6];

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
      console.error(`[tv] fail ${attempt}/${TV_RETRIES}: ${e.message || e}`);
      if (attempt < TV_RETRIES) sleepMs(TV_RETRY_MS * attempt);
    }
  }
  throw lastErr;
}

function tvJson(args, extraEnv = {}) {
  return JSON.parse(execTvRetry(args, extraEnv));
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
  for (const sw of SWEEP_MODES) {
    for (const st of STOP_TICKS) {
      for (const tp of TP_LEG_TICKS) {
        for (const sl of SL_LOOKBACK) {
          for (const ex of SETUP_EXPIRY) {
            out.push({ scenarioId: id++, sweepMode: sw, in_5: sl, in_25: ex, in_6: st, in_7: tp });
          }
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

/** Prefer net PnL while nudging toward ~$850 average $/trade (all trades, crude proxy). */
function scoreRow(m) {
  const np = m.netProfit ?? -Infinity;
  const n = m.totalTrades ?? 0;
  const per = n > 0 ? np / n : 0;
  const pf = m.profitFactor ?? 0;
  const wr = m.percentProfitable ?? 0;
  const tgt = 850;
  const d = n > 0 ? Math.abs(per - tgt) : 1e6;
  const fit = n > 0 ? Math.max(0, 1 - Math.min(d, 4000) / 4000) : 0;
  return np + 180 * fit + 0.05 * pf * np + 0.02 * wr * Math.sign(np) * Math.min(n, 50);
}

let scenarios = applySlice(buildScenarios());
if (scenarios.length === 0) throw new Error('empty scenarios');

const fullCount = buildScenarios().length;
if (fullCount !== 800) throw new Error(`Expected 800 scenarios, got ${fullCount}`);

mkdirSync(join(ROOT, 'data'), { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const sliceTag = (process.env.GRID_SLICE || 'full').replace(':', '-');
const outPath = join(ROOT, 'data', `sec_sweep_london_ib_800_${sliceTag}_${ts}.json`);
const ndPath = join(ROOT, 'data', `sec_sweep_london_ib_800_${sliceTag}_${ts}.ndjson`);

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

  const patch = {
    in_5: sc.in_5,
    in_25: sc.in_25,
    in_6: sc.in_6,
    in_7: sc.in_7,
  };
  patch[SWEEP_KEY] = sc.sweepMode;
  const payload = JSON.stringify(patch);

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
    failed.push({ ...sc, reason: setRes.error || 'set failed', setRes });
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
  const n = m.totalTrades ?? 0;
  const row = {
    scenarioId: sc.scenarioId,
    sweepMode: sc.sweepMode,
    sweepInputKey: SWEEP_KEY,
    in_5: sc.in_5,
    in_25: sc.in_25,
    in_6: sc.in_6,
    in_7: sc.in_7,
    netProfit: m.netProfit,
    profitFactor: m.profitFactor,
    percentProfitable: m.percentProfitable,
    totalTrades: n,
    avgProfitPerTrade: n > 0 ? m.netProfit / n : null,
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
const top = sorted.slice(0, 40);

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function mean(nums) {
  const a = nums.filter((x) => Number.isFinite(x));
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

const top20 = sorted.slice(0, 20);
const byLondon = sorted.filter((r) => r.sweepMode === 1);
const byIb = sorted.filter((r) => r.sweepMode === 2);

const insights = {
  best: sorted[0] || null,
  medianTop20: top20.length
    ? {
        in_5: median(top20.map((r) => r.in_5)),
        in_25: median(top20.map((r) => r.in_25)),
        in_6: median(top20.map((r) => r.in_6)),
        in_7: median(top20.map((r) => r.in_7)),
        sweepMode: median(top20.map((r) => r.sweepMode)),
      }
    : null,
  avgScoreBySweepMode: {
    london_1: mean(byLondon.map((r) => r.score)),
    ib_2: mean(byIb.map((r) => r.score)),
  },
  note:
    'sweepMode 1=London H/L sweeps, 2=IB H/L. Re-run with tighter TP/stop arrays centered on medianTop20; set LEARN_STATE=1 on autonomous runner to persist hints.',
};

writeFileSync(
  outPath,
  JSON.stringify(
    {
      success: true,
      generatedAt: new Date().toISOString(),
      entityId,
      sweepInputKey: SWEEP_KEY,
      grid: {
        sweepModes: SWEEP_MODES,
        in_6_stopTicks: STOP_TICKS,
        in_7_tpLegTicks: TP_LEG_TICKS,
        in_5_slLookback: SL_LOOKBACK,
        in_25_setupExpiryBars: SETUP_EXPIRY,
      },
      gridSlice: process.env.GRID_SLICE || null,
      countOk: results.length,
      countFail: failed.length,
      insights,
      top40: top,
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
      countOk: results.length,
      countFail: failed.length,
      best: sorted[0] || null,
      insights,
    },
    null,
    2
  )
);
