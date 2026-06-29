#!/usr/bin/env node
/**
 * Export CR3 Strategy Tester trades to CSV + snapshot settings + chart screenshots per trade day.
 */
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect, evaluate, KNOWN_PATHS } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as indicators from '../src/core/indicators.js';
import * as capture from '../src/core/capture.js';
import * as ui from '../src/core/ui.js';

import { parseResearchTable, pickCr3Entity } from './cr3-grid-utils.mjs';

const ROOT = process.cwd();
const CHART_API = KNOWN_PATHS.chartApi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.ADVISOR_STRATEGY_SUBSTRING = process.env.ADVISOR_STRATEGY_SUBSTRING || 'Full Stack';

const INPUT_LABELS = {
  in_0: 'htfTF',
  in_1: 'fastEmaLen',
  in_2: 'slowEmaLen',
  in_3: 'smaLen',
  in_4: 'cloudSmooth',
  in_5: 'cSlopeLen',
  in_6: 'cSteepT',
  in_7: 'macdFast',
  in_8: 'macdSlow',
  in_9: 'macdSig',
  in_10: 'proxMult',
  in_11: 'proxAtrLn',
  in_12: 'vwapTrigMode',
  in_13: 'adxLen',
  in_14: 'adxSmooth',
  in_15: 'zOptLow',
  in_16: 'zOptHigh',
  in_17: 'useDRSI',
  in_18: 'drsiRSILen',
  in_19: 'drsiWindow',
  in_20: 'drsiSigLen',
  in_21: 'drsiMode',
  in_22: 'showBB',
  in_23: 'showWicks',
  in_24: 'wickBBLen',
  in_25: 'wickBBMult',
  in_26: 'wickRSILen',
  in_27: 'rsiOversold',
  in_28: 'rsiOverbought',
  in_29: 'minWickConfDisplay',
  in_30: 'tpPoints',
  in_31: 'slPoints',
  in_32: 'useSession',
  in_33: 'sessStart',
  in_34: 'useLunchBlock',
  in_35: 'useTrendTier',
  in_36: 'useWickTier',
  in_37: 'wickMinConf',
  in_38: 'wickMaxConfLong',
  in_39: 'wickMaxConfShort',
  in_40: 'wickRequireOs',
  in_41: 'wickRequireOb',
  in_42: 'wickBlockTrendStack',
  in_43: 'applyAdxBlockToWick',
  in_44: 'showTable',
  in_45: 'enableResearch',
  in_46: 'outcomeLB',
  in_47: 'clusterBars',
  in_48: 'winThreshPts',
  in_49: 'trackMfeMae',
  in_50: 'showResearchTable',
  in_51: 'adxEntryHigh',
  in_52: 'enforce_adx',
  in_53: 'enforce_drsi',
  in_54: 'enforce_slope',
  in_55: 'enforce_session',
};

async function fetchReportTrades() {
  return evaluate(`
(function() {
  var chart = ${CHART_API}._chartWidget;
  var sources = chart.model().model().dataSources();
  var strat = null;
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    if (!s || !s.metaInfo) continue;
    var n = (s.metaInfo().description || s.metaInfo().shortDescription || '');
    if (/Full Stack|CR_v3|Cloud Regime v3/i.test(n) && !/v2\\./i.test(n)) { strat = s; break; }
  }
  if (!strat) return { trades: [], error: 'no strat' };
  var rd = strat.reportData ? (typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData) : null;
  if (rd && typeof rd.value === 'function') rd = rd.value();
  var trades = rd && rd.trades ? (typeof rd.trades.value === 'function' ? rd.trades.value() : rd.trades) : [];
  if (!Array.isArray(trades)) return { trades: [], error: 'no trades array' };
  var out = [];
  for (var t = 0; t < trades.length; t++) {
    var tr = trades[t];
    var entryTm = tr.e && tr.e.tm != null ? tr.e.tm : null;
    var exitTm = tr.x && tr.x.tm != null ? tr.x.tm : null;
    var entryPx = tr.e && tr.e.p != null ? tr.e.p : null;
    var exitPx = tr.x && tr.x.p != null ? tr.x.p : null;
    var pnl = tr.tp && tr.tp.v != null ? tr.tp.v : null;
    var qty = tr.qty && tr.qty.v != null ? tr.qty.v : 1;
    var comment = tr.c || tr.comment || '';
    var isLong = tr.e && tr.e.b != null ? tr.e.b : null;
    out.push({ i: t + 1, entryMs: entryTm, exitMs: exitTm, entryPx, exitPx, pnl, qty, comment, isLong });
  }
  return { trades: out, count: out.length };
})()
`);
}

function pairOrders(orders) {
  const rounds = [];
  let open = null;
  for (const o of orders) {
    if (o.e === true) open = o;
    else if (o.e === false && open) {
      const isLong = /long/i.test(String(open.id || '')) && !/short/i.test(String(open.id || ''));
      const pts = isLong ? Number(o.p) - Number(open.p) : Number(open.p) - Number(o.p);
      rounds.push({
        side: isLong ? 'Long' : 'Short',
        entryId: open.id,
        entryComment: open.c,
        exitComment: o.c,
        entryPrice: open.p,
        exitPrice: o.p,
        pts,
        exitType: o.tp,
      });
      open = null;
    }
  }
  return rounds;
}

