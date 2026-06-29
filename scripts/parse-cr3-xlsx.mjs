#!/usr/bin/env node
/**
 * Parse TradingView strategy xlsx export and write analysis JSON.
 * Usage: node parse-cr3-xlsx.mjs <xlsxPath> [outDir]
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const xlsxPath = process.argv[2];
const outDir = process.argv[3] || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'grid_runs', 'cr3_trade_review_2026-05-30T00-00-54');

if (!xlsxPath) {
  console.error('Usage: node parse-cr3-xlsx.mjs <xlsxPath> [outDir]');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(xlsxPath, join(outDir, 'CR_v3_official_export.xlsx'));

const py = `
import zipfile, xml.etree.ElementTree as ET, json, sys
from collections import defaultdict
from datetime import datetime, timedelta

path = sys.argv[1]
out_dir = sys.argv[2]
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ns = {'m': NS}

def cell_value(c, strings):
    t = c.get('t')
    v = c.find('m:v', ns)
    if v is None: return ''
    val = v.text or ''
    if t == 's': return strings[int(val)] if strings else val
    return val

def read_sheet(z, name, strings):
    root = ET.fromstring(z.read(name))
    rows = []
    for row in root.findall('.//m:sheetData/m:row', ns):
        cells = {}
        for c in row.findall('m:c', ns):
            ref = c.get('r','')
            col = ''.join(ch for ch in ref if ch.isalpha())
            cells[col] = cell_value(c, strings)
        if cells:
            rows.append(cells)
    return rows

def excel_serial_to_iso(serial):
    try:
        base = datetime(1899, 12, 30)
        dt = base + timedelta(days=float(serial))
        return dt.strftime('%Y-%m-%dT%H:%M:%S')
    except Exception:
        return str(serial)

with zipfile.ZipFile(path) as z:
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    sheets = [(s.get('name'), s.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')) for s in wb.findall('m:sheets/m:sheet', ns)]
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rid_map = {r.get('Id'): r.get('Target') for r in rels}
    strings = []
    sheet_data = {}
    for sname, rid in sheets:
        target = 'xl/' + rid_map[rid].lstrip('/')
        sheet_data[sname] = read_sheet(z, target, strings)

props = {}
for row in sheet_data['Properties'][1:]:
    k = row.get('A','')
    v = row.get('B','')
    if k: props[k] = v

by_num = defaultdict(list)
for r in sheet_data['Trades'][1:]:
    by_num[r.get('A','')].append(r)

trades = []
for num, rows in sorted(by_num.items(), key=lambda x: int(x[0])):
    entry = next((r for r in rows if 'Entry' in r.get('B','')), None)
    exit_ = next((r for r in rows if 'Exit' in r.get('B','')), None)
    if not entry or not exit_:
        continue
    side = 'Long' if 'long' in entry['B'].lower() else 'Short'
    entry_dt = excel_serial_to_iso(entry.get('C',''))
    exit_dt = excel_serial_to_iso(exit_.get('C',''))
    pnl = float(exit_.get('H','0') or 0)
    mfe = float(exit_.get('J','0') or 0)
    mae = float(exit_.get('L','0') or 0)
    ep = float(entry.get('E','0') or 0)
    xp = float(exit_.get('E','0') or 0)
    pts = (xp - ep) if side == 'Long' else (ep - xp)
    exit_sig = exit_.get('D','')
    t = {
        'num': int(num), 'side': side, 'entry_time': entry_dt, 'exit_time': exit_dt,
        'entry_date': entry_dt[:10], 'entry_sig': entry.get('D',''), 'exit_sig': exit_sig,
        'entry_price': ep, 'exit_price': xp, 'pts': round(pts, 2), 'pnl': pnl,
        'mfe_usd': mfe, 'mae_usd': mae, 'mfe_pts': round(mfe/2, 2), 'mae_pts': round(abs(mae)/2, 2),
        'win': pnl > 0,
    }
    if exit_sig == 'ADX_Block':
        t['exit_class'] = 'ADX_Block'
    elif t['win'] and abs(t['pts'] - 40) < 2:
        t['exit_class'] = 'TP_40'
    elif not t['win'] and abs(abs(t['pts']) - 20) < 2:
        t['exit_class'] = 'SL_20'
    else:
        t['exit_class'] = 'Other'
    trades.append(t)

def agg(items, key_fn):
    g = defaultdict(lambda: {'n':0,'w':0,'pnl':0,'mfe':0,'mae':0})
    for t in items:
        k = key_fn(t)
        g[k]['n'] += 1
        g[k]['pnl'] += t['pnl']
        g[k]['mfe'] += t['mfe_pts']
        g[k]['mae'] += t['mae_pts']
        if t['win']: g[k]['w'] += 1
    out = {}
    for k,v in sorted(g.items(), key=lambda x: (-x[1]['n'], x[0])):
        n = v['n']
        out[str(k)] = {**v, 'wr': round(100*v['w']/n,1), 'avg_pnl': round(v['pnl']/n,2),
                       'avg_mfe': round(v['mfe']/n,1), 'avg_mae': round(v['mae']/n,1)}
    return out

def hour_et(iso):
    h = int(iso[11:13])
    m = int(iso[14:16])
    return h + m/60

adx = [t for t in trades if t['exit_sig']=='ADX_Block']
rth = [t for t in trades if 9.5 <= hour_et(t['entry_time']) < 16]
oth = [t for t in trades if t not in rth]

report = {
    'source': path,
    'total_trades': len(trades),
    'net_pnl': round(sum(t['pnl'] for t in trades), 2),
    'by_side': agg(trades, lambda t: t['side']),
    'by_entry_signal': agg(trades, lambda t: t['entry_sig']),
    'by_exit_signal': agg(trades, lambda t: t['exit_sig']),
    'by_exit_class': agg(trades, lambda t: t['exit_class']),
    'by_day': agg(trades, lambda t: t['entry_date']),
    'by_hour': agg(trades, lambda t: iso[11:13] if (iso := t['entry_time']) else '?'),
    'adx_block': {
        'n': len(adx), 'wins': sum(1 for t in adx if t['win']),
        'pnl': round(sum(t['pnl'] for t in adx), 2),
        'avg_pnl': round(sum(t['pnl'] for t in adx)/len(adx), 2) if adx else 0,
        'avg_mfe': round(sum(t['mfe_pts'] for t in adx)/len(adx), 1) if adx else 0,
    },
    'tp_sl_counts': {
        'tp_40pt': sum(1 for t in trades if t['exit_class']=='TP_40'),
        'sl_20pt': sum(1 for t in trades if t['exit_class']=='SL_20'),
        'adx_block': len(adx),
        'other': sum(1 for t in trades if t['exit_class']=='Other'),
    },
    'other_exits_pnl': round(sum(t['pnl'] for t in trades if t['exit_class']=='Other'), 2),
    'rth_vs_other': {
        'rth_0930_1600': {'n': len(rth), 'pnl': round(sum(t['pnl'] for t in rth),2), 'wr': round(100*sum(1 for t in rth if t['win'])/len(rth),1) if rth else 0},
        'outside_rth': {'n': len(oth), 'pnl': round(sum(t['pnl'] for t in oth),2), 'wr': round(100*sum(1 for t in oth if t['win'])/len(oth),1) if oth else 0},
    },
    'properties': props,
    'performance_match': {
        'net_profit_sheet': props.get('Net profit') or sheet_data['Performance'][3].get('B'),
    },
}

import os
with open(os.path.join(out_dir, 'trades_official_parsed.json'), 'w') as f:
    json.dump(trades, f, indent=2)
with open(os.path.join(out_dir, 'xlsx_analysis.json'), 'w') as f:
    json.dump(report, f, indent=2)
print(json.dumps(report, indent=2))
`;

const result = execFileSync('python', ['-c', py, xlsxPath, outDir], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

import { parseWickEntryComment, paneFieldsToRow } from './cr3-label-utils.mjs';

const trades = JSON.parse(readFileSync(join(outDir, 'trades_official_parsed.json'), 'utf8'));
const enriched = trades.map((t) => {
  const fromComment = parseWickEntryComment(t.entry_sig);
  const fields = fromComment ? paneFieldsToRow(fromComment, t.side) : {};
  return {
    ...t,
    label_matched: !!fromComment,
    label_source: fromComment ? 'entry_comment' : null,
    pane_label: fromComment,
    ...fields,
  };
});
const withSnap = enriched.filter((t) => t.label_source === 'entry_comment').length;
writeFileSync(
  join(outDir, 'trades_with_labels.json'),
  JSON.stringify({ total: enriched.length, with_entry_snap: withSnap, trades: enriched }, null, 2),
);

console.log(result);
console.log(JSON.stringify({ label_enrich: { total: enriched.length, with_entry_snap: withSnap, note: withSnap === 0 ? 'Re-export xlsx after pine push for pane snapshots in Signal column' : 'ok' } }, null, 2));
