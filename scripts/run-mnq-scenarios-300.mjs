/**
 * 300 sequential Strategy Tester scenarios for CBC + Multi-Session Sweep [MMT v4] on MNQ.
 *
 * Grid (25 * 4 * 3 = 300):
 *   - Timeframes: minute bars 1 .. 25
 *   - in_72 / in_71 in this script were chosen from an older chart dump — they are NOT reliable session
 *     hours for `CBC_MultiSession_Sweep_STRATEGY_v4.pine` (there in_71/in_72 are NY KZ end/start hours).
 *     Prefer `npm run cbc:htf-grid` for HTF/session-style sweeps, or run `CBC_VERIFY=1` on
 *     `run-cbc-htf-zone-grid.mjs` and remap this file after `tv indicator get`.
 *   - Extra float (in_4): 1.0, 1.5, 2.0 — confirm meaning on your build via TV inputs UI / indicator get.
 *
 * Env:
 *   TV_STRATEGY_NAME, ADVISOR_STRATEGY_SUBSTRING — strategy picker (default MMT v4)
 *   CBC_ENTITY_ID — optional study id (default: auto-detect name match)
 *   CBC_SESSION_START — start hour for in_71 (default 8)
 *   TF_DELAY_MS — after chart_set_timeframe (default 700)
 *   INPUT_DELAY_MS — after indicator_set_inputs (default 3200)
 *
 * Usage: node scripts/run-mnq-scenarios-300.mjs
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

const TF_DELAY_MS = Number(process.env.TF_DELAY_MS || 700);
const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS || 3200);
const SESSION_START = Number(process.env.CBC_SESSION_START || 8);

const TIME_FRAMES = Array.from({ length: 25 }, (_, i) => String(i + 1));
const SESSION_END_HOURS = [13, 14, 15, 16];
const IN4_GRID = [1.0, 1.5, 2.0];

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
  if (!data || data._parseError) return false;
  if (data.success === false) return false;
  if (data.error) return false;
  const m = data.metrics;
  if (!m || typeof m !== 'object') return false;
  if (typeof m.netProfit !== 'number' || Number.isNaN(m.netProfit)) return false;
  return true;
}

function findCbcId(state, envId) {
  const trimmed = (envId || '').trim();
  if (trimmed) return trimmed;
  const studies = state.studies || [];
  const hit =
    studies.find((s) => /MMT|CBC|Multi-Session/i.test(s.name || '')) ||
    studies.find((s) => (s.name || '').includes('Sweep'));
  return hit?.id ?? null;
}

function buildScenarios() {
  const out = [];
  let id = 0;
  for (const tf of TIME_FRAMES) {
    for (const endHr of SESSION_END_HOURS) {
      for (const in4 of IN4_GRID) {
        out.push({
          scenarioId: id++,
          timeframe: tf,
          in_71: SESSION_START,
          in_72: endHr,
          in_4: in4,
        });
      }
    }
  }
  return out;
}

function rankKey(row) {
  const np = row.netProfit;
  const pf = row.profitFactor ?? -Infinity;
  const gl = Math.abs(row.grossLoss ?? 0);
  return [-np, -pf, gl];
}

function compareRows(a, b) {
  const ka = rankKey(a);
  const kb = rankKey(b);
  for (let i = 0; i < 3; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return a.scenarioId - b.scenarioId;
}

const timestamp = new Date().toISOString();
const scenarios = buildScenarios();
if (scenarios.length !== 300) {
  throw new Error(`Expected 300 scenarios, got ${scenarios.length}`);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [join(ROOT, 'src/server.js')],
  cwd: ROOT,
});

const client = new Client({ name: 'mnq-300', version: '1.0.0' });
await client.connect(transport);

await callJson(client, 'chart_set_symbol', { symbol: 'CME_MINI:MNQ1!' });
await callJson(client, 'chart_set_type', { chart_type: 'Candles' });
await callJson(client, 'ui_open_panel', { panel: 'strategy-tester', action: 'open' });
await sleep(500);

const state = await callJson(client, 'chart_get_state', {});
const cbcId = findCbcId(state, process.env.CBC_ENTITY_ID);

const results = [];
const failed = [];

if (!cbcId) {
  failed.push({ scenario: -1, reason: 'CBC / MMT study id not found; set CBC_ENTITY_ID' });
} else {
  let lastTf = null;
  for (const sc of scenarios) {
    if (sc.timeframe !== lastTf) {
      const tr = await callJson(client, 'chart_set_timeframe', { timeframe: sc.timeframe });
      if (tr.success === false || tr._parseError) {
        failed.push({
          scenarioId: sc.scenarioId,
          reason: `chart_set_timeframe: ${tr.error || tr._parseError}`,
          ...sc,
        });
        lastTf = sc.timeframe;
        continue;
      }
      lastTf = sc.timeframe;
      await sleep(TF_DELAY_MS);
    }

    const payload = JSON.stringify({
      in_71: sc.in_71,
      in_72: sc.in_72,
      in_4: sc.in_4,
    });
    const setRes = await callJson(client, 'indicator_set_inputs', {
      entity_id: cbcId,
      inputs: payload,
      persist_layout: false,
    });
    if (setRes.success === false || setRes.error) {
      failed.push({
        scenarioId: sc.scenarioId,
        reason: `indicator_set_inputs: ${setRes.error || 'failed'}`,
        ...sc,
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
        timeframe: sc.timeframe,
        in_71: sc.in_71,
        in_72: sc.in_72,
        in_4: sc.in_4,
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
    } else {
      failed.push({
        scenarioId: sc.scenarioId,
        reason: data.error || data.hint || data._parseError || 'no metrics',
        ...sc,
      });
    }
  }

  await callJson(client, 'indicator_set_inputs', {
    entity_id: cbcId,
    inputs: JSON.stringify({
      in_71: SESSION_START,
      in_72: 15,
      in_4: 1.5,
    }),
    persist_layout: true,
  });
}

const sorted = [...results].sort(compareRows);
const best = sorted[0] || null;
const top25 = sorted.slice(0, 25);

const lines = [];
lines.push('MNQ CBC [MMT v4] — 300 scenario grid');
lines.push(`Timestamp: ${timestamp}`);
lines.push(`Strategy filter: ${process.env.TV_STRATEGY_NAME || process.env.ADVISOR_STRATEGY_SUBSTRING}`);
lines.push(`CBC entity: ${cbcId || 'MISSING'}`);
lines.push('');
lines.push('Grid: 25 timeframes (1-25m) x 4 session end hours (in_72: 13-16) x 3 in_4 values (1.0, 1.5, 2.0)');
lines.push(`Session start in_71: ${SESSION_START} (override with CBC_SESSION_START)`);
lines.push(`Completed OK: ${results.length} / 300 | Failed: ${failed.length}`);
lines.push('Rank: max netProfit, then max profitFactor, then min abs(grossLoss)');
lines.push('');
lines.push('=== Best ===');
lines.push(best ? JSON.stringify(best, null, 2) : 'none');
lines.push('');
lines.push('=== Top 25 ===');
lines.push('rank | scen | tf | in_72 | in_4 | netProfit | PF | trades | %win | grossP | grossL');
sorted.slice(0, 25).forEach((r, i) => {
  lines.push(
    `${i + 1} | ${r.scenarioId} | ${r.timeframe} | ${r.in_72} | ${r.in_4} | ${r.netProfit?.toFixed(2)} | ${r.profitFactor?.toFixed(4)} | ${r.totalTrades} | ${((r.percentProfitable ?? 0) * 100).toFixed(2)}% | ${r.grossProfit?.toFixed(2)} | ${r.grossLoss?.toFixed(2)}`
  );
});
if (failed.length) {
  lines.push('');
  lines.push('=== Failures (first 40) ===');
  failed.slice(0, 40).forEach((f) => {
    lines.push(`scen ${f.scenarioId}: ${f.reason}`);
  });
}

lines.push('');
lines.push('=== Follow-ups (benefit the strategy further) ===');
lines.push(
  '- If in_4 does not change results for many rows, confirm its label in TradingView; sweep inputs that actually move trade count or PnL (bools, session strings, risk groups).'
);
lines.push('- Refine near the best cluster (e.g. tf 22–25, in_72 12–14) with a smaller second grid instead of another full 300.');
lines.push(
  '- Pin Strategy Tester: set ADVISOR_STRATEGY_SUBSTRING=MMT v4 if pick_note warns the substring did not match.'
);
lines.push('- Tune TF_DELAY_MS / INPUT_DELAY_MS if you see inconsistent metrics between adjacent scenarios.');

const reportPath = 'C:\\Users\\dypag\\MNQ_scenarios_300_results.txt';
const rawPath = 'C:\\Users\\dypag\\MNQ_scenarios_300_raw.json';
writeFileSync(
  rawPath,
  JSON.stringify(
    {
      generatedAt: timestamp,
      cbcId,
      sessionStart: SESSION_START,
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
writeFileSync(reportPath, lines.join('\n').replace(/\u2014/g, ' - '), 'utf8');

await client.close();
console.log(
  JSON.stringify(
    {
      ok: true,
      successCount: results.length,
      failedCount: failed.length,
      bestScenarioId: best?.scenarioId ?? null,
      reportPath,
      rawPath,
    },
    null,
    2
  )
);
