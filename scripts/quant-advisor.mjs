#!/usr/bin/env node
/**
 * Quantitative strategy advisor: pulls chart + Strategy Tester data via `tv` CLI (same CDP connection),
 * computes trade/metrics stats, compares to prior runs on disk, prints JSON + human-readable advice.
 *
 * Prereqs: TradingView Desktop + CDP; strategy on chart; Strategy Tester has run at least once.
 *
 * Usage:
 *   node scripts/quant-advisor.mjs
 *   node scripts/quant-advisor.mjs -n 150
 *   node scripts/quant-advisor.mjs --watch 300
 *   node scripts/quant-advisor.mjs --no-memory
 *   node scripts/quant-advisor.mjs --llm              — extra stderr hint (llm_brief is always in JSON + advisor-latest.json)
 *   node scripts/quant-advisor.mjs --llm-stdout       — stdout = only llm_brief JSON (pipe / copy)
 *   node scripts/quant-advisor.mjs --out brief.json   — write payload (--llm-stdout writes llm brief)
 *
 * Env:
 *   Loads `.env.local` then `.env` from repo root if present (see `.env.example`).
 *   ADVISOR_MEMORY — path to JSONL memory file (default: data/advisor-memory.jsonl)
 *   ADVISOR_WEBHOOK_URL — POST full JSON report after each run (optional)
 *   ADVISOR_QUIET=1 — stderr only errors (for advisor UI subprocess)
 *   ADVISOR_INITIAL_CAPITAL — match strategy initial_capital for DD $ estimate from % (default 100000)
 *   ADVISOR_MAX_DD_USD — if set, DD_CAP priority when estimated tester max DD $ exceeds this
 *   ADVISOR_MIN_TRADES — warn when total trades below this (default 15; 0 = off)
 *   ADVISOR_WARN_DD_PCT — HIGH_DD_PCT when tester DD% exceeds this (default 5; 0 = off)
 *   ADVISOR_STRATEGY_SUBSTRING (or TV_STRATEGY_NAME) — override which strategy title to match; default pins Sweep Engine v2. Set to empty to disable substring filtering when you only need generic scoring.
 */

import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { loadEnvFromRoot } from './lib/load-env.mjs';
loadEnvFromRoot();

import {
  analyzeTrades,
  normalizeMetrics,
  summarizeMetrics,
  analyzeEquity,
  buildRecommendations,
  buildLlmBrief,
  chartKey,
  loadMemory,
  compareToLastMemory,
  memoryTrendForChart,
  appendMemoryRecord,
} from './lib/quant-advisor-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tv = join(root, 'src/cli/index.js');

const BUF = 50 * 1024 * 1024;

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function execTv(args) {
  return execFileSync(process.execPath, [tv, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: BUF,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`${label}: invalid JSON — ${e.message}`);
  }
}

function parseArgs(argv) {
  let watchSec = 0;
  let maxTrades = 150;
  let noMemory = false;
  let llm = false;
  let llmStdout = false;
  let outFile = '';
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--watch' && rest[i + 1]) {
      watchSec = Math.max(10, Number(rest[++i]) || 0);
      continue;
    }
    if ((a === '-n' || a === '--max-trades') && rest[i + 1]) {
      maxTrades = Math.min(200, Math.max(5, Number(rest[++i]) || 150));
      continue;
    }
    if (a === '--no-memory') {
      noMemory = true;
      continue;
    }
    if (a === '--llm') {
      llm = true;
      continue;
    }
    if (a === '--llm-stdout') {
      llm = true;
      llmStdout = true;
      continue;
    }
    if (a === '--out' && rest[i + 1]) {
      outFile = rest[++i];
      continue;
    }
  }
  const quiet = process.env.ADVISOR_QUIET === '1';
  return { watchSec, maxTrades, noMemory, llm, llmStdout, outFile, quiet };
}

async function postWebhook(url, payload) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error(`[advisor] webhook HTTP ${r.status}`);
  } catch (e) {
    console.error('[advisor] webhook failed:', e.message || e);
  }
}

