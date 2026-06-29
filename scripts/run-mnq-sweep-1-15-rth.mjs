/**
 * Sequential MCP sweep: timeframes "1".."15" only, after applying Session Exit
 * flatten = 3:00 PM US Eastern (≈ 2:00 PM America/Chicago) on Sweep Engine v2.0 — Secondary.
 *
 * Prerequisites: TradingView Desktop + CDP, chart with Secondary strategy, CBC + MMT v4 optional overlay.
 *
 * Usage (from tradingview-mcp root):
 *   node scripts/run-mnq-sweep-1-15-rth.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TF_MIN = 1;
const TF_MAX = 15;
const FLAT_HR_CT = 14; // 2pm Chicago = 3pm Eastern (EST/EDT aligned with US DST)
const FLAT_MN_CT = 0;
const SETTLE_MS = 4500;

// Strategy Tester readout: match CBC + Multi-Session Sweep [MMT v4] (override with env)
if (process.env.TV_STRATEGY_NAME === undefined && process.env.ADVISOR_STRATEGY_SUBSTRING === undefined) {
  process.env.TV_STRATEGY_NAME = 'MMT v4';
}

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

function slimRow(data, tf) {
  const m = data.metrics || {};
  return {
    timeframe: tf,
    netProfit: m.netProfit,
    profitFactor: m.profitFactor,
    maxContractsHeld: m.maxContractsHeld,
    totalTrades: m.totalTrades,
    percentProfitable: m.percentProfitable,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    strategy_name: data.strategy_name,
  };
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
  return Number(a.timeframe) - Number(b.timeframe);
}

function findStudyId(state, substr) {
  const studies = state.studies || [];
  const hit = studies.find((s) => (s.name || '').includes(substr));
  return hit?.id ?? null;
}

/** Prefer Strategy Tester target: Secondary sandbox, not CBC overlay. */
function resolveStrategyEntityId(state) {
  const studies = state.studies || [];
  let hit = studies.find((s) => /secondary|sv2\s*2nd/i.test(s.name || ''));
  if (hit) return hit.id;
  hit = studies.find(
    (s) => (s.name || '').includes('Sweep Engine') && (s.name || '').includes('Secondary')
  );
  if (hit) return hit.id;
  return null;
}

/** Match TV input rows to Flatten hour/minute (Chicago) — blob match (labels vary). */
function findFlattenInputIds(inputs) {
  if (!Array.isArray(inputs)) return { flatHrId: null, flatMnId: null, notes: 'no inputs array' };
  let flatHrId = null;
  let flatMnId = null;
  for (const inp of inputs) {
    const blob = JSON.stringify(inp).toLowerCase();
    if (!/flatten|flat\s*at|eod|end\s*of\s*day|session\s*exit/.test(blob)) continue;
    if (!/chicago|\(ct\)|\bct\b|central|america\/chicago/.test(blob)) continue;
    if (/hour/.test(blob) && !/minute/.test(blob)) {
      flatHrId = inp.id;
    }
    if (/minute/.test(blob)) {
      flatMnId = inp.id;
    }
  }
  return { flatHrId, flatMnId, notes: `scanned ${inputs.length} inputs` };
}

/** Some scripts label flatten in Eastern / NY instead of Chicago. */
function findFlattenInputIdsEastern(inputs) {
  if (!Array.isArray(inputs)) return { flatHrId: null, flatMnId: null, notes: 'no inputs array' };
  let flatHrId = null;
  let flatMnId = null;
  for (const inp of inputs) {
    const blob = JSON.stringify(inp).toLowerCase();
    if (!/flatten|flat|close.*position|session.*end|cutoff/.test(blob)) continue;
    if (!/eastern|new\s*york|ny|america\/new_york|et|est|edt/.test(blob)) continue;
    if (/hour/.test(blob) && !/minute/.test(blob)) {
      flatHrId = inp.id;
    }
    if (/minute/.test(blob)) {
      flatMnId = inp.id;
    }
  }
  return { flatHrId, flatMnId, notes: `scanned ${inputs.length} inputs (eastern)` };
}

