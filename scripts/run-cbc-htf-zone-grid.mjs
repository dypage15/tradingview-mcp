#!/usr/bin/env node
/**
 * Scenario grid for **CBC + Multi-Session Sweep [MMT v4]** (Pine source:
 * `CBC_MultiSession_Sweep_STRATEGY_v4.pine` in Downloads) — HTF alignment + HTF TFs + chart resolution.
 *
 * 0-based TV input ids for that **source** build (verify on your chart with CBC_VERIFY=1):
 *   in_12  Require HTF Alignment
 *   in_14  HTF Bias TF (resolution string, e.g. "10")
 *   in_15  1H Swing TF (e.g. "60")
 *   in_47  Sweep threshold (pts)  — optional axis when CBC_SWEEP_GRID=1
 *   in_49  Min confluence          — optional axis when CBC_SWEEP_GRID=1
 *
 * Default run count: 3 chart TFs × 2 × 4 × 2 = **48** (cap with GRID_MAX_RUNS).
 *
 * Prereqs: TradingView Desktop + CDP 9222; CBC MMT strategy on chart; Strategy Tester usable.
 *
 * Env:
 *   TV_STRATEGY_NAME — substring of strategy title (if unset, matches CBC / multi-session / MMT v4 heuristics)
 *   TV_ENTITY — force study entity id
 *   CBC_RELAX_PICK=1 — if no name match, pick first Pine strategy on chart (can select the wrong script)
 *   CBC_AUTO_ADD=1 — if CBC study is missing, try adding STRATEGY_ADD_HINT automatically (default on)
 *   GRID_DELAY_MS — after each indicator set (default 7000)
 *   CBC_TF_SETTLE_MS — after `tv timeframe` (default 12000)
 *   CBC_SKIP_PREFLIGHT=1 — skip timeframe 5 + pine/strategy panels
 *   CBC_VERIFY=1 — print in_10..in_16 labels from chart and exit
 *   CBC_SWEEP_GRID=1 — add sweep threshold + min confluence axes (grows run count)
 *   CBC_LEVELS_GRID=1 — add level-family toggles (Asia/London/IB/CBDR/PDHL/1H/Midnight)
 *   CBC_TEST_PROFILE=smoke|levels300 — shortcut presets for quick validation
 *   GRID_MAX_RUNS — cap scenarios (default 300)
 *   CBC_CHART_TFS — comma list, default "3,5,15"
 *
 * Anti–internal-error pacing (TradingView overload / study churn):
 *   CBC_SAFE_MODE=0 — faster defaults (riskier on long grids)
 *   GRID_SAFE_MODE=0 — same as CBC_SAFE_MODE=0 when CBC_SAFE_MODE unset
 *   When safe mode is on (default): gentler GRID_DELAY_MS / CBC_TF_SETTLE_MS unless you override them.
 *   CBC_POST_TF_MS — extra pause after resolution change before indicator set (default 3000 safe / 1200 fast)
 *   CBC_SCENARIO_GAP_MS — pause after reading metrics before next scenario (default 800 safe / 0 fast)
 *   GRID_COOLDOWN_ON_ERROR_MS — backoff after failed set / empty metrics / overload text (default 15000 safe / 8000 fast)
 *   CBC_METRICS_ATTEMPTS — retries for strategy metrics (default 4)
 *   CBC_INDICATOR_SET_ATTEMPTS — retries per scenario indicator set (default 4)
 *   CBC_STALL_EVERY_N — every N completed scenario indices, extra pause (default 10; 0=off)
 *   CBC_STALL_MS — length of that pause (default 12000 safe / 5000 fast)
 *   CBC_PRE_GRID_SETTLE_MS — pause once after preflight before first scenario (default 5000 safe / 2500 fast)
 *
 * Usage: npm run cbc:htf-grid
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tv = join(root, 'src', 'cli', 'index.js');
const BUF = 50 * 1024 * 1024;

/** Default on (like winrate-grid). Only `CBC_SAFE_MODE=0` or `GRID_SAFE_MODE=0` disables. */
function cbcSafeModeEnabled() {
  if (process.env.CBC_SAFE_MODE === '0' || process.env.GRID_SAFE_MODE === '0') return false;
  return true;
}
const SAFE = cbcSafeModeEnabled();

