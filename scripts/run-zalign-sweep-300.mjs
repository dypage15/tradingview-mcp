/**
 * ZAlign (MMT Zone-Aligned Sweep sandbox) — 300 scenario sweep on MNQ, timeframes 1–10m.
 *
 * Steps:
 * 1) Optional: inject Pine from repo + smart compile (SKIP_INJECT=1 to skip).
 * 2) Poll chart_get_state until study name matches ZAlign (or set ZALIGN_ENTITY_ID).
 * 3) Read all in_* inputs as baseline; detect align (float) + minNear (int) ids by position/heuristic.
 * 4) Grid: 10 TFs × 10 align widths × 3 minNear = 300.
 *
 * Env:
 *   SKIP_INJECT=1           — do not pine_set_source / compile
 *   ZALIGN_ENTITY_ID=...    — force study id
 *   TV_STRATEGY_NAME=ZAlign — Strategy Tester pick (default)
 *   TF_DELAY_MS, INPUT_DELAY_MS
 *
 * Usage: node scripts/run-zalign-sweep-300.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PINE_PATH = join(ROOT, 'mmt-liquidity-zone-alignment-strategy.pine');

process.env.TV_STRATEGY_NAME = process.env.TV_STRATEGY_NAME || 'MMT Zone-Aligned';
process.env.ADVISOR_STRATEGY_SUBSTRING = process.env.ADVISOR_STRATEGY_SUBSTRING || 'MMT Zone-Aligned';

const TF_DELAY_MS = Number(process.env.TF_DELAY_MS || 650);
const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS || 2800);
const TIMEFRAMES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const ALIGN_GRID = [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5];
const MIN_NEAR_GRID = [2, 3, 4];

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

function isSuccessRow(data) {
  if (!data || data._parseError || data.success === false || data.error) return false;
  const m = data.metrics;
  return !!(m && typeof m.netProfit === 'number' && !Number.isNaN(m.netProfit));
}

function inputsToBaselineObject(inputs) {
  const o = {};
  for (const row of inputs || []) {
    if (!row || !row.id || !/^in_\d+$/.test(row.id)) continue;
    o[row.id] = row.value;
  }
  return o;
}

function findZAlignEntity(state) {
  const ex = (process.env.ZALIGN_ENTITY_ID || '').trim();
  if (ex) return ex;
  const studies = state.studies || [];
  const hit = studies.find((s) => /zalign|zone-aligned|mmt zone/i.test(s.name || ''));
  return hit?.id ?? null;
}

function detectAlignMinIds(inputs) {
  const rows = (inputs || []).filter((r) => r && /^in_\d+$/.test(r.id));
  rows.sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
  const first = rows[0];
  const second = rows[1];
  if (first && typeof first.value === 'number' && second && Number.isInteger(second.value)) {
    return { alignId: first.id, minNearId: second.id, method: 'first_two_numeric' };
  }
  let alignId = null;
  let minNearId = null;
  for (const r of rows) {
    const v = r.value;
    if (typeof v === 'number' && !Number.isInteger(v) && v >= 0.25 && v <= 30 && alignId == null) {
      alignId = r.id;
    }
    if (Number.isInteger(v) && v >= 2 && v <= 8 && minNearId == null && r.id !== alignId) {
      minNearId = r.id;
    }
  }
  return { alignId, minNearId, method: 'heuristic' };
}

function buildScenarios(alignId, minNearId) {
  const out = [];
  let id = 0;
  for (const tf of TIMEFRAMES) {
    for (const al of ALIGN_GRID) {
      for (const mn of MIN_NEAR_GRID) {
        out.push({ scenarioId: id++, timeframe: tf, [alignId]: al, [minNearId]: mn });
      }
    }
  }
  return out;
}

function rankKey(row) {
  return [-row.netProfit, -(row.profitFactor ?? -Infinity), Math.abs(row.grossLoss ?? 0), -row.totalTrades];
}

function compareRows(a, b) {
  const ka = rankKey(a);
  const kb = rankKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return a.scenarioId - b.scenarioId;
}

const timestamp = new Date().toISOString();
const transport = new StdioClientTransport({
  command: 'node',
  args: [join(ROOT, 'src/server.js')],
  cwd: ROOT,
});
const client = new Client({ name: 'zalign-sweep-300', version: '1.0.0' });
await client.connect(transport);

await callJson(client, 'chart_set_symbol', { symbol: 'CME_MINI:MNQ1!' });
await callJson(client, 'chart_set_type', { chart_type: 'Candles' });
await callJson(client, 'ui_open_panel', { panel: 'strategy-tester', action: 'open' });
await sleep(600);

const skipInject = process.env.SKIP_INJECT === '1';
if (!skipInject) {
  const src = readFileSync(PINE_PATH, 'utf8');
  await callJson(client, 'ui_open_panel', { panel: 'pine-editor', action: 'open' });
  await sleep(500);
  await callJson(client, 'pine_set_source', { source: src });
  await sleep(400);
  await callJson(client, 'pine_smart_compile', {});
  await sleep(1200);
  const err = await callJson(client, 'pine_get_errors', {});
  if (err.errors?.length || err.error) {
    writeFileSync(
      'C:\\Users\\dypag\\MNQ_zalign_sweep_300_error.json',
      JSON.stringify({ phase: 'compile', err }, null, 2)
    );
  }
  await callJson(client, 'pine_save', {});
  await sleep(800);
  // Try to attach compiled strategy to chart (TV resolves by published title string).
  const tryNames = [
    'MMT Zone-Aligned Sweep (sandbox)',
    'MMT ZAlign',
  ];
  for (const nm of tryNames) {
    const add = await callJson(client, 'chart_manage_indicator', {
      action: 'add',
      indicator: nm,
    });
    if (add.success && add.entity_id) {
      process.env.ZALIGN_ENTITY_ID = add.entity_id;
      break;
    }
    await sleep(600);
  }
}

let zId = null;
for (let i = 0; i < 45; i++) {
  const st = await callJson(client, 'chart_get_state', {});
  zId = findZAlignEntity(st);
  if (zId) break;
  await sleep(2000);
}

if (!zId) {
  const msg = {
    ok: false,
    error:
      'MMT ZAlign strategy not found on chart after inject/compile. In TradingView: Pine Editor → Save → "Add to chart" on the strategy, then rerun with SKIP_INJECT=1 or leave chart open.',
    timestamp,
  };
  writeFileSync('C:\\Users\\dypag\\MNQ_zalign_sweep_300_error.json', JSON.stringify(msg, null, 2));
  await client.close();
  console.log(JSON.stringify(msg, null, 2));
  process.exit(1);
}

const ind = await callJson(client, 'data_get_indicator', { entity_id: zId });
if (!ind.success || !ind.inputs) {
  const msg = { ok: false, error: 'data_get_indicator failed', ind, zId };
  writeFileSync('C:\\Users\\dypag\\MNQ_zalign_sweep_300_error.json', JSON.stringify(msg, null, 2));
  await client.close();
  console.log(JSON.stringify(msg, null, 2));
  process.exit(1);
}

const baseline = inputsToBaselineObject(ind.inputs);
const { alignId, minNearId, method } = detectAlignMinIds(ind.inputs);
if (!alignId || !minNearId) {
  const msg = { ok: false, error: 'Could not detect align/minNear input ids', baselineKeys: Object.keys(baseline), zId };
  writeFileSync('C:\\Users\\dypag\\MNQ_zalign_sweep_300_error.json', JSON.stringify(msg, null, 2));
  await client.close();
  console.log(JSON.stringify(msg, null, 2));
  process.exit(1);
}

const scenarios = buildScenarios(alignId, minNearId);
if (scenarios.length !== 300) {
  throw new Error(`Expected 300 scenarios, got ${scenarios.length}`);
}

const results = [];
const failed = [];
let lastTf = null;

for (const sc of scenarios) {
  if (sc.timeframe !== lastTf) {
    const tr = await callJson(client, 'chart_set_timeframe', { timeframe: sc.timeframe });
    if (tr.success === false || tr._parseError) {
      failed.push({ scenarioId: sc.scenarioId, reason: `chart_set_timeframe: ${tr.error || tr._parseError}` });
      lastTf = sc.timeframe;
      continue;
    }
    lastTf = sc.timeframe;
    await sleep(TF_DELAY_MS);
  }

  const patch = { ...baseline, [alignId]: sc[alignId], [minNearId]: sc[minNearId] };
  const setRes = await callJson(client, 'indicator_set_inputs', {
    entity_id: zId,
    inputs: JSON.stringify(patch),
    persist_layout: false,
  });
  if (setRes.success === false || setRes.error) {
    failed.push({ scenarioId: sc.scenarioId, reason: `indicator_set_inputs: ${setRes.error || 'failed'}` });
    await sleep(INPUT_DELAY_MS);
    continue;
  }
  await sleep(INPUT_DELAY_MS);

  const data = await callJson(client, 'data_get_strategy_results', {});
  if (!isSuccessRow(data)) {
    failed.push({
      scenarioId: sc.scenarioId,
      reason: data.error || data.hint || data._parseError || 'no metrics',
    });
    continue;
  }

  const m = data.metrics;
  results.push({
    scenarioId: sc.scenarioId,
    timeframe: sc.timeframe,
    alignPts: sc[alignId],
    minNear: sc[minNearId],
    alignId,
    minNearId,
    netProfit: m.netProfit,
    profitFactor: m.profitFactor,
    totalTrades: m.totalTrades,
    percentProfitable: m.percentProfitable,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    commissionPaid: m.commissionPaid,
    strategy_name: data.strategy_name,
    pick_note: data.pick_note,
  });
}

const restore = { ...baseline };
await callJson(client, 'chart_set_timeframe', { timeframe: '5' });
await sleep(TF_DELAY_MS);
await callJson(client, 'indicator_set_inputs', {
  entity_id: zId,
  inputs: JSON.stringify(restore),
  persist_layout: true,
});

const sorted = [...results].sort(compareRows);
const best = sorted[0] || null;
const top25 = sorted.slice(0, 25);

const lines = [];
lines.push('MMT ZAlign — 300 scenario sweep (1–10m, align × minNear)');
lines.push(`Timestamp: ${timestamp}`);
lines.push(`Entity: ${zId} | id_detection: ${method} (${alignId}, ${minNearId})`);
lines.push(`Success: ${results.length}/300 | Failed: ${failed.length}/300`);
lines.push('');
lines.push('=== Best ===');
lines.push(best ? JSON.stringify(best, null, 2) : 'none');
lines.push('');
lines.push('=== Top 25 ===');
lines.push('rank | scen | tf | align | minNear | net | PF | trades | %win');
for (let i = 0; i < top25.length; i++) {
  const r = top25[i];
  lines.push(
    `${i + 1} | ${r.scenarioId} | ${r.timeframe} | ${r.alignPts} | ${r.minNear} | ${r.netProfit?.toFixed(2)} | ${(r.profitFactor ?? 0).toFixed(4)} | ${r.totalTrades} | ${((r.percentProfitable ?? 0) * 100).toFixed(2)}%`
  );
}

const rawPath = 'C:\\Users\\dypag\\MNQ_zalign_sweep_300_raw.json';
const txtPath = 'C:\\Users\\dypag\\MNQ_zalign_sweep_300_results.txt';
writeFileSync(
  rawPath,
  JSON.stringify(
    {
      generatedAt: timestamp,
      zalignEntityId: zId,
      alignId,
      minNearId,
      idDetection: method,
      successCount: results.length,
      failedCount: failed.length,
      results,
      failed,
      best,
      top25,
    },
    null,
    2
  ),
  'utf8'
);
writeFileSync(txtPath, lines.join('\n'), 'utf8');

await client.close();
console.log(
  JSON.stringify(
    {
      ok: true,
      successCount: results.length,
      failedCount: failed.length,
      bestScenarioId: best?.scenarioId ?? null,
      rawPath,
      txtPath,
    },
    null,
    2
  )
);