async function findFlattenAcrossStudies(client, studies) {
  for (const st of studies) {
    const id = st.id;
    if (!id) continue;
    const ind = await callJson(client, 'data_get_indicator', { entity_id: id });
    const inputs = ind.inputs || [];
    let found = findFlattenInputIds(inputs);
    if (found.flatHrId && found.flatMnId) {
      return { entityId: id, studyName: st.name, ...found, mode: 'chicago' };
    }
    found = findFlattenInputIdsEastern(inputs);
    if (found.flatHrId && found.flatMnId) {
      return { entityId: id, studyName: st.name, ...found, mode: 'eastern' };
    }
  }
  return { entityId: null, studyName: null, flatHrId: null, flatMnId: null, notes: 'no study had flatten hour+minute', mode: null };
}

const timestamp = new Date().toString();

const transport = new StdioClientTransport({
  command: 'node',
  args: [join(ROOT, 'src/server.js')],
  cwd: ROOT,
});

const client = new Client({ name: 'mnq-sweep-1-15-rth', version: '1.0.0' });
await client.connect(transport);

await callJson(client, 'chart_set_symbol', { symbol: 'CME_MINI:MNQ1!' });
await callJson(client, 'chart_set_type', { chart_type: 'Candles' });
await callJson(client, 'ui_open_panel', { panel: 'strategy-tester', action: 'open' });
await sleep(500);

const state = await callJson(client, 'chart_get_state', {});
const studies = state.studies || [];
const secondaryId = resolveStrategyEntityId(state);
const cbcId = findStudyId(state, 'CBC') || findStudyId(state, 'Multi-Session') || findStudyId(state, 'MMT');

let sessionSection = [];
sessionSection.push(`TV_STRATEGY_NAME / tester filter: ${process.env.TV_STRATEGY_NAME || process.env.ADVISOR_STRATEGY_SUBSTRING || 'default Secondary'}`);
sessionSection.push(`Sweep Engine Secondary entity (if on chart): ${secondaryId ?? 'not found'}`);
sessionSection.push(`CBC / MMT entity (name match): ${cbcId ?? 'not found'}`);

let flatApply = { ok: false, flatHrId: null, flatMnId: null, updated: {}, error: null, entityId: null, mode: null };

const flatTarget = await findFlattenAcrossStudies(client, studies);
sessionSection.push(
  `Flatten scan: ${flatTarget.entityId ? `study "${flatTarget.studyName}" (${flatTarget.entityId}) mode=${flatTarget.mode}` : flatTarget.notes || 'nothing found'}`
);
sessionSection.push(`Detected flatten hour id: ${flatTarget.flatHrId ?? 'MISSING'}`);
sessionSection.push(`Detected flatten minute id: ${flatTarget.flatMnId ?? 'MISSING'}`);

if (flatTarget.entityId && flatTarget.flatHrId && flatTarget.flatMnId) {
  const flatHrVal = flatTarget.mode === 'eastern' ? 15 : FLAT_HR_CT;
  const flatMnVal = flatTarget.mode === 'eastern' ? 0 : FLAT_MN_CT;
  const payload = JSON.stringify({
    [flatTarget.flatHrId]: flatHrVal,
    [flatTarget.flatMnId]: flatMnVal,
  });
  const setRes = await callJson(client, 'indicator_set_inputs', {
    entity_id: flatTarget.entityId,
    inputs: payload,
    persist_layout: true,
  });
  flatApply = {
    ok: setRes.success !== false && !setRes.error,
    entityId: flatTarget.entityId,
    mode: flatTarget.mode,
    flatHrId: flatTarget.flatHrId,
    flatMnId: flatTarget.flatMnId,
    valuesSet: { hour: flatHrVal, minute: flatMnVal },
    updated: setRes.updated_inputs || {},
    error: setRes.error || null,
  };
  sessionSection.push(`indicator_set_inputs flatten -> ${JSON.stringify(setRes.updated_inputs || {})}`);
  await sleep(SETTLE_MS);
} else {
  flatApply.error =
    'No study on chart exposed Flatten hour+minute inputs (Chicago or Eastern). Set Session Exit manually in TradingView for CBC / Sweep.';
  sessionSection.push(flatApply.error);
}

