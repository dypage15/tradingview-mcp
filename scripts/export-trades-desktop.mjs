#!/usr/bin/env node
/**
 * Pull Strategy Tester trades for Sv2 2nd (Secondary) via CDP and save JSON + CSV on Desktop.
 * Prereq: TradingView + chart with Secondary strategy; CDP on 9222.
 *
 * Env: ADVISOR_STRATEGY_SUBSTRING / TV_STRATEGY_NAME (default handled in data.js = Secondary)
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { getTrades, getStrategyResults } from '../src/core/data.js';
import { disconnect } from '../src/connection.js';

process.env.ADVISOR_STRATEGY_SUBSTRING = process.env.ADVISOR_STRATEGY_SUBSTRING || 'Secondary';

const desk = join(os.homedir(), 'Desktop');
const base = 'sv2-2nd-trades';

const results = await getStrategyResults();
const trades = await getTrades({ max_trades: Number(process.env.TV_MAX_TRADES_EXPORT || 500) });

const payload = {
  exported_at: new Date().toISOString(),
  strategy_name: trades.strategy_name,
  pick_note: trades.pick_note,
  strategy_results: {
    metric_count: results.metric_count,
    metrics: results.metrics,
    hint: results.hint,
    report_ready: results.report_ready,
  },
  trade_count: trades.trade_count,
  trades: trades.trades,
  error: trades.error,
};

writeFileSync(join(desk, `${base}.json`), JSON.stringify(payload, null, 2), 'utf8');

const headers = ['buy', 'comment', 'executed', 'order_id', 'price', 'qty', 'seq', 'order_type'];
const lines = [headers.join(',')];
for (const t of trades.trades || []) {
  const row = [t.b, t.c, t.e, t.id, t.p, t.q, t.tm, t.tp].map((x) => {
    if (x === null || x === undefined) return '';
    const s = String(x);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  });
  lines.push(row.join(','));
}
writeFileSync(join(desk, `${base}.csv`), lines.join('\n'), 'utf8');

console.log(`Wrote ${trades.trade_count} trade rows → ${join(desk, base + '.{json,csv}')}`);
await disconnect();
