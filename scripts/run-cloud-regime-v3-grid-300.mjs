/**
 * 300-scenario grid: Cloud Regime v3.0 — optimize net profit with heavy max-DD% penalty (stability-first).
 *
 * Grid (5 * 5 * 3 * 2 * 2 = 300):
 *   in_3  rqGateOn       [55, 65, 75, 85, 95] — higher = more permissive (required on MGC in sample)
 *   in_25 htfAdxMin      [14, 16, 18, 20, 22]
 *   in_15 cloudSmooth    [1, 2, 3]
 *   in_21 minSteps       [1, 2]
 *   in_23 vwapEntryZone  [0.6, 1.0]
 *
 * If Pine inputs changed (e.g. RESEARCH group), remap `in_*` from Strategy Tester before relying on grid keys.
 *
 * Env:
 *   TV_ENTITY_ID / CLOUD_ENTITY_ID — study id (default: discover "Cloud Regime")
 *   ADVISOR_STRATEGY_SUBSTRING / TV_STRATEGY_NAME — strategy tester pin (default: Cloud Regime)
 *   INPUT_DELAY_MS (4000)
 *   REPORT_POLL_MS (20000), REPORT_POLL_STEP_MS (2500)
 *   GRID_DD_WEIGHT (80) — score = netProfit - GRID_DD_WEIGHT * maxDDpercent
 *   GRID_MIN_TRADES (3) — scenarios with fewer trades get score -1e12
 *   GRID_SLICE — "0:10" smoke slice
 *   OUT_JSON — default C:\Users\dypag\cloud-regime-v3-scenario-grid.json
 *
 * Usage: node scripts/run-cloud-regime-v3-grid-300.mjs
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS || 4000);
const REPORT_POLL_MS = Number(process.env.REPORT_POLL_MS ?? '20000');
const REPORT_POLL_STEP_MS = Number(process.env.REPORT_POLL_STEP_MS ?? '2500');
const DD_WEIGHT = Number(process.env.GRID_DD_WEIGHT ?? '80');
const MIN_TRADES = Number(process.env.GRID_MIN_TRADES ?? '1');
const SUBSTR = (
  process.env.ADVISOR_STRATEGY_SUBSTRING ||
  process.env.TV_STRATEGY_NAME ||
  'Cloud Regime'
).trim();
const OUT_JSON = process.env.OUT_JSON || 'C:\\Users\\dypag\\cloud-regime-v3-scenario-grid.json';

const RQ_GATE = [55, 65, 75, 85, 95];
const ADX_MIN = [14, 16, 18, 20, 22];
const CLOUD_SMOOTH = [1, 2, 3];
const MIN_STEPS = [1, 2];
const VWAP_ZONE = [0.6, 1.0];

function parseToolResult(toolResult) {
  const text = toolResult?.content?.[0]?.text;
  if (!text) return { _parseError: 'no text content in tool result' };
  try {
    return JSON.parse(text);
  } catch (e) {
    return { _parseError: e.message, _raw: text };
  }
}

async function callJson(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return parseToolResult(r);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findStudyId(state) {
  const ex = (process.env.TV_ENTITY_ID || process.env.CLOUD_ENTITY_ID || '').trim();
  if (ex) return ex;
  const studies = state?.studies || [];
  const esc = SUBSTR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = studies.find((s) => new RegExp(esc, 'i').test(s.name || ''));
  return hit?.id ?? null;
}

function buildBaseline(inputs) {
  const baseline = {};
  for (const { id, value } of inputs) {
    if (/^in_\d+$/.test(id)) baseline[id] = value;
  }
  return baseline;
}

function buildScenarios() {
  const out = [];
  let sid = 0;
  for (const rq of RQ_GATE) {
    for (const adx of ADX_MIN) {
      for (const cs of CLOUD_SMOOTH) {
        for (const ms of MIN_STEPS) {
          for (const vz of VWAP_ZONE) {
            out.push({
              scenarioId: sid++,
              in_3: rq,
              in_25: adx,
              in_15: cs,
              in_21: ms,
              in_23: vz,
            });
          }
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
  if (!m) throw new Error(`GRID_SLICE must be start:end, got ${raw}`);
  const a = Number(m[1]);
  const b = Number(m[2]);
  return scenarios.slice(a, b);
}

function metricsOk(data) {
  if (!data || data.success === false) return false;
  const m = data.metrics;
  if (!m || typeof m !== 'object') return false;
  if (typeof m.netProfit !== 'number' || Number.isNaN(m.netProfit)) return false;
  if (typeof m.totalTrades !== 'number' || Number.isNaN(m.totalTrades)) return false;
  return true;
}

function ddPercent(m) {
  const v = Number(m.maxStrategyDrawDownPercent ?? m.maxDrawdownPercent ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function compositeScore(m) {
  const trades = Number(m.totalTrades ?? 0);
  if (trades < MIN_TRADES) return -1e12;
  const np = Number(m.netProfit ?? 0);
  const ddp = ddPercent(m);
  return np - DD_WEIGHT * ddp;
}

function compareRows(a, b) {
  const ds = compositeScore(b.metrics) - compositeScore(a.metrics);
  if (ds !== 0) return ds;
  const dd = ddPercent(a.metrics) - ddPercent(b.metrics);
  if (dd !== 0) return dd;
  return (b.metrics.netProfit ?? 0) - (a.metrics.netProfit ?? 0);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [join(ROOT, 'src/server.js')],
  cwd: ROOT,
});
const client = new Client({ name: 'cloud-regime-v3-grid', version: '1.0.0' });
await client.connect(transport);

const state = await callJson(client, 'chart_get_state', {});
const entityId = findStudyId(state);
if (!entityId) {
  console.error(JSON.stringify({ error: 'no_study', studies: state?.studies, hint: SUBSTR }, null, 2));
  process.exit(1);
}

const ind = await callJson(client, 'data_get_indicator', { entity_id: entityId });
if (!ind.success || !ind.inputs) {
  console.error(JSON.stringify({ error: 'data_get_indicator_failed', ind }, null, 2));
  process.exit(1);
}

const baselineFull = buildBaseline(ind.inputs);
const scenarios = applyGridSlice(buildScenarios());

const results = [];
const failed = [];

async function fetchMetricsWithPoll() {
  let data = await callJson(client, 'data_get_strategy_results', {});
  const start = Date.now();
  while (Date.now() - start < REPORT_POLL_MS) {
    if (data.report_ready && metricsOk(data)) return data;
    await sleep(REPORT_POLL_STEP_MS);
    data = await callJson(client, 'data_get_strategy_results', {});
  }
  return data;
}

for (let i = 0; i < scenarios.length; i++) {
  const sc = scenarios[i];
  const patch = {
    ...baselineFull,
    in_3: sc.in_3,
    in_25: sc.in_25,
    in_15: sc.in_15,
    in_21: sc.in_21,
    in_23: sc.in_23,
  };

  const setRes = await callJson(client, 'indicator_set_inputs', {
    entity_id: entityId,
    inputs: JSON.stringify(patch),
    persist_layout: false,
  });
  if (setRes.success === false || setRes.error) {
    failed.push({ i, sc, reason: setRes.error || 'indicator_set_inputs failed' });
    await sleep(INPUT_DELAY_MS);
    continue;
  }

  await sleep(INPUT_DELAY_MS);
  const data = await fetchMetricsWithPoll();
  const m = data.metrics;

  if (!data.report_ready || !metricsOk(data)) {
    failed.push({
      i,
      sc,
      reason: data.pick_note || data.error || data.hint || 'no metrics',
      strategy_name: data.strategy_name,
    });
    continue;
  }

  const score = compositeScore(m);
  results.push({
    scenarioId: sc.scenarioId,
    scenarioIndex: i,
    inputs: {
      rqGateOn: sc.in_3,
      htfAdxMin: sc.in_25,
      cloudSmooth: sc.in_15,
      minSteps: sc.in_21,
      vwapEntryZone: sc.in_23,
    },
    metrics: {
      netProfit: m.netProfit,
      netProfitPercent: m.netProfitPercent,
      profitFactor: m.profitFactor,
      totalTrades: m.totalTrades,
      percentProfitable: m.percentProfitable,
      maxStrategyDrawDownPercent: m.maxStrategyDrawDownPercent,
      maxDrawdownPercent: m.maxDrawdownPercent,
      maxStrategyDrawDown: m.maxStrategyDrawDown,
      grossProfit: m.grossProfit,
      grossLoss: m.grossLoss,
      commissionPaid: m.commissionPaid,
    },
    compositeScore: score,
    strategy_name: data.strategy_name,
    pick_note: data.pick_note,
    report_ready: data.report_ready,
  });
}

results.sort(compareRows);
const best = results[0] || null;

const payload = {
  generated_at: new Date().toISOString(),
  entity_id: entityId,
  symbol: state?.symbol,
  resolution: state?.resolution,
  grid: {
    description: 'rqGate × htfAdxMin × cloudSmooth × minSteps × vwapEntryZone',
    DD_WEIGHT,
    MIN_TRADES,
    formula: 'compositeScore = netProfit - DD_WEIGHT * maxDDpercent; scenarios with totalTrades < MIN_TRADES => -1e12',
  },
  scenario_count: scenarios.length,
  ok_count: results.length,
  failed_count: failed.length,
  failed_preview: failed.slice(0, 40),
  best,
  top_10: results.slice(0, 10),
  all_results: results,
};

writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), 'utf8');
console.log(`Wrote ${OUT_JSON}`);
console.log(
  best
    ? `Best score=${best.compositeScore.toFixed(2)} net=${best.metrics.netProfit} DD%=${ddPercent(best.metrics)} PF=${best.metrics.profitFactor} trades=${best.metrics.totalTrades}`
    : 'No successful rows',
);

await client.close().catch(() => {});
