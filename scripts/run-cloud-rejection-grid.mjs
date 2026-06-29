/**
 * Scenario grid for Cloud Rejection Strategy ("Cloud Rejection" in study name).
 * Input IDs align with bundled Pine Cloud Rejection v1.3+ (see repo cloud-rejection-strategy-v12.pine).
 *
 * Prerequisites: MNQ chart, Cloud Rejection on chart, Strategy Tester open.
 *
 * Env:
 *   CLOUD_REJ_ENTITY_ID — study entity id (auto-detect name if unset)
 *   CLOUD_REJ_IDS — optional JSON semantic→in_N map overrides defaults
 *   SYMBOL, TIMEFRAME — default CME_MINI:MNQ1! / 5
 *   INPUT_DELAY_MS — default 4500
 *   ADVISOR_STRATEGY_SUBSTRING — pins strategy picker (default Cloud Rejection)
 *   GRID_MIN_TRADES — scoring penalty threshold
 *
 * Usage: npm run grid:cloud-rej   OR   node scripts/run-cloud-rejection-grid.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

process.env.ADVISOR_STRATEGY_SUBSTRING ||= 'Cloud Rejection';

const SYMBOL = process.env.SYMBOL || 'CME_MINI:MNQ1!';
const TIMEFRAME = process.env.TIMEFRAME || '5';
const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS || 4500);
const ENV_ENTITY = (process.env.CLOUD_REJ_ENTITY_ID || '').trim();

/**
 * Semantic keys → TV `in_*` IDs for bundled `cloud-rejection-strategy-v12.pine`
 * (includes `minPullbackAtr` at **in_6**).
 *
 * Older saved copies **without `minPullbackAtr`** shift the RQ/stop block down by **one**
 * (rqGate → **in_9**, atrMax → **in_14**).
 *
 * Scripts **without the v1.4 Swing Proximity group** shift session IDs down by **four**
 * versus the defaults below (cross-check via MCP `data_get_indicator`).
 */
const IDS = (() => {
  const raw = (process.env.CLOUD_REJ_IDS || '').trim();
  if (raw) return JSON.parse(raw);
  return {
    cloudSmooth: 'in_3',
    cooldownBars: 'in_5',
    rqGateOn: 'in_10',
    atrMaxMult: 'in_15',
    /** After adding “Swing Proximity” group (v1.4) above VWAP/session */
    useSession: 'in_31',
    nySessionOn: 'in_32',
    sessNy: 'in_33',
    globexAsiaOn: 'in_34',
    sessGlobexAsia: 'in_35',
  };
})();

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

function findCloudRejectionId(state) {
  if (ENV_ENTITY) return ENV_ENTITY;
  const studies = state.studies || [];
  const hit = studies.find((s) => /cloud rejection/i.test(s.name || ''));
  return hit?.id ?? null;
}

/**
 * Produce flat TV overrides: { in_N: value, ... }
 */
function scenarioToOverrides(spec) {
  const o = {};
  o[IDS.rqGateOn] = spec.rqGateOn;
  o[IDS.cooldownBars] = spec.cooldownBars;
  o[IDS.cloudSmooth] = spec.cloudSmooth;
  o[IDS.atrMaxMult] = spec.atrMaxMult;
  o[IDS.useSession] = spec.useSession;
  o[IDS.nySessionOn] = spec.nySessionOn;
  o[IDS.globexAsiaOn] = spec.globexAsiaOn;
  o[IDS.sessNy] = spec.sessNy;
  o[IDS.sessGlobexAsia] = spec.sessGlobexAsia;
  return o;
}

function buildScenarios() {
  const rqGates = [38, 45, 55];
  const cooldowns = [0, 3];
  const smooths = [1, 2];
  const atrMults = [1.65, 1.95];

  /** Which session halves are armed (NY vs Globex / “Asia-leaning ETH”) */
  const sessionSlices = [
    { label: 'ny_globex', ny: true, globex: true, nySes: '0930-1600', gxSes: '1800-0900' },
    { label: 'ny_only', ny: true, globex: false, nySes: '0930-1600', gxSes: '1800-0900' },
    { label: 'globex_only', ny: false, globex: true, nySes: '0930-1600', gxSes: '1800-0900' },
  ];

  const rows = [];
  let id = 0;
  for (const rg of rqGates) {
    for (const cd of cooldowns) {
      for (const sm of smooths) {
        for (const am of atrMults) {
          for (const slice of sessionSlices) {
            rows.push({
              scenarioId: id++,
              rqGateOn: rg,
              cooldownBars: cd,
              cloudSmooth: sm,
              atrMaxMult: am,
              useSession: true,
              nySessionOn: slice.ny,
              globexAsiaOn: slice.globex,
              sessNy: slice.nySes,
              sessGlobexAsia: slice.gxSes,
              _slice: slice.label,
            });
          }
        }
      }
    }
  }
  return rows;
}

