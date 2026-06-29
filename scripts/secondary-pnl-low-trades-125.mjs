#!/usr/bin/env node
/**
 * 125 scenarios on a Sweep Engine strategy (default: v2.2): seek strong net P&L with fewer intraday entries.
 *
 * Axes (5×5×5 = 125), holding SL=4, TP=4, and Sandbox=None when a Secondary-style sandbox input exists:
 *   - Max trades / calendar day: 0 (off), 1, 2, 3, 4
 *   - Cooldown (bars): 8, 12, 16, 20, 24
 *   - Confluence proximity (× ATR): 1.0, 1.25, 1.5, 1.75, 2.0  (tighter = harder confluence = usually fewer signals)
 *
 * Base inputs: sync from a non-Secondary Sweep v2.x study onto the target when both exist; otherwise
 * uses the target study’s current inputs (typical for a single v2.2 strategy on chart).
 *
 * Prereqs: TV Desktop + CDP; target strategy on chart.
 *
 * Env:
 *   TV_GRID_STRATEGY_SUBSTRING — case-insensitive name match (default: v2.2). Use "Secondary" for v2.0 Secondary only.
 *   TV_GRID_ENTITY / TV_ENTITY_SECONDARY — optional explicit study entity id
 *   (This script sets ADVISOR_STRATEGY_SUBSTRING for `data strategy` to the same match — it does not read that env for picking the study, so a global .env "Secondary" cannot override the default v2.2.)
 *   GRID_DELAY_MS — ms after each indicator set (default 4500)
 *   PNL_TRADE_PENALTY — score = netProfit - penalty * totalTrades for "adjusted" ranking (default 35)
 *   BASELINE_NET — optional, for stderr diagnosis vs your reference (e.g. 7534)
 *   BASELINE_TRADES — optional (e.g. 43)
 *   TV_ENTITY_PRIMARY — optional primary id for sync
 *   OUT — JSONL path (default includes substring slug under data/)
 *   GRID_RESUME=1 — do not truncate OUT; skip combos already present (same maxTradesDay, cooldown, confProx)
 */
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tv = join(root, 'src/cli/index.js');
const BUF = 50 * 1024 * 1024;

const DELAY_MS = Number(process.env.GRID_DELAY_MS || 4500);
const TRADE_PEN = Number(process.env.PNL_TRADE_PENALTY || 35);
const BASELINE_NET = Number(process.env.BASELINE_NET || 7534);
const BASELINE_TRADES = Number(process.env.BASELINE_TRADES || 43);
const GRID_RESUME = process.env.GRID_RESUME === '1';

/** Pins Strategy Tester read + study name search (default targets Sweep Engine v2.2). */
const STRATEGY_SUB = ((process.env.TV_GRID_STRATEGY_SUBSTRING || '').trim() || 'v2.2').trim();