// CBC + Multi-Session Sweep [MMT v4]: TV API returns inputs as in_* only (no titles). Dump showed in_71=8, in_72=11
// as a plausible clock-hour window; set end hour to 15 for 3:00 PM last hour (verify in indicator settings UI).
const CBC_SESSION = {
  startId: 'in_71',
  endId: 'in_72',
  startHour: Number(process.env.CBC_NY_START_HR ?? 8),
  endHour: Number(process.env.CBC_NY_END_HR ?? 15),
};
let cbcSessionApply = { ok: false, updated: {}, error: null };
if (cbcId) {
  const payload = JSON.stringify({
    [CBC_SESSION.startId]: CBC_SESSION.startHour,
    [CBC_SESSION.endId]: CBC_SESSION.endHour,
  });
  sessionSection.push('');
  sessionSection.push(
    `CBC session window (hypothesis — confirm labels in TradingView): ${CBC_SESSION.startId}=${CBC_SESSION.startHour}, ${CBC_SESSION.endId}=${CBC_SESSION.endHour} (targets ~8:00–15:00 clock in script timezone; intended as 8am–3pm Eastern-style day session).`
  );
  const setRes = await callJson(client, 'indicator_set_inputs', {
    entity_id: cbcId,
    inputs: payload,
    persist_layout: true,
  });
  cbcSessionApply = {
    ok: setRes.success !== false && !setRes.error && Object.keys(setRes.updated_inputs || {}).length > 0,
    updated: setRes.updated_inputs || {},
    error: setRes.error || null,
  };
  sessionSection.push(`CBC indicator_set_inputs -> ${JSON.stringify(setRes.updated_inputs || {})}`);
  if (!cbcSessionApply.ok && !cbcSessionApply.error) {
    cbcSessionApply.error = 'updated_inputs empty — in_71/in_72 may not match this script build';
    sessionSection.push(cbcSessionApply.error);
  }
  await sleep(SETTLE_MS);
}

sessionSection.push('');
sessionSection.push('Session policy (this run):');
sessionSection.push(
  `- 3:00 PM US Eastern (last trading hour): for CBC, applied as end hour ${CBC_SESSION.endHour} on inputs ${CBC_SESSION.endId} together with start hour ${CBC_SESSION.startHour} on ${CBC_SESSION.startId} (script timezone is defined inside the indicator — confirm in TradingView settings that these map to your intended NY session).`
);
sessionSection.push(
  '- 8:00 AM–3:00 PM Eastern preference: start hour 8 applied on the same input pair as above when CBC is used; if the indicator uses exchange time or Chicago time internally, adjust CBC_NY_START_HR / CBC_NY_END_HR env vars and re-run.'
);
sessionSection.push(
  `- Sweep Engine v2.0 — Secondary (if present): flatten-by-Chicago-time uses inputs matched by name "Flatten" + Chicago; set Flatten hour=14, minute=0 for 3:00 PM Eastern equivalent.`
);
sessionSection.push(
  `- Strategy Tester readout filter: ${process.env.TV_STRATEGY_NAME || process.env.ADVISOR_STRATEGY_SUBSTRING || 'Secondary'} (default in script: MMT v4 → CBC).`
);

const successful = [];
const failed = [];

