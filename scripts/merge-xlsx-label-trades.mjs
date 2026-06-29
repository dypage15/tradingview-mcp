#!/usr/bin/env node
/** Merge xlsx trade times/PnL with live entry_sig pane snapshots */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseWickEntryComment, paneFieldsToRow } from './cr3-label-utils.mjs';

const xlsxPath = process.argv[2];
const runDir = process.argv[3];
if (!xlsxPath || !runDir) {
  console.error('Usage: node merge-xlsx-label-trades.mjs <xlsx> <runDir>');
  process.exit(1);
}

execFileSync(process.execPath, [join(process.cwd(), 'scripts/parse-cr3-xlsx.mjs'), xlsxPath, runDir], { stdio: 'inherit' });

const xlsxTrades = JSON.parse(readFileSync(join(runDir, 'trades_official_parsed.json'), 'utf8'));
const liveSnaps = JSON.parse(readFileSync(join(runDir, 'live_entry_snaps.json'), 'utf8'));
const liveByNum = new Map(liveSnaps.map((t) => [t.num, t]));

const merged = xlsxTrades.map((x) => {
  const live = liveByNum.get(x.num);
  const entry_sig = live?.entry_sig || x.entry_sig;
  const snap = parseWickEntryComment(entry_sig);
  return {
    ...x,
    entry_sig,
    ...paneFieldsToRow(snap, x.side),
    label_matched: !!snap,
    label_source: snap ? 'entry_comment' : null,
    pane_label: snap,
  };
});

function toCsv(rows) {
  const headers = [
    'trade_num', 'entry_time', 'exit_time', 'entry_date', 'side', 'entry_sig', 'exit_sig',
    'entry_price', 'exit_price', 'pnl_usd', 'pts', 'win', 'exit_class', 'mfe_pts', 'mae_pts',
    'conf', 'rsi', 'rsi_os', 'rsi_ob', 'adx', 'adx_opt', 'macd', 'drsi', 'cloud', 'vwap', 'research_bucket',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

writeFileSync(join(runDir, 'trades_with_labels.json'), JSON.stringify({
  total: merged.length,
  with_entry_snap: merged.filter((t) => t.label_matched).length,
  trades: merged,
}, null, 2));
writeFileSync(join(runDir, 'trades_with_labels.csv'), toCsv(merged));

console.log(JSON.stringify({
  total: merged.length,
  with_snap: merged.filter((t) => t.label_matched).length,
  csv: join(runDir, 'trades_with_labels.csv'),
}, null, 2));