const DELAY_MS = Number(
  process.env.GRID_DELAY_MS ?? (SAFE ? 10_000 : 6500)
);
const TF_SETTLE_MS = Number(
  process.env.CBC_TF_SETTLE_MS ?? (SAFE ? 16_000 : 10_000)
);
const POST_TF_MS = Number(
  process.env.CBC_POST_TF_MS ?? (SAFE ? 3000 : 1200)
);
const SCENARIO_GAP_MS = Number(process.env.CBC_SCENARIO_GAP_MS ?? (SAFE ? 800 : 0));
const COOLDOWN_ON_BAD_MS = Number(
  process.env.GRID_COOLDOWN_ON_ERROR_MS ?? (SAFE ? 15_000 : 8000)
);
const METRICS_ATTEMPTS = Number(process.env.CBC_METRICS_ATTEMPTS || 4);
const INDICATOR_SET_ATTEMPTS = Number(process.env.CBC_INDICATOR_SET_ATTEMPTS || 4);
const TF_SKIP_SETTLE_MS = Number(process.env.CBC_TF_SKIP_SETTLE_MS || 2000);
const STALL_EVERY_N = Number(process.env.CBC_STALL_EVERY_N ?? 10);
const STALL_MS = Number(process.env.CBC_STALL_MS ?? (SAFE ? 12_000 : 5000));
const PRE_GRID_SETTLE_MS = Number(process.env.CBC_PRE_GRID_SETTLE_MS ?? (SAFE ? 5000 : 2500));

const TV_RETRIES = Number(process.env.GRID_TV_RETRIES || 3);
const TV_RETRY_MS = Number(process.env.GRID_TV_RETRY_MS || 2000);
const STRATEGY_ENV = (process.env.TV_STRATEGY_NAME || '').trim();
const STRATEGY_HINT = STRATEGY_ENV.toLowerCase() || 'mmt v2';
const STRATEGY_ADD_HINT = STRATEGY_ENV || 'CBC Engine + Asia Sweep [MMT v2]';
const AUTO_ADD = process.env.CBC_AUTO_ADD === '0' ? false : true;

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function execTv(args, label) {
  let lastErr;
  for (let attempt = 1; attempt <= TV_RETRIES; attempt++) {
    try {
      return execFileSync(process.execPath, [tv, ...args], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: BUF,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      console.error(`[cbc-htf-grid] ${label} failed (${attempt}/${TV_RETRIES}): ${msg}`);
      if (attempt < TV_RETRIES) sleepMs(TV_RETRY_MS);
    }
  }
  throw lastErr;
}

/** Does not throw — use for indicator set / overload-aware retries. */
function execTvCapture(args) {
  try {
    const stdout = execFileSync(process.execPath, [tv, ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: BUF,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, stdout: stdout || '', stderr: '' };
  } catch (e) {
    return {
      ok: false,
      code: e.status ?? 1,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || ''),
      message: e.message || String(e),
    };
  }
}

function parseStdoutJson(stdout) {
  try {
    return JSON.parse(stdout || '{}');
  } catch {
    return { success: false, error: 'json_parse', _raw: String(stdout || '').slice(0, 400) };
  }
}

/** TV/CDP churn that benefits from longer cooldowns (avoid cascading internal errors). */
function looksLikeTvOverload(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return (
    /internal\s*error|internal\s*server|intrnl|something\s*went\s*wrong|unexpected\s*error/.test(t) ||
    /too\s*many|rate\s*limit|throttl|429/.test(t) ||
    /timeout|timed\s*out|etimedout|econnreset|websocket|503|502|504/.test(t) ||
    /study\s*not\s*found|entity\s*not\s*found|not\s*found:\s*[a-z]/i.test(t)
  );
}

function extractTvError(cap, body) {
  if (body && body.error) return String(body.error);
  if (cap.stderr) {
    try {
      const j = JSON.parse(cap.stderr);
      if (j.error) return String(j.error);
    } catch {
      if (cap.stderr.trim()) return cap.stderr.trim();
    }
  }
  return cap.message || 'tv command failed';
}

function tvJson(args) {
  const out = execTv(args, args.join(' '));
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`tv JSON parse failed: ${e.message}\nstdout: ${String(out).slice(0, 500)}`);
  }
}