for (let tf = TF_MIN; tf <= TF_MAX; tf++) {
  const s = String(tf);
  const setRes = await callJson(client, 'chart_set_timeframe', { timeframe: s });
  if (setRes._parseError) {
    failed.push({ timeframe: s, reason: `chart_set_timeframe: ${setRes._parseError}` });
    continue;
  }
  if (setRes.success === false) {
    failed.push({ timeframe: s, reason: `chart_set_timeframe: ${setRes.error || 'failed'}` });
    continue;
  }
  await sleep(800);
  const data = await callJson(client, 'data_get_strategy_results', {});
  if (isSuccessRow(data)) {
    successful.push(slimRow(data, s));
  } else {
    const reason =
      data.error ||
      data.hint ||
      (data.metric_count === 0 ? 'empty or incomplete strategy metrics' : 'could not parse net profit') ||
      data._parseError ||
      'unknown';
    failed.push({ timeframe: s, reason: String(reason) });
  }
}

const sorted = [...successful].sort(compareRows);
const best = sorted[0] || null;
const top15 = sorted.slice(0, 15);

const reportLines = [];
reportLines.push(
  'MNQ + CBC + Multi-Session Sweep [MMT v4] — sweep timeframes 1m–15m only (session window applied per notes below)'
);
reportLines.push(`Timestamp: ${timestamp}`);
reportLines.push('');
reportLines.push('=== Session / flatten application ===');
reportLines.push(sessionSection.join('\n'));
reportLines.push('');
reportLines.push('=== Sweep ===');
reportLines.push(`Timeframes: ${TF_MIN} .. ${TF_MAX} (minute bars)`);
reportLines.push(`Successful: ${successful.length} / ${TF_MAX - TF_MIN + 1}`);
reportLines.push(`Failed: ${failed.length} / ${TF_MAX - TF_MIN + 1}`);
reportLines.push('Ranking: max netProfit, then max profitFactor, then min abs(grossLoss)');
reportLines.push('');
reportLines.push('=== Best scenario ===');
if (best) {
  reportLines.push(JSON.stringify(best, null, 2));
} else {
  reportLines.push('No successful rows.');
}
reportLines.push('');
reportLines.push('=== Full ranking (all successful) ===');
reportLines.push('Rank | tf | netProfit | profitFactor | maxContracts | trades | %win | grossProfit | grossLoss');
sorted.forEach((r, i) => {
  reportLines.push(
    `${i + 1} | ${r.timeframe} | ${r.netProfit?.toFixed(2)} | ${r.profitFactor?.toFixed(6)} | ${r.maxContractsHeld} | ${r.totalTrades} | ${((r.percentProfitable ?? 0) * 100).toFixed(2)}% | ${r.grossProfit?.toFixed(2)} | ${r.grossLoss?.toFixed(2)}`
  );
});
if (failed.length) {
  reportLines.push('');
  reportLines.push('=== Failed ===');
  for (const f of failed) {
    reportLines.push(`${f.timeframe}: ${f.reason}`);
  }
}

const reportOut = reportLines.join('\n').replace(/\u2014/g, ' - ');

writeFileSync(
  'C:\\Users\\dypag\\MNQ_sweep_1_15_rth_raw.json',
  JSON.stringify(
    {
      generatedAt: timestamp,
      flatApply,
      cbcSessionApply,
      cbcSession: CBC_SESSION,
      cbcEntityId: cbcId,
      successful,
      failed,
      best,
      top15,
    },
    null,
    2
  ),
  'utf8'
);
writeFileSync('C:\\Users\\dypag\\MNQ_sweep_1_15_rth_results.txt', reportOut, 'utf8');

await client.close();
console.log(
  JSON.stringify(
    {
      ok: true,
      successCount: successful.length,
      failedCount: failed.length,
      bestTf: best?.timeframe ?? null,
      sweepEngineFlattenApplied: flatApply.ok,
      cbcSessionWindowApplied: cbcSessionApply.ok,
    },
    null,
    2
  )
);
