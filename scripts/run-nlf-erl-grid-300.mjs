#!/usr/bin/env node
/**
 * 300 deterministic Strategy Tester scenarios for `ERL IRL Engine v2 Strategy [NLF]`.
 *
 * Grid (10 × 6 × 5 = 300): minBarsBetween × minScoreCont × minScoreRev
 * Constraints you asked for post-hoc ranking:
 *   - trades_per_calendar_day ≥ 1  (computed from Tester trade date range ms)
 *
 * Prerequisites:
 *   - TradingView Desktop + CDP; strategy compiles from data/erl-irl-engine-strategy.pine.
 *
 * Env:
 *   NLF_GRID_MAX          — run first N scenarios only (debug, e.g. 5)
 *   NLF_AFTER_INPUT_MS   — pause before polling Tester (default 1400)
 *   NLF_GRID_POLL_ATTEMPTS / NLF_GRID_POLL_GAP_MS — wait for Tester after each input tweak
 *   TV_BACKTEST_SYMBOL    — optional, e.g. MNQ1! or CME_MINI:MNQ1!
 *   TV_BACKTEST_TIMEFRAME — optional interval e.g. 5 / 15
 *   NLF_GRID_SOURCE_MODE — auto | inputs | rewrite (default auto). Strategies often expose
 *     empty getInputValues() via CDP; auto falls back to rewriting default input.int(...) lines each scenario.
 *   NLF_GRID_PARSE_RECOVERY — set to "0" to disable stale-parse recovery (remove NLF-like study then re-compile)
 *     on Monaco "cannot parse" markers during the grid run.
 *
 * Outputs:
 *   data/grid_runs/nlf_erl_300_<stamp>/
 *     scenarios.ndjson   — one line per scenario (crash-safe incremental)
 *     summary.json       — best feasible-by-constraint rows + manifests
 *
 * npm: npm run nlf:grid-300
 */
import { mkdirSync, createWriteStream, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect, evaluate, KNOWN_PATHS } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as pine from '../src/core/pine.js';
import * as ui from '../src/core/ui.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as indicators from '../src/core/indicators.js';
import { buildResolveBenchStudyHandlesBlock } from '../src/core/studyBenchResolve.js';

const ROOT = process.cwd();
const STRATEGY_FILE = join(ROOT, 'data', 'erl-irl-engine-strategy.pine');

if (!process.env.ADVISOR_STRATEGY_SUBSTRING) {
  process.env.ADVISOR_STRATEGY_SUBSTRING = 'ERL IRL Engine';
}

const TOTAL = Number(process.env.NLF_GRID_TOTAL || 300);
const NLF_GRID_MAX = process.env.NLF_GRID_MAX ? Number(process.env.NLF_GRID_MAX) : TOTAL;
const INPUT_DELAY_MS = Number(process.env.INPUT_DELAY_MS ?? 6200);
const NLF_POST_COMPILE_MS = Number(process.env.NLF_POST_COMPILE_MS ?? 7000);
const MIN_TRADES_PER_DAY = Number(process.env.NLF_GRID_MIN_TRADES_PER_DAY ?? 1);

const NLF_AFTER_INPUT_MS = Number(process.env.NLF_GRID_AFTER_INPUT_MS ?? 1400);
const NLF_POLL_ATTEMPTS = Number(process.env.NLF_GRID_POLL_ATTEMPTS ?? 28);
const NLF_POLL_GAP_MS = Number(process.env.NLF_GRID_POLL_GAP_MS ?? 900);
const NLF_GRID_REWRITE_EXTRA_MS = Number(process.env.NLF_GRID_REWRITE_EXTRA_MS ?? 2500);

const NLF_GRID_SOURCE_MODE = String(process.env.NLF_GRID_SOURCE_MODE || 'auto')
  .trim()
  .toLowerCase();