function isPineStrategyInputs(inputs) {
  if (!Array.isArray(inputs)) return false;
  const pf = inputs.find((i) => i.id === 'pineFeatures');
  if (!pf || typeof pf.value !== 'string') return false;
  try {
    const j = JSON.parse(pf.value);
    return j.strategy === 1;
  } catch {
    return false;
  }
}

/** Default name heuristics when TV_STRATEGY_NAME is unset — avoids picking unrelated Pine strategies. */
function defaultCbcStudyMatch(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('asia sweep')) return true;
  if (n.includes('mmt v2')) return true;
  if (n.includes('multi-session')) return true;
  if (n.includes('mmt v4')) return true;
  if (n.includes('cbc') && (n.includes('sweep') || n.includes('session'))) return true;
  return false;
}

function resolveStrategyEntity() {
  const explicit = (process.env.TV_ENTITY || '').trim();
  if (explicit) {
    console.error(`[cbc-htf-grid] Using TV_ENTITY=${explicit}`);
    return explicit;
  }
  const state = tvJson(['state']);
  const studies = state.studies || [];
  const relax = process.env.CBC_RELAX_PICK === '1';
  const candidates = studies.filter((s) => {
    const n = (s.name || '').toLowerCase();
    if (STRATEGY_ENV) return n.includes(STRATEGY_HINT);
    return defaultCbcStudyMatch(s.name);
  });
  const ordered = candidates.length ? candidates : relax ? studies : [];
  if (!ordered.length) {
    if (AUTO_ADD) {
      console.error(`[cbc-htf-grid] no matching study, attempting indicator add: "${STRATEGY_ADD_HINT}"`);
      try {
        execTv(['indicator', 'add', STRATEGY_ADD_HINT], 'indicator add');
        sleepMs(4000);
        const state2 = tvJson(['state']);
        const studies2 = state2.studies || [];
        const c2 = studies2.filter((s) => {
          const n = (s.name || '').toLowerCase();
          if (STRATEGY_ENV) return n.includes(STRATEGY_HINT);
          return defaultCbcStudyMatch(s.name);
        });
        if (c2.length) {
          for (const s of c2) {
            try {
              const info = tvJson(['indicator', 'get', s.id]);
              if (info.success && isPineStrategyInputs(info.inputs)) {
                console.error(`[cbc-htf-grid] auto-added and selected: ${s.id} — ${s.name}`);
                return s.id;
              }
            } catch {
              /* keep trying */
            }
          }
        }
      } catch (e) {
        console.error('[cbc-htf-grid] auto-add failed:', e?.message || e);
      }
    }
    const names = studies.map((s) => `${s.name} (${s.id})`).join(' | ') || '(none)';
    throw new Error(
      `[cbc-htf-grid] No study matched CBC/MMT name rules (hint="${STRATEGY_ADD_HINT}"). ` +
        `On chart: ${names}. Add CBC+MMT strategy, set TV_STRATEGY_NAME to a substring of its title, ` +
        `or set TV_ENTITY=id. To fall back to "first Pine strategy" (risky), set CBC_RELAX_PICK=1.`
    );
  }
  for (const s of ordered) {
    try {
      const info = tvJson(['indicator', 'get', s.id]);
      if (info.success && isPineStrategyInputs(info.inputs)) {
        console.error(`[cbc-htf-grid] Auto-selected Pine strategy: ${s.id} — ${s.name}`);
        return s.id;
      }
    } catch {
      /* next */
    }
  }
  // Fallback: some TradingView builds omit pineFeatures.strategy even for strategies.
  // If the study name matched CBC/MMT rules, use the first matched id and proceed.
  if (ordered.length > 0) {
    console.error(
      `[cbc-htf-grid] pineFeatures.strategy missing; falling back to matched study id: ${ordered[0].id} — ${ordered[0].name}`
    );
    return ordered[0].id;
  }
  throw new Error(
    `No Pine strategy (pineFeatures.strategy) among matched studies. Set TV_ENTITY to the CBC study id.`
  );
}

