#!/usr/bin/env node
/**
 * Enrich CR3 trades with pane wick label data (confluence, RSI, ADX, etc.)
 * Matches Strategy Tester / xlsx trades to label.new graphics on the chart.
 *
 * Usage:
 *   node scripts/run-cr3-trade-label-enrich.mjs [runDir]
 *
 * Reads trades_official_parsed.json from runDir (or latest cr3_trade_review_*).
 * Writes trades_with_labels.json + trades_with_labels.csv
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect, evaluate, KNOWN_PATHS } from '../src/connection.js';
import * as health from '../src/core/health.js';

const CHART_API = KNOWN_PATHS.chartApi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

import {
  parseWickEntryComment,
  parseWickPaneLabel,
  paneFieldsToRow,
  researchBucket,
} from './cr3-label-utils.mjs';

async function fetchAllWickLabels() {
  return evaluate(`
(function() {
  var chart = ${CHART_API}._chartWidget;
  var model = chart.model();
  var sources = model.model().dataSources();
  var bars = null;
  try { bars = model.mainSeries().bars(); } catch(e) {}
  function barTimeMs(x) {
    if (!bars || x == null) return null;
    try {
      var v = bars.valueAt(x);
      if (!v || v[0] == null) return null;
      var t = v[0];
      return t > 1e12 ? t : t * 1000;
    } catch(e) { return null; }
  }
  var labels = [];
  for (var si = 0; si < sources.length; si++) {
    var s = sources[si];
    if (!s.metaInfo) continue;
    var name = s.metaInfo().description || s.metaInfo().shortDescription || '';
    if (name.indexOf('Full Stack') === -1 && name.indexOf('CR_v3') === -1) continue;
    var g = s._graphics && s._graphics._primitivesCollection;
    if (!g || !g.dwglabels) continue;
    var inner = g.dwglabels.get('labels');
    if (!inner) continue;
    var coll = inner.get(false);
    if (!coll || !coll._primitivesDataById) continue;
    coll._primitivesDataById.forEach(function(v, id) {
      var t = v.t || '';
      if (!/WICK/i.test(t)) return;
      labels.push({
        id: String(id),
        bar_index: v.x,
        price: v.y != null ? Math.round(v.y * 100) / 100 : null,
        time_ms: barTimeMs(v.x),
        text: t,
        study: name
      });
    });
  }
  labels.sort(function(a,b) { return (a.time_ms||0) - (b.time_ms||0); });
  return { count: labels.length, labels: labels };
})()
`);
}

function findRunDir(arg) {
  if (arg) return arg;
  const base = join(process.cwd(), 'data', 'grid_runs');
  const dirs = readdirSync(base)
    .filter((d) => d.startsWith('cr3_trade_review_'))
    .map((d) => join(base, d))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
  if (!dirs.length) throw new Error('No cr3_trade_review_* folder found');
  return dirs[0];
}

function parseEntryMs(iso) {
  // xlsx times are chart-local (ET for MNQ RTH exports)
  return new Date(iso.replace('T', ' ') + ' GMT-0400').getTime();
}

function matchTradeToLabel(trade, labels) {
  const want = trade.side === 'Long' ? 'LOWER' : 'UPPER';
  const entryMs = parseEntryMs(trade.entry_time);
  const entryPx = trade.entry_price;
  const candidates = labels.filter((l) => {
    const p = parseWickPaneLabel(l.text);
    if (!p || p.wick_type !== want) return false;
    if (l.time_ms != null && Math.abs(l.time_ms - entryMs) > 120000) return false;
    if (l.price != null && Math.abs(l.price - entryPx) > 15) return false;
    return true;
  });
  if (!candidates.length) {
    // relax time — price-only match within 5 pts
    const byPrice = labels.filter((l) => {
      const p = parseWickPaneLabel(l.text);
      return p && p.wick_type === want && l.price != null && Math.abs(l.price - entryPx) <= 5;
    });
    if (byPrice.length === 1) candidates.push(...byPrice);
    else if (byPrice.length > 1) {
      byPrice.sort((a, b) => Math.abs(a.price - entryPx) - Math.abs(b.price - entryPx));
      candidates.push(byPrice[0]);
    }
  }
  if (!candidates.length) return { matched: false, label: null, parsed: null };
  candidates.sort((a, b) => {
    const score = (l) => {
      let s = 0;
      if (l.time_ms != null) s += Math.abs(l.time_ms - entryMs) / 1000;
      if (l.price != null) s += Math.abs(l.price - entryPx) * 10;
      return s;
    };
    return score(a) - score(b);
  });
  const best = candidates[0];
  const parsed = parseWickPaneLabel(best.text);
  return { matched: true, label: best, parsed, match_candidates: candidates.length, source: 'pane_label' };
}

function enrichTrade(trade, labels) {
  const fromComment = parseWickEntryComment(trade.entry_sig);
  if (fromComment) {
    return {
      label_matched: true,
      label_source: 'entry_comment',
      pane_label: fromComment,
      ...paneFieldsToRow(fromComment, trade.side),
    };
  }
  const m = matchTradeToLabel(trade, labels);
  const p = m.parsed;
  return {
    label_matched: m.matched,
    label_source: m.matched ? 'pane_label' : null,
    label_bar_index: m.label?.bar_index ?? null,
    label_price: m.label?.price ?? null,
    label_time_ms: m.label?.time_ms ?? null,
    pane_label: p,
    ...paneFieldsToRow(p, trade.side),
  };
}

function toCsv(rows) {
  const headers = [
    'trade_num', 'entry_time', 'side', 'entry_sig', 'exit_sig', 'entry_price', 'exit_price',
    'pnl_usd', 'pts', 'win', 'exit_class',
    'wick_type', 'conf', 'rsi', 'rsi_os', 'rsi_ob', 'adx', 'adx_opt', 'macd', 'drsi',
    'cloud', 'vwap', 'label_matched', 'label_source', 'research_bucket',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

const runDir = findRunDir(process.argv[2]);
const tradesPath = join(runDir, 'trades_official_parsed.json');
const trades = JSON.parse(readFileSync(tradesPath, 'utf8'));

await health.healthCheck();
await sleep(1000);

const raw = await fetchAllWickLabels();
const labels = raw?.labels || [];
console.error(`[labels] fetched ${labels.length} wick pane labels from chart`);

const enriched = trades.map((t) => ({
  ...t,
  ...enrichTrade(t, labels),
}));

const matched = enriched.filter((t) => t.label_matched).length;
const bySource = enriched.reduce((acc, t) => {
  const k = t.label_source || 'none';
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});
const outJson = join(runDir, 'trades_with_labels.json');
const outCsv = join(runDir, 'trades_with_labels.csv');
writeFileSync(outJson, JSON.stringify({ label_count: labels.length, matched, bySource, total: trades.length, trades: enriched }, null, 2));
writeFileSync(outCsv, toCsv(enriched));

console.log(
  JSON.stringify(
    {
      runDir,
      wick_labels_on_chart: labels.length,
      trades: trades.length,
      matched,
      unmatched: trades.length - matched,
      bySource,
      outJson,
      outCsv,
      sample_matched: enriched.filter((t) => t.label_matched).slice(0, 3).map((t) => ({
        num: t.num,
        entry_time: t.entry_time,
        conf: t.conf,
        rsi: t.rsi,
        adx: t.adx,
        bucket: t.research_bucket,
        pnl: t.pnl,
      })),
    },
    null,
    2,
  ),
);

await disconnect().catch(() => {});
