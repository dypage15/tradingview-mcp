#!/usr/bin/env node
/**
 * Export ClReg2.2 on-chart trade log + execution summary to data/trade_logs/.
 * Requires TradingView Desktop + CDP. Run after Update on chart.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect } from '../src/connection.js';
import * as data from '../src/core/data.js';
import { parseExecutionTable, parseTradeLogTable } from './clreg22-grid-utils.mjs';

const ROOT = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(ROOT, 'data', 'trade_logs');
mkdirSync(outDir, { recursive: true });

const tbl = await data.getPineTables({ study_filter: 'v2.2' });
const exec = parseExecutionTable(tbl);
const log = parseTradeLogTable(tbl);

process.env.ADVISOR_STRATEGY_SUBSTRING = 'v2.2';
const strat = await data.getStrategyResults();

const payload = {
  exported_at: new Date().toISOString(),
  strategy_name: strat.strategy_name,
  tester: {
    totalTrades: strat.metrics?.totalTrades,
    netProfit: strat.metrics?.netProfit,
    profitFactor: strat.metrics?.profitFactor,
    percentProfitable: strat.metrics?.percentProfitable,
  },
  execution_summary: exec,
  trade_log_visible: log,
  raw_tables: tbl.studies?.[0]?.tables?.map((t) => t.rows) ?? [],
};

const outPath = join(outDir, `clreg22_trade_log_${stamp}.json`);
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log('Wrote', outPath);
console.log('Visible log rows:', log.row_count, '| Stored (footer):', log.footer);
await disconnect().catch(() => {});
