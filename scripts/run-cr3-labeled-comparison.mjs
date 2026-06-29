#!/usr/bin/env node
/**
 * Export labeled trades + compare to baseline run.
 * Usage: node scripts/run-cr3-labeled-comparison.mjs [baselineRunDir]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect, evaluate, KNOWN_PATHS } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as ui from '../src/core/ui.js';
import { parseWickEntryComment, paneFieldsToRow, researchBucket } from './cr3-label-utils.mjs';
import { pickCr3Entity } from './cr3-grid-utils.mjs';

const baselineDir =
  process.argv[2] || join(process.cwd(), 'data', 'grid_runs', 'cr3_trade_review_2026-05-30T00-00-54');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(process.cwd(), 'data', 'grid_runs', `cr3_prod_compare_${stamp}`);
mkdirSync(runDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mergeReportWithOrders(reportTrades, orders) {
  const entries = (orders || []).filter((o) => o.e === true);
  return reportTrades.map((r, i) => {
    let entry_sig = r.comment || '';
    if (!entry_sig.includes('|')) {
      const match =
        entries.find((e) => Math.abs(Number(e.p) - Number(r.entryPx)) < 0.01) ||
        entries[i];
      entry_sig = match?.c || entry_sig;
    }
    const side =
      r.isLong === true
        ? 'Long'
        : r.isLong === false
          ? 'Short'
          : /^CR3_WL|^CR3_L/i.test(entry_sig)
            ? 'Long'
            : /^CR3_WU|^CR3_S/i.test(entry_sig)
              ? 'Short'
              : '';
    const pnl = r.pnl != null ? Number(r.pnl) : 0;
    const ep = Number(r.entryPx);
    const xp = Number(r.exitPx);
    const pts = side === 'Long' ? xp - ep : side === 'Short' ? ep - xp : 0;
    const entry_time = r.entryMs ? new Date(r.entryMs).toISOString().slice(0, 19) : '';
    const exit_time = r.exitMs ? new Date(r.exitMs).toISOString().slice(0, 19) : '';
    const snap = parseWickEntryComment(entry_sig);
    const t = {
      num: r.i ?? i + 1,
      side,
      entry_time,
      exit_time,
      entry_date: entry_time.slice(0, 10),
      entry_sig,
      exit_sig: '',
      entry_price: ep,
      exit_price: xp,
      pts: Math.round(pts * 100) / 100,
      pnl,
      win: pnl > 0,
    };
    t.exit_class = classifyExit(t);
    return {
      ...t,
      ...paneFieldsToRow(snap, side || t.side),
      label_matched: !!snap,
      pane_label: snap,
      research_bucket: snap ? researchBucket(snap, side) : '',
    };
  });
}

async function fetchReportTrades() {
  return evaluate(`
(function() {
  var chart = ${KNOWN_PATHS.chartApi}._chartWidget;
  var sources = chart.model().model().dataSources();
  var strat = null;
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    if (!s || !s.metaInfo) continue;
    var n = (s.metaInfo().description || s.metaInfo().shortDescription || '');
    if (/Full Stack|CR_v3|Cloud Regime v3/i.test(n) && !/v2\\./i.test(n)) { strat = s; break; }
  }
  if (!strat) return { trades: [] };
  var rd = strat.reportData ? (typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData) : null;
  if (rd && typeof rd.value === 'function') rd = rd.value();
  var trades = rd && rd.trades ? (typeof rd.trades.value === 'function' ? rd.trades.value() : rd.trades) : [];
  if (!Array.isArray(trades)) return { trades: [] };
  var out = [];
  for (var t = 0; t < trades.length; t++) {
    var tr = trades[t];
    out.push({
      i: t + 1,
      entryMs: tr.e && tr.e.tm != null ? tr.e.tm : null,
      exitMs: tr.x && tr.x.tm != null ? tr.x.tm : null,
      entryPx: tr.e && tr.e.p != null ? tr.e.p : null,
      exitPx: tr.x && tr.x.p != null ? tr.x.p : null,
      pnl: tr.tp && tr.tp.v != null ? tr.tp.v : null,
      comment: tr.c || tr.comment || '',
      isLong: tr.e && tr.e.b != null ? tr.e.b : null
    });
  }
  return { trades: out, count: out.length };
})()
`);
}

function classifyExit(t) {
  if (t.exit_sig === 'ADX_Block') return 'ADX_Block';
  if (t.win && Math.abs(t.pts - 20) < 2) return 'TP_20';
  if (t.win && Math.abs(t.pts - 40) < 2) return 'TP_40';
  if (!t.win && Math.abs(Math.abs(t.pts) - 10) < 2) return 'SL_10';
  if (!t.win && Math.abs(Math.abs(t.pts) - 20) < 2) return 'SL_20';
  return 'Other';
}

function pf(trades) {
  const gp = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  return gl ? +(gp / gl).toFixed(2) : null;
}

function summarize(trades, label) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const byBucket = {};
  for (const t of trades) {
    const k = t.research_bucket || '?';
    if (!byBucket[k]) byBucket[k] = { n: 0, pnl: 0, w: 0 };
    byBucket[k].n++;
    byBucket[k].pnl += t.pnl;
    if (t.pnl > 0) byBucket[k].w++;
  }
  const exitBreak = {};
  for (const t of trades) {
    if (!exitBreak[t.exit_class]) exitBreak[t.exit_class] = { n: 0, pnl: 0 };
    exitBreak[t.exit_class].n++;
    exitBreak[t.exit_class].pnl += t.pnl;
  }
  const entryTypes = {};
  for (const t of trades) {
    const base = (t.entry_sig || '').split('|')[0] || '?';
    if (!entryTypes[base]) entryTypes[base] = { n: 0, pnl: 0 };
    entryTypes[base].n++;
    entryTypes[base].pnl += t.pnl;
  }
  return {
    label,
    n: trades.length,
    net: +trades.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    wr: trades.length ? +(100 * wins.length / trades.length).toFixed(1) : 0,
    pf: pf(trades),
    avg_win: wins.length ? +(wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(2) : 0,
    avg_loss: losses.length ? +(losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(2) : 0,
    with_label_snap: trades.filter((t) => t.label_matched).length,
    entry_types: entryTypes,
    exit_breakdown: exitBreak,
    top_buckets: Object.entries(byBucket)
      .map(([bucket, v]) => ({
        bucket,
        n: v.n,
        pnl: +v.pnl.toFixed(2),
        wr: v.n ? +(100 * v.w / v.n).toFixed(1) : 0,
      }))
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 8),
  };
}

function toCsv(rows) {
  const headers = [
    'trade_num', 'side', 'entry_sig', 'exit_sig', 'entry_price', 'exit_price',
    'pnl_usd', 'pts', 'win', 'exit_class', 'conf', 'rsi', 'research_bucket',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

process.env.ADVISOR_STRATEGY_SUBSTRING = 'Full Stack';

await health.healthCheck();
await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5 }).catch(() => {});
await sleep(2000);

const state = await chart.getState();
const entityId = pickCr3Entity(state);
const ind = await data.getIndicator({ entity_id: entityId });
const strat = await data.getStrategyResults();
const m = strat.metrics || {};

const inputsMap = {};
for (const inp of ind.inputs || []) {
  if (inp.id?.startsWith('in_')) inputsMap[inp.id] = inp.value;
}

const ordersResp = await data.getTrades({ max_trades: 600 });
const reportResp = await fetchReportTrades();
let trades = mergeReportWithOrders(reportResp.trades || [], ordersResp.trades || []);

// Attach exit_sig from order pairs
let open = null;
const exitByEntryPx = new Map();
for (const o of ordersResp.trades || []) {
  if (o.e === true) open = o;
  else if (o.e === false && open) {
    exitByEntryPx.set(Number(open.p), o.c || '');
    open = null;
  }
}
trades = trades.map((t) => ({
  ...t,
  exit_sig: exitByEntryPx.get(t.entry_price) || t.exit_sig || '',
  exit_class: classifyExit({ ...t, exit_sig: exitByEntryPx.get(t.entry_price) || '' }),
}));

const baselineRaw = JSON.parse(readFileSync(join(baselineDir, 'trades_with_labels.json'), 'utf8'));
const baselineTrades = baselineRaw.trades || [];

const newSummary = summarize(trades, 'prod_preset_5m');
// Override with ST totals if report PnL sum diverges
if (m.netProfit != null && Math.abs(trades.reduce((s, t) => s + t.pnl, 0) - m.netProfit) > 1) {
  newSummary.net = +Number(m.netProfit).toFixed(2);
  newSummary.wr = m.percentProfitable != null ? +(m.percentProfitable * 100).toFixed(1) : newSummary.wr;
  newSummary.pf = m.profitFactor != null ? +Number(m.profitFactor).toFixed(2) : newSummary.pf;
  newSummary.n = m.totalTrades ?? trades.length;
}
const baseSummary = summarize(baselineTrades, 'baseline_1m_wick_loose');

const comparison = {
  timestamp: new Date().toISOString(),
  runDir,
  baselineDir,
  chart: { symbol: state.symbol, timeframe: state.resolution, entity_id: entityId },
  strategy_tester: {
    totalTrades: m.totalTrades,
    netProfit: m.netProfit,
    profitFactor: m.profitFactor,
    percentProfitable: m.percentProfitable,
  },
  baseline: baseSummary,
  prod: newSummary,
  delta: {
    trades: newSummary.n - baseSummary.n,
    net: +(newSummary.net - baseSummary.net).toFixed(2),
    wr: +(newSummary.wr - baseSummary.wr).toFixed(1),
    pf: newSummary.pf && baseSummary.pf ? +(newSummary.pf - baseSummary.pf).toFixed(2) : null,
    trades_per_day:
      baseSummary.n && newSummary.n
        ? {
            baseline: +(baseSummary.n / 15).toFixed(1),
            prod: +(newSummary.n / 15).toFixed(1),
          }
        : null,
  },
  inputs_snapshot: inputsMap,
  interpretation: [],
};

if (newSummary.wr > baseSummary.wr) comparison.interpretation.push('Higher win rate — filters removing low-edge entries.');
if (newSummary.n < baseSummary.n * 0.5) comparison.interpretation.push('Trade count cut sharply — less commission drag, less chop exposure.');
if (newSummary.pf >= baseSummary.pf) comparison.interpretation.push('Profit factor maintained or improved on quality-over-quantity.');
else comparison.interpretation.push('Profit factor lower — fewer trades; check if net/trade improved.');

const netPerTradeBase = baseSummary.n ? baseSummary.net / baseSummary.n : 0;
const netPerTradeProd = newSummary.n ? newSummary.net / newSummary.n : 0;
comparison.delta.net_per_trade = {
  baseline: +netPerTradeBase.toFixed(2),
  prod: +netPerTradeProd.toFixed(2),
  delta: +(netPerTradeProd - netPerTradeBase).toFixed(2),
};

writeFileSync(join(runDir, 'trades_with_labels.json'), JSON.stringify({ total: trades.length, trades }, null, 2));
writeFileSync(join(runDir, 'trades_with_labels.csv'), toCsv(trades));
writeFileSync(join(runDir, 'comparison_report.json'), JSON.stringify(comparison, null, 2));
writeFileSync(
  join(runDir, 'comparison_notes.md'),
  `# CR3 Prod vs Baseline Comparison

## Headline

| | Baseline (1m loose) | Prod preset (5m filtered) | Delta |
|---|---------------------|---------------------------|-------|
| Trades | ${baseSummary.n} | ${newSummary.n} | ${comparison.delta.trades} |
| Net | $${baseSummary.net} | $${newSummary.net} | $${comparison.delta.net} |
| Win rate | ${baseSummary.wr}% | ${newSummary.wr}% | ${comparison.delta.wr}pp |
| PF | ${baseSummary.pf} | ${newSummary.pf} | ${comparison.delta.pf ?? '—'} |
| Net/trade | $${comparison.delta.net_per_trade.baseline} | $${comparison.delta.net_per_trade.prod} | $${comparison.delta.net_per_trade.delta} |

## Baseline entry mix
${Object.entries(baseSummary.entry_types)
  .map(([k, v]) => `- ${k}: ${v.n} trades, $${v.pnl.toFixed(0)}`)
  .join('\n')}

## Prod entry mix
${Object.entries(newSummary.entry_types)
  .map(([k, v]) => `- ${k}: ${v.n} trades, $${v.pnl.toFixed(0)}`)
  .join('\n')}

## Prod top buckets
${newSummary.top_buckets.map((b) => `- ${b.bucket}: n=${b.n} wr=${b.wr}% $${b.pnl}`).join('\n')}

## Notes
${comparison.interpretation.map((x) => `- ${x}`).join('\n')}
`,
);

console.log(JSON.stringify(comparison, null, 2));
await disconnect().catch(() => {});