// 10 × 6 × 5 = 300
const GRID_MB = [0, 2, 4, 6, 8, 11, 15, 20, 28, 40];
const GRID_MC = [52, 58, 64, 70, 76, 82];
const GRID_MR = [50, 56, 62, 68, 75];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scenarioAt(i) {
  const mb = GRID_MB[i % 10];
  const mc = GRID_MC[Math.floor(i / 10) % 6];
  const mr = GRID_MR[Math.floor(i / 60) % 5];
  return { scenarioId: i, minBarsBetween: mb, minScoreCont: mc, minScoreRev: mr };
}

/** On TV "cannot parse" Monaco markers during grid compile: strip matching study then re-run smart compile once. */
function pineCompileOptsForNlfGrid() {
  if (String(process.env.NLF_GRID_PARSE_RECOVERY || '').trim() === '0') {
    return { recover_parse: false };
  }
  const entity = String(process.env.NLF_PARSE_RECOVERY_ENTITY_ID || '').trim();
  const sub = String(process.env.NLF_PARSE_RECOVERY_STUDY || process.env.ADVISOR_STRATEGY_SUBSTRING || '').trim();
  const o = { recover_parse: true };
  if (entity) {
    o.recover_entity_id = entity;
    return o;
  }
  if (sub) {
    o.recover_study_contains = sub;
    return o;
  }
  return {};
}