function toCsv(rows, headers) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

await health.healthCheck();
await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5 }).catch(() => {});

const state = await chart.getState();
const entityId = pickCr3Entity(state);
const ind = await data.getIndicator({ entity_id: entityId });
const strat = await data.getStrategyResults();
const tables = await data.getPineTables({ study_filter: 'Full Stack' });
const research = parseResearchTable(tables);

const inputsMap = {};
for (const inp of ind.inputs || []) {
  if (inp.id?.startsWith('in_') && INPUT_LABELS[inp.id]) {
    inputsMap[INPUT_LABELS[inp.id]] = inp.value;
  }
}

const reportTrades = await fetchReportTrades();
const ordersResp = await data.getTrades({ max_trades: 600 });
const pairedFromOrders = pairOrders(ordersResp.trades || []);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = join(ROOT, 'data', 'grid_runs', `cr3_trade_review_${stamp}`);
mkdirSync(runDir, { recursive: true });
mkdirSync(join(runDir, 'screenshots'), { recursive: true });

const csvRows = (reportTrades.trades || []).map((t) => ({
  trade_num: t.i,
  entry_time: t.entryMs ? new Date(t.entryMs).toISOString() : '',
  exit_time: t.exitMs ? new Date(t.exitMs).toISOString() : '',
  entry_date: t.entryMs ? new Date(t.entryMs).toISOString().slice(0, 10) : '',
  side: t.isLong === true ? 'Long' : t.isLong === false ? 'Short' : '',
  entry_price: t.entryPx ?? '',
  exit_price: t.exitPx ?? '',
  pnl_usd: t.pnl ?? '',
  comment: t.comment ?? '',
}));

const csvPath = join(runDir, 'trades.csv');
writeFileSync(
  csvPath,
  toCsv(csvRows, [
    'trade_num',
    'entry_time',
    'exit_time',
    'entry_date',
    'side',
    'entry_price',
    'exit_price',
    'pnl_usd',
    'comment',
  ]),
);

writeFileSync(
  join(runDir, 'settings_snapshot.json'),
  JSON.stringify(
    {
      run_directory: runDir,
      timestamp: new Date().toISOString(),
      symbol: state.symbol,
      timeframe: state.resolution,
      entity_id: entityId,
      inputs: inputsMap,
      strategy_tester: strat.metrics,
      research,
      report_trade_count: reportTrades.count,
      order_pair_count: pairedFromOrders.length,
    },
    null,
    2,
  ),
);

// Exit type breakdown from orders
const exitBreakdown = {};
for (const o of ordersResp.trades || []) {
  if (o.e === false) {
    const k = o.c || o.id || 'unknown';
    exitBreakdown[k] = (exitBreakdown[k] || 0) + 1;
  }
}
const commentBreakdown = {};
for (const o of ordersResp.trades || []) {
  if (o.e === true) {
    const k = o.c || 'unknown';
    commentBreakdown[k] = (commentBreakdown[k] || 0) + 1;
  }
}

writeFileSync(
  join(runDir, 'trade_breakdown.json'),
  JSON.stringify({ entry_comments: commentBreakdown, exit_comments: exitBreakdown, paired_sample: pairedFromOrders.slice(0, 5) }, null, 2),
);

// Unique entry dates for screenshots (cap at 12 days)
const daySet = new Set(csvRows.map((r) => r.entry_date).filter(Boolean));
const days = [...daySet].sort();
const screenshotDays = days.slice(-12);

const screenshotPaths = [];
const shotDir = join(runDir, 'screenshots');
mkdirSync(shotDir, { recursive: true });
for (const day of screenshotDays) {
  await chart.scrollToDate({ date: day });
  await sleep(3000);
  const fname = `cr3_review_${stamp}_day_${day}`;
  const res = await capture.captureScreenshot({ region: 'chart', filename: fname });
  const src = res?.file_path;
  const dest = join(shotDir, `day_${day}.png`);
  if (src) copyFileSync(src, dest);
  screenshotPaths.push({ day, path: dest });
  await sleep(500);
}

writeFileSync(join(runDir, 'screenshot_manifest.json'), JSON.stringify(screenshotPaths, null, 2));

console.log(
  JSON.stringify(
    {
      runDir,
      csvPath,
      symbol: state.symbol,
      timeframe: state.resolution,
      totalTrades: strat.metrics?.totalTrades,
      netProfit: strat.metrics?.netProfit,
      inputs: inputsMap,
      entry_comments: commentBreakdown,
      exit_comments: exitBreakdown,
      screenshot_days: screenshotDays.length,
      screenshotPaths,
    },
    null,
    2,
  ),
);

await disconnect().catch(() => {});
