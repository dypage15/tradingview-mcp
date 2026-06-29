#!/usr/bin/env node
/**
 * 300 Strategy Tester scenarios for CBC LIQUIDITY PRO V6 FIXED (Pine v6).
 *
 * Input order in CBC_LIQUIDITY_PRO_V5.pine (strategy title V6) (in_1 …):
 *   in_1 useRegimeFilter, in_2 atrRatioMin, in_3 moveCountMin, in_4 moveThresholdPts, …
 *
 * Grid (5 * 5 * 4 * 3 = 300):
 *   in_2  atrRatioMin        [1.0, 1.2, 1.4, 1.6, 1.8]
 *   in_3  moveCountMin       [2, 3, 4, 5, 6]
 *   in_4  moveThresholdPts   [35, 45, 55, 65]
 *   in_12 sweepThPts         [0.3, 0.5, 0.7]
 *
 * Env:
 *   CBC_ENTITY_ID              — override study entity id (default: auto from `tv state`)
 *   ADVISOR_STRATEGY_SUBSTRING — pick tester strategy (default: CBC LIQUIDITY PRO V6)
 *   INPUT_DELAY_MS             — wait after indicator set (default 4000)
 *   REPORT_POLL_MS             — if first `data strategy` has no metrics, poll up to this many ms (default 45000)
 *   REPORT_POLL_STEP_MS        — poll interval (default 2500)
 *   GRID_SLICE                 — optional "start:end" (end exclusive), e.g. "0:10" for smoke
 *
 * Usage: node scripts/run-cbc-liquidity-pro-v5-scenarios-300.mjs
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
const REPORT_POLL_MS = Number(process.env.REPORT_POLL_MS ?? '15000');
const REPORT_POLL_STEP_MS = Number(process.env.REPORT_POLL_STEP_MS ?? '2500');
const SUB = (
  process.env.ADVISOR_STRATEGY_SUBSTRING ||
  process.env.TV_STRATEGY_NAME ||
  'CBC LIQUIDITY PRO V6 FIXED'
).trim();

const ATR_RATIO_MIN = [1.0, 1.2, 1.4, 1.6, 1.8];
const MOVE_COUNT_MIN = [2, 3, 4, 5, 6];
const MOVE_THRESHOLD_PTS = [35, 45, 55, 65];
const SWEEP_TH_PTS = [0.3, 0.5, 0.7];

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

function findCbcEntityId() {
  const ex = (process.env.CBC_ENTITY_ID || '').trim();
  if (ex) return ex;
  const st = tvJson(['state']);
  const re = new RegExp(SUB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const hit = (st.studies || []).find((s) => re.test(s.name || ''));
  return hit?.id || null;
}

function buildScenarios() {
  const out = [];
  let id = 0;
  for (const atr of ATR_RATIO_MIN) {
    for (const mc of MOVE_COUNT_MIN) {
      for (const mt of MOVE_THRESHOLD_PTS) {
        for (const sw of SWEEP_TH_PTS) {
          out.push({
            scenarioId: id++,
            in_2: atr,
            in_3: mc,
            in_4: mt,
            in_12: sw,
          });
        }
      }
    }
  }
  return out;
}

function applyGridSlice(scenarios) {
  const raw = (process.env.GRID_SLICE || '').trim();
  if (!raw) return scenarios;
  const m = /^(\d+):(\d+)$/.exec(raw);
  if (!m) throw new Error(`GRID_SLICE must be "start:end" (e.g. 0:10), got: ${raw}`);
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (b < a) throw new Error(`GRID_SLICE end must be >= start`);
  return scenarios.slice(a, b);
}

function isSuccessRow(data) {
  if (!data || data.success === false) return false;
  const m = data.metrics;
  if (!m || typeof m !== 'object') return false;
  if (typeof m.netProfit !== 'number' || Number.isNaN(m.netProfit)) return false;
  return true;
}

/** After input change, TV may return empty metrics until the tester finishes recalculating. */
function fetchStrategyMetricsWithPoll() {
  let data = tvJson(['data', 'strategy']);
  if (isSuccessRow(data) || REPORT_POLL_MS <= 0) return data;
  const deadline = Date.now() + REPORT_POLL_MS;
  while (!isSuccessRow(data) && Date.now() < deadline) {
    sleepMs(REPORT_POLL_STEP_MS);
    data = tvJson(['data', 'strategy']);
  }
  return data;
}

function scoreRow(m) {
  const np = m.netProfit ?? -Infinity;
  const pf = m.profitFactor ?? 0;
  const wr = m.percentProfitable ?? 0;
  const n = m.totalTrades ?? 0;
  return np + 0.05 * pf * np + 0.02 * wr * Math.sign(np) * Math.min(n, 50);
}

const allScenarios = buildScenarios();
if (allScenarios.length !== 300) {
  throw new Error(`Expected 300 scenarios, got ${allScenarios.length}`);
}
const scenarios = applyGridSlice(allScenarios);

mkdirSync(join(ROOT, 'data'), { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(ROOT, 'data', `cbc_liquidity_pro_v5_scenarios_300_${ts}.json`);
const ndPath = join(ROOT, 'data', `cbc_liquidity_pro_v5_scenarios_300_${ts}.ndjson`);

tvJson(['status']);
try {
  tvJson(['ui', 'panel', 'strategy-tester', 'open']);
} catch {
  /* ignore */
}
sleepMs(600);

const entityId = findCbcEntityId();
if (!entityId) {
  console.error(
    JSON.stringify(
      {
        success: false,
        error: `Study matching "${SUB}" not on chart; add strategy or set CBC_ENTITY_ID`,
      },
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
    in_2: sc.in_2,
    in_3: sc.in_3,
    in_4: sc.in_4,
    in_12: sc.in_12,
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
    data = fetchStrategyMetricsWithPoll();
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
    in_2: sc.in_2,
    in_3: sc.in_3,
    in_4: sc.in_4,
    in_12: sc.in_12,
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

  const n = scenarios.length;
  const step = Math.max(1, Math.floor(n / 12));
  if ((results.length + failed.length) % step === 0 || sc.scenarioId === scenarios[scenarios.length - 1]?.scenarioId) {
    console.log(`[progress] scenario ${sc.scenarioId + 1}/${n} ok=${results.length} fail=${failed.length}`);
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
      gridSlice: process.env.GRID_SLICE || null,
      grid: {
        in_2_atrRatioMin: ATR_RATIO_MIN,
        in_3_moveCountMin: MOVE_COUNT_MIN,
        in_4_moveThresholdPts: MOVE_THRESHOLD_PTS,
        in_12_sweepThPts: SWEEP_TH_PTS,
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