function isSuccessRow(data) {
  if (!data || data._parseError) return false;
  if (data.success === false) return false;
  const m = data.metrics;
  if (!m || typeof m !== 'object') return false;
  if (typeof m.netProfit !== 'number' || Number.isNaN(m.netProfit)) return false;
  return true;
}

function scoreRow(r) {
  const trades = r.totalTrades || 0;
  const pf = r.profitFactor ?? 0;
  const np = r.netProfit ?? 0;
  const minTrades = Number(process.env.GRID_MIN_TRADES || '4');
  if (trades < minTrades) return np - 1e6 + trades * 500;
  if (pf >= 1.0) return np * 1000 + pf * 500 + trades;
  return np + pf * 50 + trades * 20;
}

const scenarios = buildScenarios();
console.error(`Built ${scenarios.length} scenarios (symbol=${SYMBOL}, tf=${TIMEFRAME}), ids=${JSON.stringify(IDS)}`);

const transport = new StdioClientTransport({
  command: 'node',
  args: [join(ROOT, 'src/server.js')],
  cwd: ROOT,
});

const client = new Client({ name: 'cloud-rej-grid', version: '1.1.0' });
await client.connect(transport);

await callJson(client, 'chart_set_symbol', { symbol: SYMBOL });
await callJson(client, 'chart_set_timeframe', { timeframe: TIMEFRAME });
await sleep(800);
await callJson(client, 'ui_open_panel', { panel: 'strategy-tester', action: 'open' });
await sleep(400);

const state = await callJson(client, 'chart_get_state', {});
const entityId = findCloudRejectionId(state);

const results = [];
const failed = [];

if (!entityId) {
  failed.push({ scenario: -1, reason: 'Cloud Rejection strategy not found; pin CLOUD_REJ_ENTITY_ID' });
  console.error(JSON.stringify({ failed }, null, 2));
  await client.close();
  process.exit(1);
}

for (const sc of scenarios) {
  const overrides = scenarioToOverrides(sc);
  const payload = JSON.stringify(overrides);
  const setRes = await callJson(client, 'indicator_set_inputs', {
    entity_id: entityId,
    inputs: payload,
    persist_layout: false,
  });
  if (setRes.success === false || setRes.error) {
    failed.push({
      scenarioId: sc.scenarioId,
      reason: String(setRes.error || 'indicator_set_inputs failed'),
      overrides,
    });
    await sleep(INPUT_DELAY_MS);
    continue;
  }
  await sleep(INPUT_DELAY_MS);

  const data = await callJson(client, 'data_get_strategy_results', {});
  if (isSuccessRow(data)) {
    const m = data.metrics;
    results.push({
      scenarioId: sc.scenarioId,
      slice: sc._slice,
      rqGateOn: sc.rqGateOn,
      overrides,
      strategy_name: data.strategy_name,
      netProfit: m.netProfit,
      profitFactor: m.profitFactor,
      totalTrades: m.totalTrades,
      percentProfitable: m.percentProfitable,
      grossProfit: m.grossProfit,
      grossLoss: m.grossLoss,
      commissionPaid: m.commissionPaid,
      update_report_clicks: setRes.update_report_banner_clicks ?? null,
    });
    process.stderr.write('.');
  } else {
    failed.push({
      scenarioId: sc.scenarioId,
      reason: data._parseError || data.error || 'no metrics',
      overrides,
    });
  }
}

process.stderr.write('\n');

mkdirSync(join(ROOT, 'data'), { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const base = join(ROOT, `data/cloud_rejection_grid_${ts}`);
writeFileSync(`${base}.json`, JSON.stringify({ entityId, IDS, results, failed }, null, 2));
writeFileSync(`${base}.ndjson`, results.map((r) => JSON.stringify(r)).join('\n'), 'utf8');

results.sort((a, b) => scoreRow(b) - scoreRow(a));
const top = results.slice(0, 12);

console.log(JSON.stringify({ entityId, scenarioCount: scenarios.length, ok: results.length, failed: failed.length, top }, null, 2));

if (top.length > 0) {
  const w = scenarios.find((s) => s.scenarioId === top[0].scenarioId);
  if (w) {
    console.error('\nApplying best-ranked scenario to chart (persist layout)...');
    const applied = await callJson(client, 'indicator_set_inputs', {
      entity_id: entityId,
      inputs: JSON.stringify(scenarioToOverrides(w)),
      persist_layout: true,
    });
    console.error(JSON.stringify({ applied, winnerScenarioId: w.scenarioId }, null, 2));
  }
}

await client.close();