/** Deterministic tuner: edit default ints on the Pine input lines (avoids broken CDP getInputValues for strategies). */
function applyScenarioDefaultsToSource(template, spec) {
  const pairs = [
    [/^(\s*minBarsBetween\s*=\s*input\.int\()\d+/m, spec.minBarsBetween],
    [/^(\s*minScoreCont\s*=\s*input\.int\()\d+/m, spec.minScoreCont],
    [/^(\s*minScoreRev\s*=\s*input\.int\()\d+/m, spec.minScoreRev],
  ];
  let out = template;
  for (let pi = 0; pi < pairs.length; pi++) {
    const re = pairs[pi][0];
    const val = pairs[pi][1];
    const prev = out;
    out = out.replace(re, (_, p) => p + String(val));
    if (prev === out) {
      throw new Error(
        `rewrite: Pine source missing expected tuner line (${re}) — confirm data/erl-irl-engine-strategy.pine minBars/minScore inputs.`,
      );
    }
  }
  return out;
}

function calendarDaysTradeWindow(metrics) {
  const tw = metrics?.settings?.dateRange?.trade;
  if (!tw || typeof tw.from !== 'number' || typeof tw.to !== 'number') return NaN;
  const delta = Math.max(0, tw.to - tw.from);
  return Math.max(delta / 86400000, 1e-6);
}

async function pollStrategyResultsUntilReady() {
  for (let attempt = 0; attempt < NLF_POLL_ATTEMPTS; attempt++) {
    await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5, pause_ms: 380 });
    const strat = await data.getStrategyResults();
    const m = strat.metrics || {};
    const tradesKnown = typeof m.totalTrades === 'number';
    const hasSpan = !!(m.settings?.dateRange?.trade ?? m.settings?.dateRange?.backtest);
    const rich = Object.keys(m).length > 12;
    if (strat.report_ready === true || (tradesKnown && hasSpan) || rich) {
      return strat;
    }
    await sleep(NLF_POLL_GAP_MS);
  }
  return data.getStrategyResults();
}

function resolveInputIds(inputs, lenHint) {
  const list = Array.isArray(inputs) ? inputs : [];
  const len = lenHint ?? list.length;

  const findId = (...needles) => {
    const lows = needles.map((n) => String(n).toLowerCase());
    for (const inp of list) {
      const hay = `${inp?.text ?? ''} ${inp?.name ?? ''} ${inp?.internalID ?? ''}`.toLowerCase();
      if (lows.every((n) => hay.includes(n))) return inp.id;
    }
    return null;
  };

  let idCont = findId('min confidence', 'continuation');
  let idRev = findId('min confidence', 'reversal');
  let idBars = findId('min bars', 'between');

  if (!idBars || !idCont || !idRev) {
    const custom = (process.env.NLF_TUNER_INPUT_IDS_JSON || '').trim();
    if (custom) {
      try {
        const j = JSON.parse(custom);
        idBars = j.minBarsBetween || j.bars || idBars;
        idCont = j.minScoreCont || j.cont || idCont;
        idRev = j.minScoreRev || j.rev || idRev;
      } catch {
        /* ignore malformed */
      }
    }
  }

  // Desktop often hides labels on getInputValues — fall back to Pine declaration order:
  // in_22=minBarsBetween, in_25=minScoreCont, in_26=minScoreRev (see erl-irl-engine-strategy.pine).
  if ((!idBars || !idCont || !idRev) && len >= 27) {
    idBars ||= 'in_22';
    idCont ||= 'in_25';
    idRev ||= 'in_26';
  }

  return { idCont, idRev, idBars, listLen: len };
}

function sortStudiesPreferNlf(studies) {
  const list = [...(studies || [])];
  return list.sort((a, b) => {
    const ra = /erl\s*irl\s*engine\s*v2\s*strategy/i.test(String(a.name || ''))
      ? 0
      : /erl\s*irl/i.test(String(a.name || ''))
        ? 1
        : 100;
    const rb = /erl\s*irl\s*engine\s*v2\s*strategy/i.test(String(b.name || ''))
      ? 0
      : /erl\s*irl/i.test(String(b.name || ''))
        ? 1
        : 100;
    return ra - rb;
  });
}

function pickEntityId(state) {
  const forced = (process.env.NLF_GRID_ENTITY_ID || '').trim();
  if (forced) return forced;
  const studies = state.studies || [];
  const needle = String(process.env.ADVISOR_STRATEGY_SUBSTRING || '').trim().toLowerCase();
  const hit =
    studies.find((s) => /erl irl engine v2 strategy/i.test(String(s.name || ''))) ||
    studies.find((s) => String(s.name || '').toLowerCase().includes('erl irl')) ||
    (needle ? studies.find((s) => String(s.name || '').toLowerCase().includes(needle)) : undefined);
  const strat = hit || studies.find((s) => /strategy/i.test(String(s.name || ''))) || studies[0];
  return strat?.id ?? null;
}

const CHART_API = KNOWN_PATHS.chartApi;

async function probeStudyBench(entityId) {
  const clean = String(entityId || '').replace(/'/g, "\\'");
  const rb = buildResolveBenchStudyHandlesBlock(clean);
  return evaluate(`
    (function() {
      try {
        var api = ${CHART_API};
        ${rb}
        var st = __resolveBenchStudyForInputs(api);
        if (!st || typeof st.getInputValues !== 'function') return { ok: false, len: 0, by: {}, err: 'no bench handle' };
        var inputs = st.getInputValues();
        var by = {};
        for (var i = 0; i < inputs.length; i++) {
          var inp = inputs[i];
          if (inp.id === 'in_22' || inp.id === 'in_25' || inp.id === 'in_26') {
            by[inp.id] = inp.value;
          }
        }
        return { ok: true, len: inputs.length, by: by };
      } catch (e) {
        return { ok: false, len: 0, by: {}, err: String(e.message) };
      }
    })()
  `);
}

function isTvNlfStudyName(name) {
  return /erl\s*irl\s*engine\s*v2\s*strategy/i.test(String(name || '').toLowerCase());
}

function benchTrioNumeric(by) {
  return (
    Number.isFinite(Number(by?.in_22)) &&
    Number.isFinite(Number(by?.in_25)) &&
    Number.isFinite(Number(by?.in_26))
  );
}

async function findStrategyInputsAndEntity() {
  const forcedId = (process.env.NLF_GRID_ENTITY_ID || '').trim();
  const minLen = Number(process.env.NLF_GRID_MIN_INPUT_LEN ?? 55);

  const waitHydrateProbe = async (entityIdGuess, budgetMs) => {
    const hydrateWait = budgetMs ?? Number(process.env.NLF_GRID_HYDRATE_MS ?? 20000);
    const step = Number(process.env.NLF_GRID_HYDRATE_STEP_MS ?? 550);
    const steps = Math.max(6, Math.ceil(hydrateWait / step));
    for (let w = 0; w < steps; w++) {
      const bench = await probeStudyBench(entityIdGuess);
      if (bench.ok && bench.len >= minLen && benchTrioNumeric(bench.by)) return bench;
      await sleep(step);
    }
    return null;
  };

  if (forcedId) {
    const hydrated = await waitHydrateProbe(forcedId);
    if (!hydrated) {
      throw new Error(
        `NLF_GRID_ENTITY_ID=${forcedId} never returned inputs — study IDs change after Pine save. Run chart state via CLI and refresh NLF_GRID_ENTITY_ID.`,
      );
    }
    return {
      entityId: forcedId,
      benchBy: hydrated.by,
      inputLen: hydrated.len,
      studyLabel: 'NLF_GRID_ENTITY_ID',
    };
  }

  let ordered = sortStudiesPreferNlf((await chart.getState()).studies);
  let lastProbe = '';
  const probeRounds = Number(process.env.NLF_GRID_PROBE_ROUNDS ?? 12);

  for (let round = 0; round < probeRounds; round++) {
    for (const cand of ordered) {
      if (!isTvNlfStudyName(cand.name)) continue;
      const id = cand.id;
      if (!id) continue;
      lastProbe = id;
      const hydratedGuess = Number(process.env.NLF_GRID_AUTOPICK_HYDRATE_MS ?? 4000);
      const hydrated = await waitHydrateProbe(id, hydratedGuess);
      if (hydrated) {
        return { entityId: id, benchBy: hydrated.by, inputLen: hydrated.len, studyLabel: cand.name };
      }
    }
    await sleep(1550 + round * 220);
    ordered = sortStudiesPreferNlf((await chart.getState()).studies);
    if (!ordered.length) break;
  }

  const dbg = lastProbe ? await probeStudyBench(lastProbe) : {};
  console.error(JSON.stringify({ nlfProbeFailed: true, lastProbe, dbg }));
  throw new Error(
    `NLF strategy not detected (${lastProbe} last id), or Tester inputs unavailable via chart API.` +
      ` Hide non-NLF studies, bump NLF_GRID_PROBE_ROUNDS / NLF_GRID_ENTITY_ID, or set NLF_GRID_SOURCE_MODE=rewrite.`,
  );
}

function rankComparable(a, b) {
  if (a.metConstraint !== b.metConstraint) return (b.metConstraint ? 1 : 0) - (a.metConstraint ? 1 : 0);
  const np = (b.netProfit ?? -Infinity) - (a.netProfit ?? -Infinity);
  if (np !== 0) return np;
  return (b.profitFactor ?? 0) - (a.profitFactor ?? 0);
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
  const outDir = join(ROOT, 'data', 'grid_runs', `nlf_erl_300_${stamp}`);
  mkdirSync(outDir, { recursive: true });

  const ndPath = join(outDir, 'scenarios.ndjson');
  const ndStream = createWriteStream(ndPath, { flags: 'a' });

  try {
    const runCount = Math.min(NLF_GRID_MAX, TOTAL);
    const timeline = [];

    console.log(JSON.stringify({ start: stamp, scenariosPlanned: runCount, outDir: `data/grid_runs/nlf_erl_300_${stamp}` }));

    await health.healthCheck();

    if (process.env.TV_BACKTEST_SYMBOL) {
      await chart.setSymbol({ symbol: process.env.TV_BACKTEST_SYMBOL.trim() });
      await sleep(1500);
    }
    if (process.env.TV_BACKTEST_TIMEFRAME) {
      await chart.setTimeframe({ timeframe: process.env.TV_BACKTEST_TIMEFRAME.trim() });
      await sleep(2200);
    }

    const pineDiskBaseline = readFileSync(STRATEGY_FILE, 'utf8');
    await pine.setSource({ source: pineDiskBaseline });
    await ui.openPanel({ panel: 'pine-editor', action: 'open' });
    const compileAck = await pine.smartCompile(pineCompileOptsForNlfGrid());
    timeline.push({ pine_compile_initial: compileAck });
    await sleep(NLF_POST_COMPILE_MS);

    await ui.openPanel({ panel: 'strategy-tester', action: 'open' });
    await sleep(1200);

    const modeEff = NLF_GRID_SOURCE_MODE;
    if (modeEff !== 'auto' && modeEff !== 'inputs' && modeEff !== 'rewrite') {
      throw new Error(`NLF_GRID_SOURCE_MODE="${modeEff}" must be auto | inputs | rewrite`);
    }

    let gridPayload;
    if (modeEff === 'rewrite') {
      gridPayload = { mode: 'rewrite' };
    } else {
      try {
        const tuned = await findStrategyInputsAndEntity();
        gridPayload = { mode: 'inputs', ...tuned };
      } catch (eIn) {
        if (modeEff === 'inputs') throw eIn;
        console.warn(
          JSON.stringify({
            nlFGridInputsSkipped: true,
            reason: String(eIn.message),
            fallback: 'rewrite',
          }),
        );
        gridPayload = { mode: 'rewrite' };
      }
    }

    let entityId = null;
    let ids = { idCont: null, idRev: null, idBars: null, listLen: 0 };
    let baselineOverrides = {};

    if (gridPayload.mode === 'inputs') {
      entityId = gridPayload.entityId;
      ids = resolveInputIds([], gridPayload.inputLen);
      if (!ids.idCont || !ids.idRev || !ids.idBars) {
        throw new Error(`Could not resolve tuner input ids (${JSON.stringify(ids)}).`);
      }
      baselineOverrides = {
        [ids.idBars]: gridPayload.benchBy.in_22,
        [ids.idCont]: gridPayload.benchBy.in_25,
        [ids.idRev]: gridPayload.benchBy.in_26,
      };
    }

    writeFileSync(
      join(outDir, 'input_manifest.json'),
      JSON.stringify({
        requested_source_mode: modeEff,
        grid_source_mode: gridPayload.mode,
        entity_id: entityId,
        study_label: gridPayload.mode === 'inputs' ? gridPayload.studyLabel : null,
        bench_by: gridPayload.mode === 'inputs' ? gridPayload.benchBy : null,
        input_len_tv: gridPayload.mode === 'inputs' ? gridPayload.inputLen : null,
        resolved: ids,
        studies: (await chart.getState()).studies,
      }),
      'utf8',
    );

    const collected = [];

    async function restoreBaseline() {
      if (gridPayload.mode !== 'inputs') return;
      await indicators.setInputs({
        entity_id: entityId,
        inputs: baselineOverrides,
        persist_layout: false,
      });
      await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 6, pause_ms: 420 });
      await sleep(INPUT_DELAY_MS);
    }

    try {
      for (let i = 0; i < runCount; i++) {
        const spec = scenarioAt(i);

        try {
          if (gridPayload.mode === 'rewrite') {
            const patched = applyScenarioDefaultsToSource(pineDiskBaseline, spec);
            await pine.setSource({ source: patched });
            const ck = await pine.smartCompile(pineCompileOptsForNlfGrid());
            timeline.push({
              scenarioId: spec.scenarioId,
              pine_rewrite_compile: { success: ck?.success, has_errors: ck?.has_errors },
            });
            await sleep(NLF_POST_COMPILE_MS);
            await sleep(NLF_GRID_REWRITE_EXTRA_MS);
          } else {
            const payload = {};
            payload[ids.idBars] = spec.minBarsBetween;
            payload[ids.idCont] = spec.minScoreCont;
            payload[ids.idRev] = spec.minScoreRev;
            await indicators.setInputs({ entity_id: entityId, inputs: payload, persist_layout: false });
          }
        } catch (e) {
          const row = {
            scenarioId: spec.scenarioId,
            spec,
            error: String(e.message),
            at: new Date().toISOString(),
            grid_source_mode: gridPayload.mode,
          };
          ndStream.write(`${JSON.stringify(row)}\n`);
          continue;
        }

        await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 6, pause_ms: 450 });
        await sleep(NLF_AFTER_INPUT_MS);
        await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5, pause_ms: 380 });

        const strat = await pollStrategyResultsUntilReady();
        const metrics = strat.metrics || {};
        const totalTrades = metrics.totalTrades ?? 0;
        const cdays = calendarDaysTradeWindow(metrics);
        const tradesPerDay = cdays > 0 && Number.isFinite(cdays) ? totalTrades / cdays : NaN;
        const metTradeFloor = tradesPerDay >= MIN_TRADES_PER_DAY - 1e-9 && Number.isFinite(tradesPerDay);
        const metConstraint =
          metTradeFloor &&
          typeof metrics.netProfit === 'number' &&
          totalTrades > 0 &&
          Number.isFinite(cdays);

        const row = {
          at: new Date().toISOString(),
          scenarioId: spec.scenarioId,
          spec,
          grid_source_mode: gridPayload.mode,
          netProfit: metrics.netProfit,
          netProfitPercent: metrics.netProfitPercent,
          profitFactor: metrics.profitFactor,
          percentProfitable: metrics.percentProfitable,
          totalTrades,
          tradesPerCalendarDay: tradesPerDay,
          calendar_days_trade_span: cdays,
          commissionPaid: metrics.commissionPaid,
          met_trade_per_day_floor: tradesPerDay >= MIN_TRADES_PER_DAY - 1e-9,
          metConstraint,
          strategy_name: strat.strategy_name,
          report_ready: strat.report_ready,
        };
        ndStream.write(`${JSON.stringify(row)}\n`);
        collected.push(row);
        if ((i + 1) % 25 === 0) {
          console.log(JSON.stringify({ progress: i + 1, runCount, grid_source_mode: gridPayload.mode }));
        }
      }
    } finally {
      if (gridPayload.mode === 'inputs') await restoreBaseline().catch(() => {});
      if (gridPayload.mode === 'rewrite') {
        await pine.setSource({ source: pineDiskBaseline }).catch(() => {});
        await pine.smartCompile({ recover_parse: false }).catch(() => {});
        await sleep(Math.min(NLF_POST_COMPILE_MS, 4500));
      }
    }

    const feasibleAll = [...collected].filter((r) => r.metConstraint);
    feasibleAll.sort(rankComparable);

    const summary = {
      generated_at: new Date().toISOString(),
      runCount,
      outDir: `data/grid_runs/nlf_erl_300_${stamp}`,
      grid_source_mode: gridPayload.mode,
      requested_source_mode: modeEff,
      baseline_inputs_restored_ids: baselineOverrides,
      min_trades_per_day_requirement: MIN_TRADES_PER_DAY,
      best_overall_met_constraint: feasibleAll[0] ?? null,
      best_that_failed_constraint: [...collected]
        .filter((r) => !r.metConstraint && typeof r.netProfit === 'number')
        .sort(rankComparable)[0] ?? null,
      top_feasible: feasibleAll.slice(0, 15),
      top_raw_profit_ignore_constraint: [...collected]
        .filter((r) => typeof r.netProfit === 'number')
        .sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0))
        .slice(0, 15),
      notes: [
        'metConstraint requires ≥1 closed trade per calendar day of Tester trade-span AND numeric netProfit.',
        'rewrite mode rewrites default input.int() lines per scenario (slow but works when CDP getInputValues is empty).',
        'Tune MIN_TRADES_PER_DAY env or grid arrays in this script before another pass.',
        'strategy_snapshot is NOT auto-synced — run npm run nlf:backtest-save for full JSON artifact after picking inputs.',
      ],
      compile_ack: compileAck,
      timeline,
    };

    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ done: true, feasibleCount: feasibleAll.length, best: summary.best_overall_met_constraint }));

    await disconnect().catch(() => {});
  } finally {
    ndStream.end();
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ success: false, error: e.message }));
  disconnect().catch(() => {});
  process.exit(1);
});
