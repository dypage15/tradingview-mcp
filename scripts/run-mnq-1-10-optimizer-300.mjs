/**
 * 300-scenario optimizer for CBC + Multi-Session Sweep [MMT v4], focused on 1-10m.
 * Uses your screenshot settings as baseline and sweeps only high-impact controls.
 *
 * Grid: 10 timeframes x 5 NY KZ end hours x 3 Min Confluence x 2 Close-on-KZ-exit = 300.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

if (process.env.TV_STRATEGY_NAME === undefined && process.env.ADVISOR_STRATEGY_SUBSTRING === undefined) {
  process.env.TV_STRATEGY_NAME = 'MMT v4';
}

const TF_DELAY_MS = Number(process.env.TF_DELAY_MS || 650);
const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS || 2600);

const TIMEFRAMES = ['1','2','3','4','5','6','7','8','9','10'];
const NY_KZ_ENDS = [12, 13, 14, 15, 16];          // in_72
const MIN_CONFLUENCE = [1, 2, 3];                 // in_49
const CLOSE_ON_KZ_EXIT = [false, true];           // in_9

function parseToolResult(toolResult) {
  const text = toolResult?.content?.[0]?.text;
  if (!text) return { _parseError: 'no text content in tool result' };
  try { return JSON.parse(text); } catch (e) { return { _parseError: e.message, _raw: text }; }
}

async function callJson(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return parseToolResult(r);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isSuccessRow(data) {
  if (!data || data._parseError || data.success === false || data.error) return false;
  const m = data.metrics;
  return !!(m && typeof m.netProfit === 'number' && !Number.isNaN(m.netProfit));
}

function rankKey(row) {
  const np = row.netProfit;
  const pf = row.profitFactor ?? -Infinity;
  const gl = Math.abs(row.grossLoss ?? 0);
  const tt = row.totalTrades ?? 0;
  // prefer higher net + PF, lower gross loss, and enough trade count (slight bonus)
  return [-np, -pf, gl, -tt];
}

function compareRows(a, b) {
  const ka = rankKey(a);
  const kb = rankKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return a.scenarioId - b.scenarioId;
}

function buildScenarios() {
  const out = [];
  let id = 0;
  for (const tf of TIMEFRAMES) {
    for (const nyEnd of NY_KZ_ENDS) {
      for (const minConf of MIN_CONFLUENCE) {
        for (const kzExit of CLOSE_ON_KZ_EXIT) {
          out.push({ scenarioId: id++, timeframe: tf, nyEnd, minConf, kzExit });
        }
      }
    }
  }
  return out;
}

const baseline = {
  in_0: 'DOL Target',
  in_1: 2,
  in_2: 5,
  in_3: 'Candle Lookback',
  in_4: 1.5,
  in_5: 3,
  in_6: 2,
  in_7: true,
  in_8: true,
  in_9: false, // swept
  in_10: false,
  in_11: true,
  in_12: true,
  in_13: true,
  in_14: '10',
  in_15: '60',
  in_47: 0.5,
  in_48: 2,
  in_49: 2,    // swept
  in_53: true,
  in_54: 14,
  in_55: 0.3,
  in_56: true,
  in_57: 40,
  in_58: 9,
  in_59: 13,
  in_60: 21,
  in_61: true,
  in_62: true,
  in_63: true,
  in_64: true,
  in_65: true,
  in_66: 10,
  in_67: 19,
  in_68: 21,
  in_69: 2,
  in_70: 5,
  in_71: 8,
  in_72: 15,
};

const scenarios = buildScenarios();
if (scenarios.length !== 300) throw new Error(`Expected 300 scenarios, got ${scenarios.length}`);

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'mnq-1-10-kz300', version: '1.0.0' });
await client.connect(transport);

await callJson(client, 'chart_set_symbol', { symbol: 'CME_MINI:MNQ1!' });
await callJson(client, 'chart_set_type', { chart_type: 'Candles' });
await callJson(client, 'ui_open_panel', { panel: 'strategy-tester', action: 'open' });
await sleep(700);

const state = await callJson(client, 'chart_get_state', {});
const studies = state.studies || [];
const cbc = studies.find((s) => /MMT|CBC|Multi-Session/i.test(s.name || ''));
const cbcId = cbc?.id ?? 'qx8R0T';

const results = [];
const failed = [];
let lastTf = null;

for (const sc of scenarios) {
  if (sc.timeframe !== lastTf) {
    const setTf = await callJson(client, 'chart_set_timeframe', { timeframe: sc.timeframe });
    if (setTf.success === false || setTf._parseError) {
      failed.push({ scenarioId: sc.scenarioId, timeframe: sc.timeframe, reason: `chart_set_timeframe: ${setTf.error || setTf._parseError}` });
      lastTf = sc.timeframe;
      continue;
    }
    lastTf = sc.timeframe;
    await sleep(TF_DELAY_MS);
  }

  const payload = {
    ...baseline,
    in_72: sc.nyEnd,
    in_49: sc.minConf,
    in_9: sc.kzExit,
  };

  const setInputs = await callJson(client, 'indicator_set_inputs', {
    entity_id: cbcId,
    inputs: JSON.stringify(payload),
    persist_layout: false,
  });
  if (setInputs.success === false || setInputs.error) {
    failed.push({ scenarioId: sc.scenarioId, timeframe: sc.timeframe, reason: `indicator_set_inputs: ${setInputs.error || 'failed'}` });
    await sleep(INPUT_DELAY_MS);
    continue;
  }

  await sleep(INPUT_DELAY_MS);
  const data = await callJson(client, 'data_get_strategy_results', {});
  if (!isSuccessRow(data)) {
    failed.push({ scenarioId: sc.scenarioId, timeframe: sc.timeframe, reason: data.error || data.hint || data._parseError || 'no metrics' });
    continue;
  }

  const m = data.metrics;
  results.push({
    scenarioId: sc.scenarioId,
    timeframe: sc.timeframe,
    in_72: sc.nyEnd,
    in_49: sc.minConf,
    in_9: sc.kzExit,
    netProfit: m.netProfit,
    profitFactor: m.profitFactor,
    maxContractsHeld: m.maxContractsHeld,
    totalTrades: m.totalTrades,
    percentProfitable: m.percentProfitable,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    commissionPaid: m.commissionPaid,
    strategy_name: data.strategy_name,
    pick_note: data.pick_note,
  });
}

// Restore your preferred baseline end-state (1-10m setup / NY end 15, confluence 2, no close-on-kz-exit)
await callJson(client, 'chart_set_timeframe', { timeframe: '5' });
await sleep(TF_DELAY_MS);
await callJson(client, 'indicator_set_inputs', {
  entity_id: cbcId,
  inputs: JSON.stringify({ ...baseline, in_72: 15, in_49: 2, in_9: false }),
  persist_layout: true,
});

const sorted = [...results].sort(compareRows);
const best = sorted[0] || null;
const top30 = sorted.slice(0, 30);

const byTfBest = {};
for (const tf of TIMEFRAMES) {
  const arr = sorted.filter((r) => r.timeframe === tf);
  if (arr.length) byTfBest[tf] = arr[0];
}

const outTxt = [];
outTxt.push('MNQ CBC [MMT v4] - 1-10m profit optimizer (300 scenarios)');
outTxt.push(`Generated: ${new Date().toString()}`);
outTxt.push(`Strategy filter: ${process.env.TV_STRATEGY_NAME || process.env.ADVISOR_STRATEGY_SUBSTRING}`);
outTxt.push(`CBC entity: ${cbcId}`);
outTxt.push('');
outTxt.push('Grid: timeframe(1..10) x NY_KZ_End(in_72:12..16) x MinConfluence(in_49:1,2,3) x CloseOnKZExit(in_9:false/true)');
outTxt.push(`Success: ${results.length}/300 | Failed: ${failed.length}/300`);
outTxt.push('Ranking: netProfit desc, PF desc, |grossLoss| asc, totalTrades desc');
outTxt.push('');
outTxt.push('=== Best Overall ===');
outTxt.push(best ? JSON.stringify(best, null, 2) : 'none');
outTxt.push('');
outTxt.push('=== Best Per Timeframe (1-10m) ===');
for (const tf of TIMEFRAMES) {
  const r = byTfBest[tf];
  if (!r) continue;
  outTxt.push(`tf ${tf}: net=${r.netProfit?.toFixed(2)} PF=${(r.profitFactor ?? 0).toFixed(4)} trades=${r.totalTrades} nyEnd=${r.in_72} minConf=${r.in_49} closeOnKZExit=${r.in_9}`);
}
outTxt.push('');
outTxt.push('=== Top 30 ===');
outTxt.push('rank | scen | tf | nyEnd | minConf | closeOnKZExit | netProfit | PF | trades | %win | grossP | grossL');
for (let i = 0; i < top30.length; i++) {
  const r = top30[i];
  outTxt.push(`${i + 1} | ${r.scenarioId} | ${r.timeframe} | ${r.in_72} | ${r.in_49} | ${r.in_9} | ${r.netProfit.toFixed(2)} | ${(r.profitFactor ?? 0).toFixed(4)} | ${r.totalTrades} | ${((r.percentProfitable ?? 0) * 100).toFixed(2)}% | ${r.grossProfit.toFixed(2)} | ${r.grossLoss.toFixed(2)}`);
}
if (failed.length) {
  outTxt.push('');
  outTxt.push('=== Failures (first 40) ===');
  for (const f of failed.slice(0, 40)) outTxt.push(`scen ${f.scenarioId}: ${f.reason}`);
}

const rawPath = 'C:/Users/dypag/MNQ_1_10_optimizer_300_raw.json';
const txtPath = 'C:/Users/dypag/MNQ_1_10_optimizer_300_results.txt';
writeFileSync(rawPath, JSON.stringify({ generatedAt: new Date().toISOString(), cbcId, results, failed, best, top30, byTfBest }, null, 2));
writeFileSync(txtPath, outTxt.join('\n'));

await client.close();
console.log(JSON.stringify({ ok: true, successCount: results.length, failedCount: failed.length, bestScenarioId: best?.scenarioId ?? null, rawPath, txtPath }, null, 2));