const OUT_SLUG = STRATEGY_SUB.replace(/[^a-zA-Z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
const OUT = resolve(
  process.env.OUT || join(root, 'data', `sweep-pnl-low-trades-125-${OUT_SLUG}.jsonl`)
);

if (!STRATEGY_SUB) {
  throw new Error('TV_GRID_STRATEGY_SUBSTRING (or ADVISOR_STRATEGY_SUBSTRING) must be non-empty.');
}

const MODES = new Set(['None', 'VWAP', 'EMA200', 'VWAP+EMA200']);
const ROUND = new Set([50, 100, 250, 500]);

const MAX_TRADES_DAY = [0, 1, 2, 3, 4];
const COOLDOWN = [8, 12, 16, 20, 24];
const CONF_PROX = [1.0, 1.25, 1.5, 1.75, 2.0];

const LOW_LOAD = { in_21: true, in_20: false };
const ANCHOR_SL = 4;
const ANCHOR_TP = 4;
const ANCHOR_SANDBOX = 'None';

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

function buildSyncedSecondaryBase(primaryMap, secondaryMap, sandboxKey) {
  const pMax = maxInIndex(primaryMap);
  const out = { ...secondaryMap };
  for (let i = 0; i <= 60; i++) {
    const k = `in_${i}`;
    if (primaryMap[k] !== undefined) out[k] = primaryMap[k];
  }
  for (let i = 61; i <= pMax; i++) {
    out[`in_${i + 1}`] = primaryMap[`in_${i}`];
  }
  if (sandboxKey) {
    out[sandboxKey] = ANCHOR_SANDBOX;
  }
  return out;
}

function discoverSandboxKey(secondaryMap) {
  for (const [k, v] of Object.entries(secondaryMap)) {
    if (MODES.has(v)) return k;
  }
  return null;
}

function sortedInInputs(inputs) {
  return (inputs || [])
    .filter((i) => i && /^in_\d+$/.test(i.id))
    .sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
}

/** ATR int, SL float, TP float, cooldown int, minConf int, minAtr float */
function discoverSignalKeys(arr) {
  for (let i = 0; i <= arr.length - 6; i++) {
    const vals = [0, 1, 2, 3, 4, 5].map((k) => arr[i + k]?.value);
    if (!Number.isInteger(vals[0]) || vals[0] < 5 || vals[0] > 35) continue;
    if (typeof vals[1] !== 'number' || vals[1] < 2 || vals[1] > 12) continue;
    if (typeof vals[2] !== 'number' || vals[2] < 2 || vals[2] > 12) continue;
    if (!Number.isInteger(vals[3]) || vals[3] < 1 || vals[3] > 50) continue;
    if (!Number.isInteger(vals[4]) || vals[4] < 0 || vals[4] > 3) continue;
    if (typeof vals[5] !== 'number' || vals[5] < 0 || vals[5] > 300) continue;
    return {
      sl: arr[i + 1].id,
      tp: arr[i + 2].id,
      cooldown: arr[i + 3].id,
      minConf: arr[i + 4].id,
      minAtr: arr[i + 5].id,
    };
  }
  return null;
}

/** Volume mult ~1.12 then max trades/day int then bool (plot model) */
function discoverMaxTradesKey(arr) {
  for (let i = 0; i < arr.length - 2; i++) {
    const a = arr[i].value;
    const b = arr[i + 1].value;
    const c = arr[i + 2]?.value;
    if (typeof a !== 'number' || a < 1.04 || a > 1.4) continue;
    if (!Number.isInteger(b) || b < 0 || b > 50) continue;
    if (typeof c !== 'boolean') continue;
    return arr[i + 1].id;
  }
  return null;
}

function discoverConfProxKey(arr) {
  for (let i = 0; i < arr.length - 1; i++) {
    if (!ROUND.has(arr[i].value)) continue;
    const v = arr[i + 1].value;
    if (typeof v === 'number' && v >= 0.25 && v <= 5) return arr[i + 1].id;
  }
  return null;
}

function tryResolvePrimaryEntity(gridEntityId) {
  const ex = (process.env.TV_ENTITY_PRIMARY || '').trim();
  if (ex) return ex;
  const st = tvJson(['state']);
  const hit = (st.studies || []).find(
    (s) =>
      s.id !== gridEntityId &&
      /sweep engine v2/i.test(s.name || '') &&
      !/secondary/i.test(s.name || '')
  );
  return hit ? hit.id : null;
}

function resolveGridTargetEntity() {
  const ex = (
    process.env.TV_GRID_ENTITY ||
    process.env.TV_ENTITY_SECONDARY ||
    ''
  ).trim();
  if (ex) return ex;
  if (!STRATEGY_SUB) {
    throw new Error('Set TV_GRID_STRATEGY_SUBSTRING (e.g. v2.2) or TV_GRID_ENTITY.');
  }
  const st = tvJson(['state']);
  const sub = STRATEGY_SUB.toLowerCase();
  const hit = (st.studies || []).find((s) => (s.name || '').toLowerCase().includes(sub));
  if (!hit) {
    throw new Error(
      `No study name contains "${STRATEGY_SUB}". Set TV_GRID_ENTITY to the study id, or fix TV_GRID_STRATEGY_SUBSTRING.`
    );
  }
  return hit.id;
}

function printDiscoveryFailure(inputs) {
  const arr = sortedInInputs(inputs).slice(0, 40);
  console.error('[125] First in_* inputs (id → value):');
  for (const x of arr) {
    console.error(`  ${x.id} → ${JSON.stringify(x.value)}`);
  }
}

function diagnose(bestNet, bestPen, bestLow, rows) {
  const lines = [];
  lines.push('--- Post-run diagnosis (factual) ---');
  if (typeof bestNet?.netProfit === 'number' && BASELINE_NET > 0) {
    const gap = bestNet.netProfit - BASELINE_NET;
    lines.push(
      `Best raw netProfit in this grid: ${bestNet.netProfit.toFixed(2)} vs baseline ~${BASELINE_NET} (${gap >= 0 ? '+' : ''}${gap.toFixed(2)}).`
    );
  }
  if (bestLow && typeof bestLow.netProfit === 'number') {
    lines.push(
      `Best net among runs with totalTrades <= ${Math.floor(BASELINE_TRADES * 0.81)} (~20% fewer than baseline ${BASELINE_TRADES}): net=${bestLow.netProfit.toFixed(2)}, trades=${bestLow.totalTrades}, maxTradesDay=${bestLow.maxTradesDay}, cooldown=${bestLow.cooldown}, confProx=${bestLow.confProx}.`
    );
  }
  lines.push(
    'Why stricter settings often reduce $ P&L: max trades/day is a hard cap—on volatile session days profitable follow-ups are skipped; higher cooldown blocks clustered mean-reversion entries that the original curve relied on; tighter confluence proximity requires price closer to levels, so fewer sweeps reach min confluence and trade count drops along with gross profit.'
  );
  lines.push(
    'If adjusted score (net − penalty×trades) peaks at low trade count but raw net lags baseline, you are trading dollars for turnover—raise PNL_TRADE_PENALTY to lean harder on fewer trades, or relax one axis (e.g. confProx 2.0 only) and re-run a smaller grid.'
  );
  const withCap = rows.filter((r) => r.maxTradesDay > 0);
  if (withCap.length && bestNet && withCap.every((r) => r.netProfit < (bestNet.netProfit || 0))) {
    lines.push('Note: in this run, any maxTradesDay>0 capped net vs the best unconstrained combo—expected when winners cluster on the same calendar day.');
  }
  for (const L of lines) console.error(`[125] ${L}`);
}

function main() {
  mkdirSync(join(root, 'data'), { recursive: true });
  process.env.ADVISOR_STRATEGY_SUBSTRING = STRATEGY_SUB;

  try {
    tvJson(['status']);
  } catch (e) {
    console.error('[125] TradingView unreachable (CDP). Start TV Desktop with debugging on 9222.');
    process.exit(2);
  }

  try {
    execTv(['ui', 'panel', 'strategy-tester', 'open']);
  } catch {
    /* optional */
  }

  const gridId = resolveGridTargetEntity();
  const sGet = tvJson(['indicator', 'get', gridId]);
  const secondaryMap = inputsToMap(sGet.inputs);
  const sandboxKey = discoverSandboxKey(secondaryMap);

  const primaryId = tryResolvePrimaryEntity(gridId);
  let base;
  if (primaryId) {
    const pGet = tvJson(['indicator', 'get', primaryId]);
    const primaryMap = inputsToMap(pGet.inputs);
    base = buildSyncedSecondaryBase(primaryMap, secondaryMap, sandboxKey);
    console.error(`[125] Using synced base from primary=${primaryId}`);
  } else {
    base = { ...secondaryMap };
    console.error('[125] No other Sweep v2 primary on chart — using target study inputs as base (no sync).');
  }

  const arr = sortedInInputs(sGet.inputs);
  const sig = discoverSignalKeys(arr);
  const maxDayId = discoverMaxTradesKey(arr);
  const confId = discoverConfProxKey(arr);

  if (!sig || !maxDayId || !confId) {
    console.error('[125] Could not map TV inputs to Pine (signal chain / max trades / conf proximity).');
    printDiscoveryFailure(sGet.inputs);
    process.exit(2);
  }

  const totalRuns = MAX_TRADES_DAY.length * COOLDOWN.length * CONF_PROX.length;
  console.error(
    `[125] match="${STRATEGY_SUB}" primary=${primaryId || 'none'} target=${gridId} sandboxKey=${sandboxKey ?? 'n/a'} keys={sl:${sig.sl},tp:${sig.tp},cd:${sig.cooldown},maxDay:${maxDayId},confProx:${confId}} runs=${totalRuns} delayMs=${DELAY_MS} out=${OUT}`
  );

  const doneKey = new Set();
  let run = 0;
  if (GRID_RESUME && existsSync(OUT)) {
    const prev = readFileSync(OUT, 'utf8');
    for (const line of prev.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        run = Math.max(run, o.run || 0);
        doneKey.add(`${o.maxTradesDay},${o.cooldown},${o.confProx}`);
      } catch {
        /* ignore */
      }
    }
    console.error(`[125] GRID_RESUME: skipping ${doneKey.size} combos, next run index continues from ${run + 1}`);
  } else {
    writeFileSync(OUT, '', { flag: 'w' });
  }

  let runCounter = run;
  let bestNet = { netProfit: -Infinity, row: null };
  let bestPen = { score: -Infinity, row: null };
  const tradeCeil = Math.max(10, Math.floor(BASELINE_TRADES * 0.81));
  let bestLow = { netProfit: -Infinity, row: null };
  const rows = [];

  for (const maxTradesDay of MAX_TRADES_DAY) {
    for (const cooldown of COOLDOWN) {
      for (const confProx of CONF_PROX) {
        const k = `${maxTradesDay},${cooldown},${confProx}`;
        if (doneKey.has(k)) continue;
        runCounter++;
        const merged = {
          ...base,
          ...LOW_LOAD,
          [sig.sl]: ANCHOR_SL,
          [sig.tp]: ANCHOR_TP,
          [sig.cooldown]: cooldown,
          [maxDayId]: maxTradesDay,
          [confId]: confProx,
        };
        if (sandboxKey) merged[sandboxKey] = ANCHOR_SANDBOX;

        try {
          execTv(['indicator', 'set', gridId, '-i', JSON.stringify(merged)]);
        } catch (e) {
          console.error(JSON.stringify({ run: runCounter, error: 'indicator set', message: e.message }));
          sleepMs(8000);
          continue;
        }
        sleepMs(DELAY_MS);

        let data;
        try {
          data = JSON.parse(execTv(['data', 'strategy']));
        } catch (e) {
          console.error(JSON.stringify({ run: runCounter, error: 'data strategy', message: e.message }));
          sleepMs(8000);
          continue;
        }

        const metrics = data.metrics || {};
        const net = typeof metrics.netProfit === 'number' ? metrics.netProfit : null;
        const trades = typeof metrics.totalTrades === 'number' ? metrics.totalTrades : null;
        const pen =
          net != null && trades != null ? net - TRADE_PEN * trades : Number.NEGATIVE_INFINITY;

        const line = {
          run: runCounter,
          strategyMatch: STRATEGY_SUB,
          maxTradesDay,
          cooldown,
          confProx,
          keys: { maxDay: maxDayId, cooldown: sig.cooldown, confProx: confId, sl: sig.sl, tp: sig.tp },
          netProfit: metrics.netProfit,
          profitFactor: metrics.profitFactor,
          percentProfitable: metrics.percentProfitable,
          totalTrades: metrics.totalTrades,
          maxStrategyDrawDownPercent: metrics.maxStrategyDrawDownPercent,
          adjustedScore: pen,
          strategy_name: data.strategy_name,
        };
        rows.push(line);
        console.log(JSON.stringify(line));
        writeFileSync(OUT, `${JSON.stringify(line)}\n`, { flag: 'a' });

        if (net != null && net > bestNet.netProfit) bestNet = { netProfit: net, row: line };
        if (pen > bestPen.score) bestPen = { score: pen, row: line };
        if (
          net != null &&
          trades != null &&
          trades <= tradeCeil &&
          net > bestLow.netProfit
        ) {
          bestLow = { netProfit: net, row: line };
        }
      }
    }
  }

  let allRows = rows;
  if (existsSync(OUT)) {
    allRows = [];
    for (const line of readFileSync(OUT, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        allRows.push(JSON.parse(t));
      } catch {
        /* ignore */
      }
    }
    let bn = { netProfit: -Infinity, row: null };
    let bp = { score: -Infinity, row: null };
    let bl = { netProfit: -Infinity, row: null };
    const ceil = Math.max(10, Math.floor(BASELINE_TRADES * 0.81));
    for (const line of allRows) {
      const net = line.netProfit;
      const trades = line.totalTrades;
      const pen = line.adjustedScore;
      if (typeof net === 'number' && net > bn.netProfit) bn = { netProfit: net, row: line };
      if (typeof pen === 'number' && pen > bp.score) bp = { score: pen, row: line };
      if (typeof net === 'number' && typeof trades === 'number' && trades <= ceil && net > bl.netProfit) {
        bl = { netProfit: net, row: line };
      }
    }
    bestNet = bn;
    bestPen = bp;
    bestLow = bl;
  }

  console.error('[125] --- Best raw netProfit (all rows in log) ---');
  console.error(JSON.stringify(bestNet.row, null, 2));
  console.error('[125] --- Best adjusted (net - penalty×trades) ---');
  console.error(JSON.stringify(bestPen.row, null, 2));
  console.error(`[125] log: ${OUT} (${allRows.length} lines)`);
  diagnose(bestNet.row, bestPen.row, bestLow.row, allRows);
}

main();
