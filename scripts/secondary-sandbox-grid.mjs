#!/usr/bin/env node
/**
 * 100-scenario grid: Secondary strategy only — Sandbox trend filter × SL × TP.
 * - Copies Pine + strategy-property inputs from primary "Sweep Engine v2.0" onto secondary
 *   "Sweep Engine v2.0 — Secondary", shifting indices after the new sandbox input (in_61).
 * - Runs 4 × 5 × 5 = 100 combos: None | VWAP | EMA200 | VWAP+EMA200 × SL × TP (chart in_1 / in_2).
 *
 * Prereqs: TradingView Desktop + CDP; Secondary on chart. Primary Sweep v2.0 optional (syncs inputs onto Secondary when present).
 *
 * Env:
 *   TV_ENTITY_PRIMARY   — entity id of primary Sweep v2.0 (optional; auto-picks first name match)
 *   TV_ENTITY_SECONDARY — entity id of Secondary (optional; auto name includes "Secondary")
 *   GRID_DELAY_MS       — default 4500
 *   GRID_OBJECTIVE      — net | wr | pf | balanced | net_dd (same as winrate-grid)
 *   ADVISOR_STRATEGY_SUBSTRING=Secondary — exported for child data strategy reads
 *   GRID_LOG_MERGE=1    — also write data/secondary-sandbox-grid-merge-log.jsonl with { run, merged }
 *                         (full TV input map per scenario) so best rows can be replayed exactly later.
 *   GRID_MAX_TRADES_PER_DAY — default 1 (maps to Pine in_49 "Max trades / calendar day"). Set 0 to disable cap.
 */

import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tv = join(root, 'src/cli/index.js');
const BUF = 50 * 1024 * 1024;

const DELAY_MS = Number(process.env.GRID_DELAY_MS || 4500);
const OBJECTIVE = (process.env.GRID_OBJECTIVE || 'net_dd').toLowerCase();
const DD_WEIGHT = Number(process.env.GRID_DD_WEIGHT || 2);
const OUT = join(root, 'data', 'secondary-sandbox-grid-results.jsonl');
const LOG_MERGE = process.env.GRID_LOG_MERGE === '1';
const MERGE_OUT = join(root, 'data', 'secondary-sandbox-grid-merge-log.jsonl');
const MAX_TRADES_DAY = Number(process.env.GRID_MAX_TRADES_PER_DAY ?? 1);
const DESKTOP = join(os.homedir(), 'Desktop');

const MODES = ['None', 'VWAP', 'EMA200', 'VWAP+EMA200'];
const SL = [3.5, 4.0, 4.5, 5.0, 5.5];
const TP = [3.5, 4.0, 4.5, 5.0, 5.5];

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

function tvJson(args) {
  return JSON.parse(execTv(args));
}

function inputsToMap(arr) {
  const o = {};
  if (!Array.isArray(arr)) return o;
  for (const row of arr) {
    if (row && row.id && /^in_\d+$/.test(row.id)) o[row.id] = row.value;
  }
  return o;
}

function maxInIndex(map) {
  let m = -1;
  for (const k of Object.keys(map)) {
    const n = parseInt(k.replace('in_', ''), 10);
    if (!Number.isNaN(n)) m = Math.max(m, n);
  }
  return m;
}

/** Shift primary TV inputs onto secondary layout when secondary has one extra Pine input at in_61. */
function buildSyncedSecondaryBase(primaryMap, secondaryMap) {
  const pMax = maxInIndex(primaryMap);
  const out = { ...secondaryMap };
  for (let i = 0; i <= 60; i++) {
    const k = `in_${i}`;
    if (primaryMap[k] !== undefined) out[k] = primaryMap[k];
  }
  for (let i = 61; i <= pMax; i++) {
    out[`in_${i + 1}`] = primaryMap[`in_${i}`];
  }
  out.in_61 = 'None';
  return out;
}

function discoverSandboxKey(secondaryMap) {
  const modes = new Set(MODES);
  for (const [k, v] of Object.entries(secondaryMap)) {
    if (modes.has(v)) return k;
  }
  return 'in_61';
}

function extractDdPct(metrics) {
  const m = metrics || {};
  const v = m.maxStrategyDrawDownPercent ?? m.maxDrawdownPercent;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v);
  return null;
}

function estimateDdUsd(metrics) {
  const cap = 100000;
  const p = extractDdPct(metrics);
  if (p == null) return null;
  return (p / 100) * cap;
}

function scoreObjective(metrics) {
  const net = metrics.netProfit;
  const dd = metrics.maxStrategyDrawDownPercent;
  const ddNum = typeof dd === 'number' && !Number.isNaN(dd) ? Math.abs(dd) : 0;
  if (OBJECTIVE === 'net') return { score: typeof net === 'number' ? net : -1e30, key: 'net' };
  if (OBJECTIVE === 'pf') return { score: metrics.profitFactor ?? -1e30, key: 'pf' };
  if (OBJECTIVE === 'net_dd') {
    if (typeof net !== 'number') return { score: -1e30, key: 'net_dd' };
    return { score: net - DD_WEIGHT * ddNum, key: 'net_dd' };
  }
  const wr = metrics.percentProfitable;
  return { score: typeof wr === 'number' ? wr : -1e30, key: 'wr' };
}