function runOnce({ maxTrades, noMemory, llm, llmStdout, outFile, quiet }) {
  const memoryPath = process.env.ADVISOR_MEMORY || join(root, 'data', 'advisor-memory.jsonl');

  execTv(['status']);
  const state = parseJson(execTv(['state']), 'chart state');
  const strat = parseJson(execTv(['data', 'strategy']), 'strategy metrics');
  const tradesPayload = parseJson(execTv(['data', 'trades', '-n', String(maxTrades)]), 'trades');
  let equityPayload;
  try {
    equityPayload = parseJson(execTv(['data', 'equity']), 'equity');
  } catch {
    equityPayload = { data: [] };
  }

  const metricsRaw = strat.metrics || {};
  const metrics = normalizeMetrics(metricsRaw);
  const metricsSummary = summarizeMetrics(metrics);

  const tradeStats = analyzeTrades(tradesPayload.trades || []);
  const equityInfo = analyzeEquity(equityPayload);

  let tvStrategy = {
    strategy_name: strat.strategy_name ?? null,
    pick_note: strat.pick_note ?? null,
    candidate_count: strat.candidate_count ?? null,
  };
  const nameMetrics = strat.strategy_name;
  const nameTrades = tradesPayload.strategy_name;
  const nameEquity = equityPayload.strategy_name;
  if (nameMetrics && nameTrades && nameMetrics !== nameTrades) {
    tvStrategy.pick_note =
      (tvStrategy.pick_note ? `${tvStrategy.pick_note} ` : '') +
      '[metrics vs trades strategy name differed in one TV read — re-run once or set ADVISOR_STRATEGY_SUBSTRING.]';
  }
  if (nameMetrics && nameEquity && nameMetrics !== nameEquity) {
    tvStrategy.pick_note =
      (tvStrategy.pick_note ? `${tvStrategy.pick_note} ` : '') +
      '[metrics vs equity strategy name differed — re-run once.]';
  }

  const key = chartKey(state);
  const memoryRows = noMemory ? [] : loadMemory(memoryPath);
  const memoryDelta = compareToLastMemory(memoryRows, key, metricsSummary.netProfit);
  const memoryTrend = noMemory ? null : memoryTrendForChart(memoryRows, key);

  const rec = buildRecommendations({
    tradeStats,
    metricsSummary,
    equityInfo,
    memoryDelta,
    memoryTrend,
  });

  const record = {
    ts: new Date().toISOString(),
    chartKey: key,
    symbol: state.symbol,
    resolution: state.resolution,
    metricsSummary,
    memoryTrend: memoryTrend,
    tradeStats: {
      nWithPnl: tradeStats.nWithPnl,
      winRate: tradeStats.winRate,
      profitFactor: tradeStats.profitFactor,
      expectancy: tradeStats.expectancy,
      maxConsecLosses: tradeStats.maxConsecLosses,
      longShort: tradeStats.longShort,
    },
    equityInfo,
    codes: rec.priorities.map((p) => p.code),
    suggested_actions: rec.suggested_actions,
  };

  if (!noMemory) {
    appendMemoryRecord(memoryPath, record);
  }

  const memoryBlock = noMemory
    ? { skipped: true }
    : { path: memoryPath, delta: memoryDelta, trend: memoryTrend };

  const out = {
    success: true,
    chart: { symbol: state.symbol, resolution: state.resolution },
    tv_strategy: tvStrategy,
    metricsSummary,
    tradeStats,
    equityInfo,
    memory: memoryBlock,
    quantitative: {
      profitFactor: metricsSummary.profitFactor,
      netProfit: metricsSummary.netProfit,
      sampleExpectancy: tradeStats.expectancy,
      winRateStrategy: metricsSummary.percentProfitable,
      winRateTrades: tradeStats.winRate,
      maxStrategyDrawDownPercent: metricsSummary.maxStrategyDrawDownPercent,
      estimatedMaxDdUsd: metricsSummary.estimatedMaxDdUsd,
    },
    advisor: {
      priorities: rec.priorities,
      lines: rec.advisorLines,
      suggested_actions: rec.suggested_actions,
    },
  };

  const llmBrief = buildLlmBrief({
    chart: out.chart,
    tv_strategy: tvStrategy,
    metricsSummary,
    tradeStats,
    equityInfo,
    memory: memoryBlock,
    quantitative: out.quantitative,
    advisor: out.advisor,
  });
  out.llm_brief = llmBrief;

  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'advisor-latest.json'), JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    console.error('[advisor] could not write data/advisor-latest.json:', e.message || e);
  }

  const hook = (process.env.ADVISOR_WEBHOOK_URL || '').trim();
  if (hook) {
    void postWebhook(hook, out).catch((e) => console.error('[advisor] webhook failed:', e.message || e));
  }

  if (llmStdout && llmBrief) {
    const s = JSON.stringify(llmBrief, null, 2);
    console.log(s);
    if (outFile) {
      writeFileSync(outFile, s, 'utf8');
      if (!quiet) console.error(`[advisor] wrote LLM brief → ${outFile}`);
    }
  } else {
    console.log(JSON.stringify(out, null, 2));
    if (outFile) {
      writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
      if (!quiet) console.error(`[advisor] wrote full report → ${outFile}`);
    }
  }

  if (!quiet) {
    console.error('\n--- Advisor (quant rules) ---\n');
    for (const line of rec.advisorLines) console.error(line);
    if (llm || llmStdout) {
      console.error('\n--- LLM ---\n`llm_brief` is always included; use --llm-stdout for brief-only JSON.\n');
    }
    console.error('');
  }
}

function main() {
  const { watchSec, maxTrades, noMemory, llm, llmStdout, outFile, quiet } = parseArgs(process.argv);
  const loop = () => {
    try {
      runOnce({ maxTrades, noMemory, llm, llmStdout, outFile, quiet });
    } catch (e) {
      console.error('[advisor] error:', e.message || e);
      process.exitCode = 1;
    }
  };

  if (watchSec > 0) {
    if (llmStdout) console.error('[advisor] note: --llm-stdout with --watch prints one brief per tick.');
    console.error(`[advisor] watch every ${watchSec}s — Ctrl+C to stop. maxTrades=${maxTrades}`);
    while (true) {
      loop();
      sleepMs(watchSec * 1000);
    }
  } else {
    loop();
  }
}

main();
