/**
 * Parse ClReg2.2 EXECUTION DATA on-chart table (Strategy Tester fallback).
 */
export function parseExecutionTable(pineTablesResult) {
  const study = pineTablesResult?.studies?.[0];
  const table = study?.tables?.find((t) => (t.rows?.[0] || '').includes('EXECUTION DATA'));
  if (!table) return { parsed: false };

  const kv = {};
  for (const row of table.rows.slice(1)) {
    const parts = row.split(' | ').map((s) => s.trim());
    if (parts.length >= 2) kv[parts[0]] = parts[1];
  }

  const num = (s) => {
    if (s == null || s === '—' || s === '') return NaN;
    const n = parseFloat(String(s).replace(/%/g, ''));
    return Number.isFinite(n) ? n : NaN;
  };

  const sig = (kv['Signals L / S'] || '0 / 0').split('/').map((x) => parseInt(x.trim(), 10));
  const fills = (kv['Fills L / S'] || '0 / 0').split('/').map((x) => parseInt(x.trim(), 10));
  const rec = (kv['Recorded W / L'] || '0 / 0').split('/').map((x) => parseInt(x.trim(), 10));
  const flips = (kv['Flips bull / bear'] || '0 / 0').split('/').map((x) => parseInt(x.trim(), 10));

  const engineClosed = parseInt(kv['Engine closed'] || kv['Closed trades'] || '0', 10);
  const closedTrades = parseInt(kv['Closed trades'] || '0', 10);
  const recWins = rec[0] || 0;
  const recLoss = rec[1] || 0;
  const winPct = num(kv['Win %']);
  const netPts = num(kv['Net pts']);
  const pf = num(kv['Profit factor']);

  return {
    parsed: true,
    dataSource: kv['EXECUTION DATA'] || table.rows[0]?.split(' | ')[1] || 'unknown',
    signalsLong: sig[0] || 0,
    signalsShort: sig[1] || 0,
    fillsLong: fills[0] || 0,
    fillsShort: fills[1] || 0,
    closedTrades: Number.isFinite(closedTrades) ? closedTrades : engineClosed,
    engineClosed,
    recordedWins: recWins,
    recordedLosses: recLoss,
    winPct,
    netPts,
    profitFactor: pf,
    bullFlips: flips[0] || 0,
    bearFlips: flips[1] || 0,
    missedLong: parseInt((kv['Missed L / S'] || '0 / 0').split('/')[0], 10) || 0,
    missedShort: parseInt((kv['Missed L / S'] || '0 / 0').split('/')[1], 10) || 0,
  };
}

/** Parse TRADE LOG table rows from data_get_pine_tables (v2.2). */
export function parseTradeLogTable(pineTablesResult) {
  const study = pineTablesResult?.studies?.[0];
  const table = study?.tables?.find((t) => (t.rows?.[0] || '').includes('TRADE LOG'));
  if (!table) return { parsed: false, trades: [] };

  const trades = [];
  for (const row of table.rows.slice(2)) {
    if (row.includes('No closed trades') || row.includes('Log ')) continue;
    const cols = row.split(' | ').map((s) => s.trim());
    if (cols.length < 7) continue;
    trades.push({
      num: cols[0],
      side: cols[1],
      rsi: parseFloat(cols[2]),
      flip: cols[3],
      entry: parseFloat(cols[4]),
      exit: parseFloat(cols[5]),
      pts: parseFloat(cols[6]),
      result: cols[7],
      exitType: cols[8],
      bars: parseInt(cols[9], 10),
      mfeMae: cols[10],
    });
  }
  const footer = table.rows.find((r) => r.startsWith('Log '));
  return { parsed: true, trades, footer: footer || null, row_count: trades.length };
}

export function mergeMetrics(testerRow, exec) {
  if (!exec?.parsed) return testerRow;
  const trades = Math.max(testerRow.totalTrades || 0, exec.closedTrades || 0, exec.engineClosed || 0);
  const recTrades = (exec.recordedWins || 0) + (exec.recordedLosses || 0);
  const useExec = trades === 0 && recTrades > 0;
  const totalTrades = useExec ? recTrades : trades;
  const wr = useExec
    ? recTrades > 0
      ? (exec.recordedWins / recTrades) * 100
      : exec.winPct
    : testerRow.percentProfitable || exec.winPct;
  const net = testerRow.netProfit !== 0 ? testerRow.netProfit : exec.netPts;
  const pf = testerRow.profitFactor > 0 ? testerRow.profitFactor : exec.profitFactor;
  return {
    ...testerRow,
    totalTrades,
    percentProfitable: Number.isFinite(wr) ? wr : testerRow.percentProfitable,
    netProfit: Number.isFinite(net) ? net : testerRow.netProfit,
    profitFactor: Number.isFinite(pf) ? pf : testerRow.profitFactor,
    expectancy: totalTrades > 0 && Number.isFinite(net) ? net / totalTrades : testerRow.expectancy,
    execution_table: exec,
    metrics_source: useExec ? 'execution_table' : trades > 0 ? 'tester_or_engine' : 'tester_zero',
  };
}
