#!/usr/bin/env node
/**
 * Export all CR3 trades from live Strategy Tester with pane snapshot from entry comments.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as data from '../src/core/data.js';
import * as ui from '../src/core/ui.js';
import { parseWickEntryComment, paneFieldsToRow } from './cr3-label-utils.mjs';

const runDir = process.argv[2] || join(process.cwd(), 'data', 'grid_runs', 'cr3_trade_review_2026-05-30T00-00-54');
mkdirSync(runDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pairOrders(orders) {
  const rounds = [];
  let open = null;
  for (const o of orders) {
    if (o.e === true) open = o;
    else if (o.e === false && open) {
      const isLong = /long/i.test(String(open.id || '')) && !/short/i.test(String(open.id || ''));
      const ep = Number(open.p);
      const xp = Number(o.p);
      const pts = isLong ? xp - ep : ep - xp;
      const pnl = o.pl ?? o.pnl ?? null;
      rounds.push({
        num: rounds.length + 1,
        side: isLong ? 'Long' : 'Short',
        entry_time: open.t ? new Date(open.t).toISOString().slice(0, 19) : '',
        exit_time: o.t ? new Date(o.t).toISOString().slice(0, 19) : '',
        entry_date: open.t ? new Date(open.t).toISOString().slice(0, 10) : '',
        entry_sig: open.c || '',
        exit_sig: o.c || '',
        entry_price: ep,
        exit_price: xp,
        pts: Math.round(pts * 100) / 100,
        pnl: pnl != null ? Number(pnl) : null,
        win: pnl != null ? Number(pnl) > 0 : pts > 0,
      });
      open = null;
    }
  }
  return rounds;
}

function classifyExit(t) {
  if (t.exit_sig === 'ADX_Block') return 'ADX_Block';
  if (t.win && Math.abs(t.pts - 40) < 2) return 'TP_40';
  if (!t.win && Math.abs(Math.abs(t.pts) - 20) < 2) return 'SL_20';
  return 'Other';
}

function toCsv(rows) {
  const headers = [
    'trade_num', 'entry_time', 'side', 'entry_sig', 'exit_sig', 'entry_price', 'exit_price',
    'pnl_usd', 'pts', 'win', 'exit_class',
    'conf', 'rsi', 'rsi_os', 'rsi_ob', 'adx', 'adx_opt', 'macd', 'drsi', 'cloud', 'vwap', 'research_bucket',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

await health.healthCheck();
await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5 }).catch(() => {});
await sleep(3000);

const ordersResp = await data.getTrades({ max_trades: 600 });
const trades = pairOrders(ordersResp.trades || []).map((t) => {
  const exit_class = classifyExit(t);
  const snap = parseWickEntryComment(t.entry_sig);
  return { ...t, exit_class, ...paneFieldsToRow(snap, t.side), label_matched: !!snap, label_source: snap ? 'entry_comment' : null, pane_label: snap };
});

writeFileSync(join(runDir, 'trades_official_parsed.json'), JSON.stringify(trades, null, 2));
writeFileSync(
  join(runDir, 'live_entry_snaps.json'),
  JSON.stringify(trades.map((t) => ({ num: t.num, entry_sig: t.entry_sig })), null, 2),
);
writeFileSync(
  join(runDir, 'trades_with_labels.json'),
  JSON.stringify({
    total: trades.length,
    with_entry_snap: trades.filter((t) => t.label_matched).length,
    trades,
  }, null, 2),
);
writeFileSync(join(runDir, 'trades_with_labels.csv'), toCsv(trades));

console.log(JSON.stringify({
  runDir,
  total: trades.length,
  with_snap: trades.filter((t) => t.label_matched).length,
  sample: trades.slice(0, 2).map((t) => ({ num: t.num, entry_sig: t.entry_sig, bucket: t.research_bucket, pnl: t.pnl })),
}, null, 2));

await disconnect().catch(() => {});
