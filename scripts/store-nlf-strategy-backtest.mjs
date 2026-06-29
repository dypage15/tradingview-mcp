#!/usr/bin/env node
/**
 * Push data/erl-irl-engine-strategy.pine to the TV Pine editor, smart-compile,
 * open Strategy Tester, wait for calculation, then persist metrics + trades under
 * data/strategy_runs/<iso-timestamp>/ for A/B comparison.
 *
 * Env:
 *   ADVISOR_STRATEGY_SUBSTRING — default ERL (pins NLF vs other strategies on chart)
 *   TV_BACKTEST_SAVE_TRADES — max trades persisted (default 180)
 *   TV_STRATEGY_TESTER_WAIT_MS — base patience after Tester open (default 16000); script also staggers clicks
 *   TV_BACKTEST_SYMBOL — optional e.g. MNQ1!, CME_MINI:M2K1! applied before Pine push so Tester matches instrument
 *   TV_BACKTEST_TIMEFRAME — optional e.g. 5 / 15 (same as Chart «Interval» shortcut)
 */
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as pine from '../src/core/pine.js';
import * as data from '../src/core/data.js';
import * as ui from '../src/core/ui.js';

import * as chart from '../src/core/chart.js';
import * as captureCore from '../src/core/capture.js';

const ROOT = process.cwd();
const STRATEGY_FILE = join(ROOT, 'data', 'erl-irl-engine-strategy.pine');

