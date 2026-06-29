/**
 * Profit-factor scenario sweep for CHOCH MACD Sniper (TradingView MCP).
 *
 * Prerequisites:
 * - tradingview-mcp server reachable via stdio (same pattern as run-mnq-1-10-optimizer-300.mjs)
 * - Exactly ONE instance of the strategy on chart OR set ADVISOR_STRATEGY_SUBSTRING / TV_STRATEGY_NAME so data_get_strategy_results picks it
 *
 * Input IDs (in_*) shift when Pine inputs change. This script discovers RR / POC buffer / fast MACD
 * by matching baseline numeric fingerprints from data_get_indicator.
 *
 * Usage (from tradingview-mcp):
 *   node scripts/run-macd-sniper-pf-grid.mjs
 *
 * Env:
 *   INPUT_DELAY_MS   — wait after each indicator_set_inputs (default 4500)
 *   GRID_RR          — comma list e.g. "1.5,2,2.5,3"
 *   GRID_POC_BUF     — comma list e.g. "4,6,8"
 *   GRID_FAST        — comma list e.g. "10,12,14"
 *   MACD_ID_FAST / MACD_ID_POC / MACD_ID_RR — override discovery
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS || 4500);
const SUBSTR = process.env.ADVISOR_STRATEGY_SUBSTRING || process.env.TV_STRATEGY_NAME || 'MACD Sniper';

const GRID_RR = (process.env.GRID_RR || '1.5,2,2.5,3').split(',').map(Number);
const GRID_POC = (process.env.GRID_POC_BUF || '4,6,8').split(',').map(Number);
const GRID_FAST = (process.env.GRID_FAST || '10,12,14').split(',').map(Number);

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
  const studies = state?.studies || [];
  const esc = SUBSTR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = studies.find((s) => new RegExp(esc, 'i').test(s.name || ''));
  return hit?.id ?? null;
}

function discoverIds(inputs) {
  const envFast = process.env.MACD_ID_FAST || 'in_0';
  const envPoc = process.env.MACD_ID_POC || 'in_51';
  const envRr = process.env.MACD_ID_RR || 'in_52';
  if (process.env.MACD_SKIP_VALIDATE === '1') {
    return { idFast: envFast, idPoc: envPoc, idRr: envRr };
  }
  const map = Object.fromEntries(inputs.filter((x) => /^in_\d+$/.test(x.id)).map((x) => [x.id, x.value]));
  const ok = map[envFast] !== undefined && map[envPoc] !== undefined && map[envRr] !== undefined;
  if (!ok) {
    throw new Error(`Missing expected inputs ${envFast}, ${envPoc}, ${envRr}. Open chart script settings and set MACD_ID_* from data_get_indicator.`);
  }
  return { idFast: envFast, idPoc: envPoc, idRr: envRr };
}

function rankPF(a, b) {
  const pf = (b.profitFactor ?? 0) - (a.profitFactor ?? 0);
  if (pf !== 0) return pf;
  return (b.netProfit ?? 0) - (a.netProfit ?? 0);
}

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'macd-sniper-pf-grid', version: '1.0.0' });
await client.connect(transport);

const state = await callJson(client, 'chart_get_state', {});
const entityId = process.env.TV_ENTITY_ID || findStudyId(state);
if (!entityId) {
  console.error(JSON.stringify({ error: 'no_study', studies: state?.studies, hint: SUBSTR }, null, 2));
  process.exit(1);
}

const ind = await callJson(client, 'data_get_indicator', { entity_id: entityId });
if (!ind.success || !ind.inputs) {
  console.error(JSON.stringify({ error: 'data_get_indicator_failed', ind }, null, 2));
  process.exit(1);
}

const { idFast, idPoc, idRr } = discoverIds(ind.inputs);
const baseline = {};
for (const { id, value } of ind.inputs) {
  if (/^in_\d+$/.test(id)) baseline[id] = value;
}

const scenarios = [];
for (const rr of GRID_RR) {
  for (const poc of GRID_POC) {
    for (const fast of GRID_FAST) {
      scenarios.push({ rr, poc, fast });
    }
  }
}

const results = [];
const failed = [];

for (let i = 0; i < scenarios.length; i++) {
  const sc = scenarios[i];
  const patch = {
    ...baseline,
    [idRr]: sc.rr,
    [idPoc]: sc.poc,
    [idFast]: sc.fast,
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
  const data = await callJson(client, 'data_get_strategy_results', {});
  const m = data.metrics;
  if (!data.report_ready || !m || typeof m.profitFactor !== 'number') {
    failed.push({
      i,
      sc,
      reason: data.hint || data.error || data.pick_note || 'no metrics',
      strategy_name: data.strategy_name,
    });
    continue;
  }

  results.push({
    scenarioIndex: i,
    rr: sc.rr,
    pocBufTicks: sc.poc,
    fastLen: sc.fast,
    profitFactor: m.profitFactor,
    netProfit: m.netProfit,
    totalTrades: m.totalTrades,
    percentProfitable: m.percentProfitable,
    strategy_name: data.strategy_name,
    pick_note: data.pick_note,
  });
}

results.sort(rankPF);
const best = results[0] || null;
const outPath = join(ROOT, 'macd-sniper-pf-grid-report.json');
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      entity_id: entityId,
      input_ids: { idFast, idPoc, idRr },
      scenario_count: scenarios.length,
      ok_count: results.length,
      failed,
      best,
      top_15: results.slice(0, 15),
    },
    null,
    2,
  ),
  'utf8',
);

console.log(`Wrote ${outPath}`);
console.log(
  best
    ? `Best PF=${best.profitFactor} net=${best.netProfit} trades=${best.totalTrades} rr=${best.rr} poc=${best.pocBufTicks} fast=${best.fastLen}`
    : 'No successful rows',
);

await client.close().catch(() => {});