function inputsMapFromGet(info) {
  const o = {};
  const arr = info?.inputs;
  if (!Array.isArray(arr)) return o;
  for (const row of arr) {
    if (row.id && String(row.id).startsWith('in_')) o[row.id] = row.value;
  }
  return o;
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pickInputId(inputs, includesAny, fallbackId) {
  if (!Array.isArray(inputs)) return fallbackId;
  for (const row of inputs) {
    const id = String(row?.id || '');
    if (!id.startsWith('in_')) continue;
    const label = normText(row?.name || row?.title || row?.text || '');
    if (!label) continue;
    let ok = true;
    for (const token of includesAny) {
      if (!label.includes(token)) {
        ok = false;
        break;
      }
    }
    if (ok) return id;
  }
  return fallbackId;
}

function fetchStrategyMetrics() {
  const out = execTv(['data', 'strategy'], 'data strategy');
  return JSON.parse(out);
}

function fetchTradesCount() {
  try {
    const out = execTv(['data', 'trades', '-n', '2000'], 'data trades');
    const j = JSON.parse(out);
    const arr = Array.isArray(j?.trades) ? j.trades : Array.isArray(j?.result?.trades) ? j.result.trades : [];
    return arr.length;
  } catch {
    return 0;
  }
}

function waitForReportReady(label) {
  const max = Number(process.env.CBC_REPORT_READY_ATTEMPTS || 8);
  let last = null;
  for (let i = 1; i <= max; i++) {
    const data = fetchStrategyMetrics();
    last = data;
    if (data?.report_ready === true) return data;
    const wait = 3000 * i;
    console.error(`[cbc-htf-grid] ${label}: report not ready (${i}/${max}) — sleep ${wait}ms`);
    if (i % 3 === 0) {
      try {
        execTv(['ui', 'panel', 'strategy-tester', 'open'], 'strategy-tester open');
      } catch {
        /* ignore */
      }
    }
    sleepMs(wait);
  }
  return last || { success: false, report_ready: false, metrics: {} };
}

function fetchStrategyMetricsStable(label) {
  const bad = (d) => {
    if (!d) return true;
    if (d.error) return true;
    if (d.report_ready === false) return true;
    const m = d.metrics || {};
    return Object.keys(m).length === 0;
  };

  let last = null;
  for (let attempt = 1; attempt <= METRICS_ATTEMPTS; attempt++) {
    let data;
    try {
      data = fetchStrategyMetrics();
    } catch (e) {
      last = { error: e.message || String(e), metrics: {} };
      const wait = COOLDOWN_ON_BAD_MS * Math.min(3, attempt);
      console.error(
        `[cbc-htf-grid] ${label}: data strategy threw (${attempt}/${METRICS_ATTEMPTS}) — sleep ${wait}ms`
      );
      sleepMs(wait);
      continue;
    }
    last = data;
    if (!bad(data)) return data;

    const errStr = `${data.error || ''}`;
    const overload = looksLikeTvOverload(errStr);
    const base = overload ? COOLDOWN_ON_BAD_MS : TV_RETRY_MS * 2;
    const wait = base * Math.min(4, attempt);
    console.error(
      `[cbc-htf-grid] ${label}: empty/bad metrics (${attempt}/${METRICS_ATTEMPTS})${overload ? ' [overload?]' : ''} — sleep ${wait}ms`
    );
    sleepMs(wait);
  }
  const trades = fetchTradesCount();
  if (last && (!last.metrics || Object.keys(last.metrics).length === 0) && trades > 0) {
    return {
      ...last,
      metrics: { totalTrades: trades },
      _fallback_trades_only: true,
    };
  }
  return last || { success: false, error: 'metrics_exhausted', metrics: {} };
}

function indicatorSetWithRetries(entity, merged, label) {
  const payload = JSON.stringify(merged);
  let currentEntity = entity;
  for (let attempt = 1; attempt <= INDICATOR_SET_ATTEMPTS; attempt++) {
    const cap = execTvCapture(['indicator', 'set', currentEntity, '-i', payload]);
    const body = parseStdoutJson(cap.stdout);
    const ok = cap.ok && body.success === true;

    if (ok) return { ok: true, entity: currentEntity };

    const errText = extractTvError(cap, body);
    if (/no such study|study not found|not found/i.test(errText)) {
      try {
        const next = resolveStrategyEntity();
        if (next && next !== currentEntity) {
          console.error(`[cbc-htf-grid] ${label}: strategy id changed ${currentEntity} -> ${next}`);
          currentEntity = next;
          sleepMs(TV_RETRY_MS);
          continue;
        }
      } catch {
        /* keep retrying with cooldown */
      }
    }
    const overload = looksLikeTvOverload(errText + cap.stderr + cap.stdout);
    const wait = (overload ? COOLDOWN_ON_BAD_MS : TV_RETRY_MS * 2) * Math.min(4, attempt);
    console.error(
      `[cbc-htf-grid] ${label}: indicator set failed (${attempt}/${INDICATOR_SET_ATTEMPTS}): ${errText.slice(0, 200)} — sleep ${wait}ms`
    );
    sleepMs(wait);
  }
  return { ok: false, error: 'indicator_set_exhausted', entity: currentEntity };
}

function getChartResolution() {
  try {
    const j = tvJson(['status']);
    return String(j.chart_resolution ?? '');
  } catch {
    return '';
  }
}

function cartesian(grid) {
  const keys = Object.keys(grid);
  let rows = [{}];
  for (const k of keys) {
    const next = [];
    for (const row of rows) {
      for (const v of grid[k]) {
        next.push({ ...row, [k]: v });
      }
    }
    rows = next;
  }
  return rows;
}

function slimMetrics(m) {
  if (!m || typeof m !== 'object') return m;
  const keep = [
    'netProfit',
    'netProfitPercent',
    'percentProfitable',
    'profitFactor',
    'totalTrades',
    'maxStrategyDrawDownPercent',
    'maxStrategyDrawDown',
  ];
  const o = {};
  for (const k of keep) {
    if (m[k] !== undefined && m[k] !== null) o[k] = m[k];
  }
  return o;
}

function preflight() {
  const j = tvJson(['status']);
  if (!j.success) throw new Error('tv status: success false');
  console.error(`[cbc-htf-grid] CDP OK — ${j.chart_symbol || '?'} @ ${j.chart_resolution || '?'}`);
  if (process.env.CBC_SKIP_PREFLIGHT === '1') {
    console.error('[cbc-htf-grid] CBC_SKIP_PREFLIGHT=1 — skipping timeframe / panels');
    return;
  }
  try {
    execTv(['timeframe', '5'], 'timeframe 5');
    sleepMs(TF_SETTLE_MS);
    execTv(['ui', 'panel', 'strategy-tester', 'open'], 'strategy-tester');
    sleepMs(2000);
    console.error('[cbc-htf-grid] preflight: pine set/compile disabled for stability');
  } catch (e) {
    console.error('[cbc-htf-grid] preflight warning:', e?.message || e);
  }
}

function verifyAndExit(entity, ids) {
  const info = tvJson(['indicator', 'get', entity]);
  const arr = info.inputs || [];
  const pick = (idx) => arr.find((r) => r.id === `in_${idx}`);
  const wanted = [
    ['requireHtfAlign', ids.requireHtfAlign],
    ['htfBiasTf', ids.htfBiasTf],
    ['h1SwingTf', ids.h1SwingTf],
    ['sweepThreshold', ids.sweepThreshold],
    ['minConfluence', ids.minConfluence],
    ['useAsiaLevels', ids.useAsiaLevels],
    ['useLondonLevels', ids.useLondonLevels],
    ['useIBLevels', ids.useIBLevels],
    ['useCBDRLevels', ids.useCBDRLevels],
    ['usePDHLLevels', ids.usePDHLLevels],
    ['useMidnightLevel', ids.useMidnightLevel],
    ['show1HLevels', ids.show1HLevels],
  ];
  console.error('[cbc-htf-grid] CBC_VERIFY — resolved ids and current values:');
  for (const [k, id] of wanted) {
    if (!id) {
      console.error(`  ${k}: <unresolved>`);
      continue;
    }
    const n = Number(String(id).replace('in_', ''));
    const r = Number.isFinite(n) ? pick(n) : null;
    console.error(`  ${k} (${id}): ${JSON.stringify(r?.value)}`);
  }
  process.exit(0);
}

function resolveGridInputIds(info) {
  const inputs = info?.inputs || [];
  const ids = {
    // CBC v2 source-order fallback ids (when TradingView omits input labels in indicator_get):
    // in_3=requireHTFAlign, in_6=htfRes, in_7=h1Res, in_29=sweepThreshold, in_31=minConfluence
    // in_15..in_20 level toggles, in_32 show1HLevels
    requireHtfAlign: pickInputId(inputs, ['require', 'htf', 'align'], 'in_3'),
    htfBiasTf: pickInputId(inputs, ['higher', 'timeframe'], 'in_6'),
    h1SwingTf: pickInputId(inputs, ['1h', 'level', 'timeframe'], 'in_7'),
    sweepThreshold: pickInputId(inputs, ['sweep', 'threshold'], 'in_29'),
    minConfluence: pickInputId(inputs, ['min', 'confluence'], 'in_31'),
    useAsiaLevels: pickInputId(inputs, ['use', 'asia'], 'in_15'),
    useLondonLevels: pickInputId(inputs, ['use', 'london'], 'in_16'),
    useIBLevels: pickInputId(inputs, ['use', 'ib'], 'in_17'),
    useCBDRLevels: pickInputId(inputs, ['use', 'cbdr'], 'in_18'),
    usePDHLLevels: pickInputId(inputs, ['use', 'prev', 'day'], 'in_19'),
    useMidnightLevel: pickInputId(inputs, ['use', 'midnight'], 'in_20'),
    show1HLevels: pickInputId(inputs, ['show', '1h', 'swing'], 'in_32'),
  };
  console.error('[cbc-htf-grid] resolved input ids:', JSON.stringify(ids));
  return ids;
}

function addAxisIfResolved(grid, id, values, label) {
  if (!id) {
    console.error(`[cbc-htf-grid] warn: could not resolve id for "${label}" — axis skipped`);
    return;
  }
  grid[id] = values;
}

function cliArg(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return null;
}

function cliFlag(name) {
  return process.argv.includes(name);
}

function applyTestProfile(profileRaw) {
  const p = (profileRaw || '').trim().toLowerCase();
  if (!p) return;
  if (p === 'smoke') {
    if (process.env.CBC_CHART_TFS === undefined) process.env.CBC_CHART_TFS = '5';
    if (process.env.GRID_MAX_RUNS === undefined) process.env.GRID_MAX_RUNS = '12';
    if (process.env.CBC_SWEEP_GRID === undefined) process.env.CBC_SWEEP_GRID = '1';
    if (process.env.CBC_LEVELS_GRID === undefined) process.env.CBC_LEVELS_GRID = '0';
    console.error('[cbc-htf-grid] profile=smoke (fast sanity run)');
    return;
  }
  if (p === 'levels300') {
    if (process.env.CBC_CHART_TFS === undefined) process.env.CBC_CHART_TFS = '3,5,15';
    if (process.env.GRID_MAX_RUNS === undefined) process.env.GRID_MAX_RUNS = '300';
    if (process.env.CBC_SWEEP_GRID === undefined) process.env.CBC_SWEEP_GRID = '1';
    if (process.env.CBC_LEVELS_GRID === undefined) process.env.CBC_LEVELS_GRID = '1';
    console.error('[cbc-htf-grid] profile=levels300 (all-level family toggles + sweep axes)');
    return;
  }
  console.error(`[cbc-htf-grid] unknown CBC_TEST_PROFILE="${profileRaw}" (ignored)`);
}

function main() {
  const profileArg = cliArg('--profile');
  if (profileArg && process.env.CBC_TEST_PROFILE === undefined) {
    process.env.CBC_TEST_PROFILE = profileArg;
  }
  if (cliFlag('--verify') && process.env.CBC_VERIFY === undefined) {
    process.env.CBC_VERIFY = '1';
  }
  applyTestProfile(process.env.CBC_TEST_PROFILE);
  preflight();
  let entity = resolveStrategyEntity();
  const baselineInfo = tvJson(['indicator', 'get', entity]);
  if (!baselineInfo.success) throw new Error('indicator get failed');
  const baseline = inputsMapFromGet(baselineInfo);
  const ids = resolveGridInputIds(baselineInfo);
  // Prevent "zero trades / empty report" during optimization by relaxing hard gates.
  // These are CBC v2 source-order ids and are only applied when present on chart.
  const permissiveBase = {
    in_2: false,   // requireTrend
    in_3: false,   // requireHTFAlign (grid may override this axis)
    in_31: 1,      // minConfluence
    in_58: false,  // useATRGate
    in_63: false,  // useRangeQuality
    in_77: false,  // useSession
    in_103: false, // useKillzones
  };
  const usePermissiveBase = process.env.CBC_FORCE_PERMISSIVE_BASE === '0' ? false : true;

  if (process.env.CBC_VERIFY === '1') {
    verifyAndExit(entity, ids);
  }

  const chartTfs = (process.env.CBC_CHART_TFS || '3,5,15')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const grid = {
    [ids.requireHtfAlign]: [true, false],
    [ids.htfBiasTf]: ['5', '10', '15', '30'],
    [ids.h1SwingTf]: ['30', '60'],
  };
  if (process.env.CBC_SWEEP_GRID === '1') {
    grid[ids.sweepThreshold] = [0.35, 0.5, 0.65];
    grid[ids.minConfluence] = [2, 3];
  }
  if (process.env.CBC_LEVELS_GRID === '1') {
    addAxisIfResolved(grid, ids.useAsiaLevels, [true, false], 'useAsiaLevels');
    addAxisIfResolved(grid, ids.useLondonLevels, [true, false], 'useLondonLevels');
    addAxisIfResolved(grid, ids.useIBLevels, [true, false], 'useIBLevels');
    addAxisIfResolved(grid, ids.useCBDRLevels, [true, false], 'useCBDRLevels');
    addAxisIfResolved(grid, ids.usePDHLLevels, [true, false], 'usePDHLLevels');
    addAxisIfResolved(grid, ids.useMidnightLevel, [true, false], 'useMidnightLevel');
    addAxisIfResolved(grid, ids.show1HLevels, [true, false], 'show1HLevels');
  }

  let scenarios = [];
  for (const chartTf of chartTfs) {
    for (const row of cartesian(grid)) {
      scenarios.push({ chartTf, overrides: { ...row } });
    }
  }

  const maxRuns = Number(process.env.GRID_MAX_RUNS || 300);
  if (scenarios.length > maxRuns) {
    console.error(`[cbc-htf-grid] truncating ${scenarios.length} → ${maxRuns} (GRID_MAX_RUNS)`);
    scenarios = scenarios.slice(0, maxRuns);
  }

  console.error(
    `[cbc-htf-grid] runs=${scenarios.length} | safe=${SAFE} | delayMs=${DELAY_MS} | tfSettleMs=${TF_SETTLE_MS} | postTfMs=${POST_TF_MS} | gapMs=${SCENARIO_GAP_MS} | cooldownMs=${COOLDOWN_ON_BAD_MS} | stallEvery=${STALL_EVERY_N} | entity=${entity}`
  );

  console.error(`[cbc-htf-grid] pre-grid settle ${PRE_GRID_SETTLE_MS}ms (let Strategy Tester finish one pass)`);
  sleepMs(PRE_GRID_SETTLE_MS);
  waitForReportReady('pre-grid');

  const results = [];
  let consecutiveBad = 0;

  for (let i = 0; i < scenarios.length; i++) {
    const { chartTf, overrides } = scenarios[i];
    const label = `#${i} tf${chartTf}`;

    if (STALL_EVERY_N > 0 && i > 0 && i % STALL_EVERY_N === 0) {
      console.error(`[cbc-htf-grid] periodic stall after scenario ${i} (${STALL_MS}ms)`);
      sleepMs(STALL_MS);
    }

    const currentRes = getChartResolution();
    const want = String(chartTf);
    const sameTf = String(currentRes) === want;

    try {
      if (!sameTf) {
        execTv(['timeframe', chartTf], `timeframe ${chartTf}`);
        sleepMs(TF_SETTLE_MS);
      } else {
        sleepMs(TF_SKIP_SETTLE_MS);
      }
    } catch (e) {
      console.error(`[cbc-htf-grid] timeframe ${chartTf} failed:`, e?.message || e);
      sleepMs(COOLDOWN_ON_BAD_MS);
    }

    sleepMs(POST_TF_MS);

    const merged = usePermissiveBase ? { ...baseline, ...permissiveBase, ...overrides } : { ...baseline, ...overrides };
    const setRes = indicatorSetWithRetries(entity, merged, label);
    if (setRes.entity && setRes.entity !== entity) entity = setRes.entity;
    if (!setRes.ok) {
      consecutiveBad++;
      const extra = COOLDOWN_ON_BAD_MS * Math.min(6, consecutiveBad);
      console.error(`[cbc-htf-grid] ${label}: indicator set exhausted — long cooldown ${extra}ms`);
      sleepMs(extra);
      console.log(
        JSON.stringify({
          n: i,
          chartTf,
          overrides,
          error: 'indicator_set',
          metrics: null,
        })
      );
      if (SCENARIO_GAP_MS) sleepMs(SCENARIO_GAP_MS);
      continue;
    }

    sleepMs(DELAY_MS);

    const data = fetchStrategyMetricsStable(label);
    const metrics = data.metrics || (data.result && data.result.metrics) || {};
    const slim = slimMetrics(metrics);
    const errStr = `${data?.error || ''}`;
    const healthy =
      data.success !== false &&
      !data.error &&
      !looksLikeTvOverload(errStr) &&
      slim &&
      Object.keys(slim).length > 0;

    if (healthy) {
      consecutiveBad = 0;
    } else {
      consecutiveBad++;
      const extra = COOLDOWN_ON_BAD_MS * Math.min(6, consecutiveBad);
      console.error(
        `[cbc-htf-grid] ${label}: weak or missing metrics / error — extra cooldown ${extra}ms (streak ${consecutiveBad})`
      );
      sleepMs(extra);
    }

    const line = {
      n: i,
      chartTf,
      overrides,
      success: data.success !== false && !data.error,
      error: data.error || null,
      metrics: slim,
    };
    console.log(JSON.stringify(line));
    if (line.metrics && typeof line.metrics.netProfit === 'number') {
      results.push({ n: i, chartTf, overrides, netProfit: line.metrics.netProfit, metrics: line.metrics });
    }

    if (SCENARIO_GAP_MS) sleepMs(SCENARIO_GAP_MS);
  }

  results.sort((a, b) => b.netProfit - a.netProfit);
  const top = results.slice(0, 8);
  console.error('[cbc-htf-grid] top by netProfit:', JSON.stringify(top, null, 2));
  if (top.length > 0) {
    const best = top[0];
    try {
      execTv(['timeframe', String(best.chartTf)], 'apply best timeframe');
      sleepMs(TF_SETTLE_MS);
      const bestMerged = usePermissiveBase ? { ...baseline, ...permissiveBase, ...best.overrides } : { ...baseline, ...best.overrides };
      const apply = indicatorSetWithRetries(entity, bestMerged, 'apply-best');
      if (apply.entity && apply.entity !== entity) entity = apply.entity;
      if (apply.ok) {
        console.error(`[cbc-htf-grid] applied best settings to chart entity=${entity} tf=${best.chartTf}`);
      } else {
        console.error('[cbc-htf-grid] warning: could not apply best settings after grid');
      }
    } catch (e) {
      console.error('[cbc-htf-grid] warning: failed to apply best settings:', e?.message || e);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(root, `cbc-htf-grid-${stamp}.json`);
  try {
    writeFileSync(outPath, JSON.stringify({ entity, scenarios: results.length, top, chart_tfs: chartTfs }, null, 2), 'utf8');
    console.error(`[cbc-htf-grid] wrote ${outPath}`);
  } catch (e) {
    console.error('[cbc-htf-grid] could not write summary file:', e?.message || e);
  }
}

try {
  main();
} catch (e) {
  console.error('[cbc-htf-grid] fatal:', e?.message || e);
  process.exit(2);
}