if (!process.env.ADVISOR_STRATEGY_SUBSTRING) {
  process.env.ADVISOR_STRATEGY_SUBSTRING = 'ERL';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

async function main() {
  const id = runId();
  const outDir = join(ROOT, 'data', 'strategy_runs', id);
  mkdirSync(outDir, { recursive: true });

  const timeline = [];

  const push = (label, payload) => {
    timeline.push({ at: new Date().toISOString(), label, payload });
  };

  let exitCode = 0;
  try {
    copyFileSync(STRATEGY_FILE, join(outDir, 'strategy_snapshot.pine'));

    const status = await health.healthCheck();
    push('healthCheck', status);

    if (process.env.TV_BACKTEST_SYMBOL) {
      const symAck = await chart.setSymbol({ symbol: process.env.TV_BACKTEST_SYMBOL.trim() });
      push('chart_setSymbol_backtest_profile', symAck);
      await sleep(1_200);
    }
    if (process.env.TV_BACKTEST_TIMEFRAME) {
      const tfAck = await chart.setTimeframe({ timeframe: process.env.TV_BACKTEST_TIMEFRAME.trim() });
      push('chart_setTimeframe_backtest_profile', tfAck);
      await sleep(1_800);
    }

    const src = readFileSync(STRATEGY_FILE, 'utf8');
    const setAck = await pine.setSource({ source: src });
    push('pine_setSource', setAck);

    await ui.openPanel({ panel: 'pine-editor', action: 'open' });
    push('pine_panel', { performed: 'open' });

    const compileAck = await pine.smartCompile();
    push('pine_smartCompile', compileAck);

    const pineErr = await pine.getErrors();
    push('pine_errors', pineErr);

    await ui.openPanel({ panel: 'strategy-tester', action: 'open' });
    push('strategy_tester_panel', { performed: 'open' });

    const testerWaitMs = Number(process.env.TV_STRATEGY_TESTER_WAIT_MS ?? 16_000);
    const testerUpdate1 = await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 6, pause_ms: 500 });
    push('strategy_tester_click_update_early', testerUpdate1);
    await sleep(4_500);
    const testerUpdate2 = await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 4, pause_ms: 400 });
    push('strategy_tester_click_update_mid', testerUpdate2);
    await sleep(Math.max(testerWaitMs - 4_500, 8_000));
    const testerUpdate3 = await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 4, pause_ms: 400 });
    push('strategy_tester_click_update_late', testerUpdate3);

    const strat = await data.getStrategyResults();
    push('data_getStrategyResults', {
      metric_count: strat.metric_count,
      strategy_name: strat.strategy_name,
      pick_note: strat.pick_note,
      report_ready: strat.report_ready,
    });

    const maxTrades = Number(process.env.TV_BACKTEST_SAVE_TRADES ?? 180);
    const trades = await data.getTrades({ max_trades: maxTrades });
    push('data_getTrades', { trade_count: trades.trades?.length, error: trades.error });

    const chartState = await chart.getState();
    push('chart_getState', { symbol: chartState.symbol, resolution: chartState.resolution, studies: chartState.studies });

    writeFileSync(join(outDir, 'strategy_results.full.json'), JSON.stringify(strat, null, 2), 'utf8');
    writeFileSync(join(outDir, 'trades.full.json'), JSON.stringify(trades, null, 2), 'utf8');

    const m = strat.metrics || {};
    const kpis = {
      netProfitPercent: m.netProfitPercent,
      netProfit: m.netProfit,
      profitFactor: m.profitFactor,
      percentProfitable: m.percentProfitable,
      totalTrades: m.totalTrades,
      maxDrawDownPercent: m.maxDrawDownPercent,
      marginCalls: m.marginCalls,
      commissionPaid: m.commissionPaid,
    };

    const summary = {
      run_id: id,
      created_at: new Date().toISOString(),
      preset: 'research_balanced_defaults',
      preset_detail: 'Baked in strategy_snapshot.pine: minScoreCont/Rev ~72 aligned to panel HIGH band; minBarsBetween 48; NY 09:30–15:30 new entries / 16:00 flat.',
      strategy_file_snapshot: 'strategy_snapshot.pine',
      advisor_substring_used: process.env.ADVISOR_STRATEGY_SUBSTRING,
      chart: { symbol: chartState.symbol, resolution: chartState.resolution },
      pine_compile: compileAck,
      pine_errors_terminal: pineErr,
      strategy: {
        strategy_name: strat.strategy_name,
        pick_note: strat.pick_note,
        candidate_count: strat.candidate_count,
        report_ready: strat.report_ready,
        kpis,
      },
      trades_returned: trades.trades?.length ?? 0,
      notes: [
        'Compare runs by opening data/strategy_runs/*/summary.json',
        'Tighten Inputs on chart vs defaults baked into strategy_snapshot.pine.',
      ],
    };

    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    writeFileSync(join(ROOT, 'data', 'strategy_runs', '_latest_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    writeFileSync(
      join(ROOT, 'data', 'strategy_runs', '_LATEST_RUN.txt'),
      `${id}\nfolder: data/strategy_runs/${id}/\n`,
      'utf8',
    );

    const histPath = join(ROOT, 'data', 'strategy_runs', 'history.ndjson');
    const histLine = JSON.stringify({
      at: summary.created_at,
      run_id: id,
      symbol: summary.chart.symbol,
      resolution: summary.chart.resolution,
      kpis,
      trades_returned: summary.trades_returned,
      report_ready: summary.strategy.report_ready,
    });
    appendFileSync(histPath, `${histLine}\n`, 'utf8');

    try {
      const snap = await captureCore.captureScreenshot({
        region: 'strategy_tester',
        filename: `nlf_run_${id}`,
      });
      push('strategy_tester_screenshot', snap);
      if (snap.file_path && existsSync(snap.file_path)) {
        copyFileSync(snap.file_path, join(outDir, 'strategy_tester.png'));
      }
    } catch (e) {
      push('strategy_tester_screenshot', { success: false, error: String(e.message) });
    }

    writeFileSync(join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2), 'utf8');

    console.log(JSON.stringify({ success: true, out_dir: `data/strategy_runs/${id}`, summary }, null, 2));
    if ((pineErr.error_count ?? 0) > 0) exitCode = 2;
    if (!strat.report_ready) exitCode = Math.max(exitCode, 3);
  } catch (e) {
    push('fatal', { message: e.message, stack: String(e.stack) });
    writeFileSync(join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2), 'utf8');
    writeFileSync(join(outDir, 'error.json'), JSON.stringify({ message: e.message }, null, 2), 'utf8');
    console.error(JSON.stringify({ success: false, error: e.message, out_dir: `data/strategy_runs/${id}` }, null, 2));
    exitCode = 1;
  } finally {
    await disconnect().catch(() => {});
  }

  process.exit(exitCode);
}

main();