function tryResolvePrimaryEntity() {
  const ex = (process.env.TV_ENTITY_PRIMARY || '').trim();
  if (ex) return ex;
  const st = tvJson(['state']);
  const studies = st.studies || [];
  const hit = studies.find(
    (s) =>
      /sweep engine v2\.0/i.test(s.name || '') && !/secondary/i.test(s.name || '')
  );
  return hit ? hit.id : null;
}

function resolveSecondaryEntity() {
  const ex = (process.env.TV_ENTITY_SECONDARY || '').trim();
  if (ex) return ex;
  const st = tvJson(['state']);
  const studies = st.studies || [];
  const hit = studies.find((s) => /secondary/i.test(s.name || ''));
  if (!hit) throw new Error('Secondary strategy not on chart. Add "Sweep Engine v2.0 — Secondary" from Pine, then re-run.');
  return hit.id;
}

function main() {
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(OUT, '', { flag: 'w' });
  process.env.ADVISOR_STRATEGY_SUBSTRING = 'Secondary';
  if (LOG_MERGE) {
    writeFileSync(MERGE_OUT, '', { flag: 'w' });
  }

  tvJson(['status']);
  const primaryId = tryResolvePrimaryEntity();
  const secondaryId = resolveSecondaryEntity();

  const sGet = tvJson(['indicator', 'get', secondaryId]);
  const secondaryMap = inputsToMap(sGet.inputs);

  const sandboxKey = discoverSandboxKey(secondaryMap);
  let base;
  if (primaryId) {
    const pGet = tvJson(['indicator', 'get', primaryId]);
    const primaryMap = inputsToMap(pGet.inputs);
    base = buildSyncedSecondaryBase(primaryMap, secondaryMap);
  } else {
    base = { ...secondaryMap };
    console.error(
      '[secondary-grid] primary Sweep v2.0 not on chart — using Secondary inputs as base (add primary to sync copies if needed).'
    );
  }
  const lowLoad = { in_21: true, in_20: false };
  let run = 0;
  let best = { score: -Infinity, meta: null };

  console.error(
    `[secondary-grid] primary=${primaryId || '(none)'} secondary=${secondaryId} sandboxKey=${sandboxKey} runs=${MODES.length * SL.length * TP.length} objective=${OBJECTIVE} delayMs=${DELAY_MS} maxTradesDay=${MAX_TRADES_DAY > 0 ? MAX_TRADES_DAY : 'off'}`
  );

  for (const mode of MODES) {
    for (const sl of SL) {
      for (const tp of TP) {
        run++;
        const merged = {
          ...base,
          ...lowLoad,
          in_1: sl,
          in_2: tp,
          [sandboxKey]: mode,
          ...(MAX_TRADES_DAY > 0 ? { in_49: MAX_TRADES_DAY } : {}),
        };
        const inputsJson = JSON.stringify(merged);
        if (LOG_MERGE) {
          writeFileSync(MERGE_OUT, `${JSON.stringify({ run, merged })}\n`, { flag: 'a' });
        }
        try {
          execTv(['indicator', 'set', secondaryId, '-i', inputsJson]);
        } catch (e) {
          console.error(JSON.stringify({ run, error: 'indicator set', message: e.message }));
          sleepMs(8000);
          continue;
        }
        sleepMs(DELAY_MS);

        let data;
        try {
          data = JSON.parse(execTv(['data', 'strategy']));
        } catch (e) {
          console.error(JSON.stringify({ run, error: 'data strategy', message: e.message }));
          sleepMs(8000);
          continue;
        }
        const metrics = data.metrics || {};
        const { score, key } = scoreObjective(metrics);
        const line = {
          run,
          mode,
          sl,
          tp,
          sandboxKey,
          score,
          key,
          objective: OBJECTIVE,
          netProfit: metrics.netProfit,
          profitFactor: metrics.profitFactor,
          percentProfitable: metrics.percentProfitable,
          totalTrades: metrics.totalTrades,
          maxStrategyDrawDownPercent: metrics.maxStrategyDrawDownPercent,
          dd_usd_est: estimateDdUsd(metrics),
          strategy_name: data.strategy_name,
          maxTradesPerDay: MAX_TRADES_DAY > 0 ? MAX_TRADES_DAY : 0,
        };
        console.log(JSON.stringify(line));
        writeFileSync(OUT, `${JSON.stringify(line)}\n`, { flag: 'a' });
        if (score > best.score) best = { score, meta: line };
      }
    }
  }

  console.error(`[secondary-grid] done. Best (${OBJECTIVE}):`, JSON.stringify(best.meta, null, 2));
  console.error(`[secondary-grid] log: ${OUT}`);
  try {
    const deskCopy = join(DESKTOP, 'secondary-sandbox-grid-results.jsonl');
    copyFileSync(OUT, deskCopy);
    writeFileSync(
      join(DESKTOP, 'secondary-sandbox-grid-best.json'),
      JSON.stringify({ exported_at: new Date().toISOString(), objective: OBJECTIVE, best: best.meta }, null, 2),
      'utf8'
    );
    console.error(`[secondary-grid] copied results → ${deskCopy} + secondary-sandbox-grid-best.json`);
  } catch (e) {
    console.error('[secondary-grid] desktop copy skipped:', e.message);
  }
  if (LOG_MERGE) {
    console.error(`[secondary-grid] full merge log: ${MERGE_OUT}`);
  }
}

main();
