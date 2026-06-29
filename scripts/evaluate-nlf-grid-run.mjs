#!/usr/bin/env node
/**
 * Measurement substrate for NLF 300 grid outputs: distributions, baseline reference,
 * data-quality gates, and marginal "hypothesis" buckets over tuner dimensions.
 *
 * Usage:
 *   node scripts/evaluate-nlf-grid-run.mjs [path/to/grid_run_dir]
 *   NLF_EVAL_RUN_DIR=... node scripts/evaluate-nlf-grid-run.mjs
 *
 * Reads:
 *   scenarios.ndjson (required)
 *   summary.json, input_manifest.json (optional)
 *
 * Writes:
 *   evaluation_report.json in the run directory
 *
 * npm: npm run nlf:eval-run
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const DEFAULT_STRATEGY_FILE = join(ROOT, 'data', 'erl-irl-engine-strategy.pine');

function readNdjson(path) {
  const raw = readFileSync(path, 'utf8');
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      rows.push({ _parse_error: true, _raw: t.slice(0, 200) });
    }
  }
  return rows;
}

function mean(a) {
  if (!a.length) return NaN;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function stddev(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v);
}

/** Sorted ascending numeric array; linear interpolation quantiles. Keys: p0.01, p0.5, ... */
function quantiles(values, ps = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]) {
  const xs = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return {};
  const out = {};
  for (const p of ps) {
    if (p < 0 || p > 1) continue;
    const pos = (n - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const w = pos - lo;
    const q = lo === hi ? xs[lo] : xs[lo] * (1 - w) + xs[hi] * w;
    out[`p${p}`] = q;
  }
  return out;
}

function parsePineTunerDefaults(pinePath) {
  if (!existsSync(pinePath)) return null;
  const src = readFileSync(pinePath, 'utf8');
  const mb = src.match(/^\s*minBarsBetween\s*=\s*input\.int\(\s*(\d+)/m);
  const mc = src.match(/^\s*minScoreCont\s*=\s*input\.int\(\s*(\d+)/m);
  const mr = src.match(/^\s*minScoreRev\s*=\s*input\.int\(\s*(\d+)/m);
  if (!mb || !mc || !mr) return null;
  return {
    minBarsBetween: Number(mb[1]),
    minScoreCont: Number(mc[1]),
    minScoreRev: Number(mr[1]),
  };
}

function specDistance(a, b) {
  if (!a || !b) return Infinity;
  return (
    Math.abs((a.minBarsBetween ?? 0) - (b.minBarsBetween ?? 0)) +
    Math.abs((a.minScoreCont ?? 0) - (b.minScoreCont ?? 0)) +
    Math.abs((a.minScoreRev ?? 0) - (b.minScoreRev ?? 0))
  );
}

function findScenario(rows, pred) {
  for (const r of rows) {
    if (r.spec && pred(r)) return r;
  }
  return null;
}

function nearestBySpec(rows, target) {
  let best = null;
  let bestD = Infinity;
  for (const r of rows) {
    if (!r.spec || r.error) continue;
    const d = specDistance(r.spec, target);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best ? { row: best, L1_distance: bestD } : null;
}

function groupByField(rows, fieldName, valueFn) {
  const m = new Map();
  for (const r of rows) {
    if (r.error || !r.spec) continue;
    const v = valueFn(r);
    if (!Number.isFinite(v) && typeof v !== 'string') continue;
    const k = String(v);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function marginalStats(name, rows) {
  const np = rows.map((r) => r.netProfit).filter(Number.isFinite);
  const feas = rows.filter((r) => r.metConstraint === true).length;
  return {
    bucket_dimension: name,
    n: rows.length,
    feasible_count: feas,
    feasible_rate: rows.length ? feas / rows.length : NaN,
    mean_net_profit: mean(np),
    median_net_profit: np.length ? quantiles(np, [0.5])['p0.5'] : NaN,
    min_net_profit: np.length ? Math.min(...np) : NaN,
    max_net_profit: np.length ? Math.max(...np) : NaN,
  };
}

function uniqueFinite(values) {
  return [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
}

function findLatestRunDir() {
  const base = join(ROOT, 'data', 'grid_runs');
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base).filter((d) => /^nlf_erl_300_/.test(d));
  if (!dirs.length) return null;
  const scored = dirs.map((d) => {
    const p = join(base, d);
    try {
      return { d, mtime: statSync(p).mtimeMs };
    } catch {
      return { d, mtime: 0 };
    }
  });
  scored.sort((a, b) => b.mtime - a.mtime);
  return join(base, scored[0].d);
}

async function main() {
  const argDir = process.argv[2];
  const fromEnv = (process.env.NLF_EVAL_RUN_DIR || '').trim();
  const runDir = resolve(argDir || fromEnv || findLatestRunDir() || '');
  if (!runDir || !existsSync(runDir)) {
    console.error(
      JSON.stringify({
        success: false,
        error: 'No grid run directory. Pass path, set NLF_EVAL_RUN_DIR, or ensure data/grid_runs/nlf_erl_300_* exists.',
      }),
    );
    process.exit(1);
  }

  const ndPath = join(runDir, 'scenarios.ndjson');
  if (!existsSync(ndPath)) {
    console.error(JSON.stringify({ success: false, error: `Missing ${ndPath}` }));
    process.exit(1);
  }

  const summaryPath = join(runDir, 'summary.json');
  const manifestPath = join(runDir, 'input_manifest.json');
  const pinePath = (process.env.NLF_EVAL_PINE_FILE || DEFAULT_STRATEGY_FILE).trim();

  const rows = readNdjson(ndPath);
  let summary = null;
  let manifest = null;
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  } catch {
    summary = null;
  }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = null;
  }

  const pineDefaults = parsePineTunerDefaults(pinePath);

  const errorRows = rows.filter((r) => r.error !== undefined);
  const okRows = rows.filter((r) => r.error === undefined);
  const metricsRows = okRows.filter((r) => typeof r.netProfit === 'number' && Number.isFinite(r.netProfit));
  const feasibleRows = metricsRows.filter((r) => r.metConstraint === true);

  const reportReadyFalse = metricsRows.filter((r) => r.report_ready === false).length;
  const spans = uniqueFinite(metricsRows.map((r) => r.calendar_days_trade_span));
  const strategies = [...new Set(metricsRows.map((r) => r.strategy_name).filter(Boolean))];

  const netProfits = metricsRows.map((r) => r.netProfit);
  const profitFactors = metricsRows.map((r) => r.profitFactor).filter(Number.isFinite);
  const tpd = metricsRows.map((r) => r.tradesPerCalendarDay).filter(Number.isFinite);
  const trades = metricsRows.map((r) => r.totalTrades).filter(Number.isFinite);

  const feasibleNp = feasibleRows.map((r) => r.netProfit);

  let exactBaseline = pineDefaults
    ? findScenario(
        metricsRows,
        (r) =>
          r.spec &&
          r.spec.minBarsBetween === pineDefaults.minBarsBetween &&
          r.spec.minScoreCont === pineDefaults.minScoreCont &&
          r.spec.minScoreRev === pineDefaults.minScoreRev,
      )
    : null;

  const nearestPine = pineDefaults ? nearestBySpec(metricsRows, pineDefaults) : null;

  const gridCorner = findScenario(metricsRows, (r) => r.scenarioId === 0) || metricsRows[0] || null;

  const byMb = groupByField(metricsRows, 'minBarsBetween', (r) => r.spec.minBarsBetween);
  const byMc = groupByField(metricsRows, 'minScoreCont', (r) => r.spec.minScoreCont);
  const byMr = groupByField(metricsRows, 'minScoreRev', (r) => r.spec.minScoreRev);

  const marginal_minBarsBetween = [...byMb.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, arr]) => ({ value: Number(k), ...marginalStats('minBarsBetween', arr) }));
  const marginal_minScoreCont = [...byMc.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, arr]) => ({ value: Number(k), ...marginalStats('minScoreCont', arr) }));
  const marginal_minScoreRev = [...byMr.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, arr]) => ({ value: Number(k), ...marginalStats('minScoreRev', arr) }));

  const report = {
    schema_version: 1,
    evaluator: 'evaluate-nlf-grid-run',
    generated_at: new Date().toISOString(),
    run_directory: runDir,
    inputs: {
      scenarios_ndjson: ndPath,
      summary_json: existsSync(summaryPath) ? summaryPath : null,
      input_manifest_json: existsSync(manifestPath) ? manifestPath : null,
      pine_defaults_file: existsSync(pinePath) ? pinePath : null,
    },
    measurement_contract: {
      primary_objective: 'netProfit (Strategy Tester, grid scenario)',
      feasibility_flag: 'metConstraint (includes min trades/calendar day + finite metrics when grid sets them)',
      note: 'Per-trade filter conditioning requires exporting trades and labels from Pine/TV; this report uses scenario-level tuner buckets only.',
    },
    pine_file_tuner_defaults: pineDefaults,
    baseline_reference: {
      description:
        'pine_file_tuner_defaults: values from data/erl-irl-engine-strategy.pine input.int(...) lines. ' +
        'exact_pine_default_match: scenario with identical spec (often absent if grid omits that cell). ' +
        'nearest_spec_to_pine_defaults: smallest L1 distance in {mb,mc,mr} among successful metric rows. ' +
        'grid_corner_scenarioId_0: first NLF grid cell (not the same as Pine defaults).',
      exact_pine_default_match: exactBaseline
        ? { scenarioId: exactBaseline.scenarioId, spec: exactBaseline.spec, netProfit: exactBaseline.netProfit }
        : null,
      nearest_spec_to_pine_defaults: nearestPine
        ? {
            scenarioId: nearestPine.row.scenarioId,
            spec: nearestPine.row.spec,
            L1_distance: nearestPine.L1_distance,
            netProfit: nearestPine.row.netProfit,
            metConstraint: nearestPine.row.metConstraint,
          }
        : null,
      grid_corner_scenarioId_0: gridCorner
        ? { scenarioId: gridCorner.scenarioId, spec: gridCorner.spec, netProfit: gridCorner.netProfit }
        : null,
    },
    data_quality: {
      row_count_total: rows.length,
      row_count_parse_errors: rows.filter((r) => r._parse_error).length,
      row_count_executor_errors: errorRows.length,
      row_count_with_numeric_net_profit: metricsRows.length,
      report_ready_false_among_metric_rows: reportReadyFalse,
      unique_calendar_days_trade_span: spans,
      span_drift_warning:
        spans.length > 1
          ? 'Multiple Tester trade-window lengths — compare scenarios only with same span, or fix capture.'
          : null,
      strategy_names_seen: strategies,
    },
    distributions: {
      all_metric_rows: {
        n: netProfits.length,
        net_profit: { mean: mean(netProfits), stddev: stddev(netProfits), ...quantiles(netProfits) },
        profit_factor: { mean: mean(profitFactors), ...quantiles(profitFactors) },
        trades_per_calendar_day: { mean: mean(tpd), ...quantiles(tpd) },
        total_trades: { mean: mean(trades), ...quantiles(trades) },
      },
      feasible_only_met_constraint: {
        n: feasibleNp.length,
        net_profit: { mean: mean(feasibleNp), stddev: stddev(feasibleNp), ...quantiles(feasibleNp) },
      },
    },
    feasibility: {
      metric_rows: metricsRows.length,
      met_constraint_count: feasibleRows.length,
      met_constraint_rate: metricsRows.length ? feasibleRows.length / metricsRows.length : NaN,
      summary_best_net_profit: summary?.best_overall_met_constraint?.netProfit ?? null,
    },
    hypothesis_buckets_marginal: {
      by_minBarsBetween: marginal_minBarsBetween,
      by_minScoreCont: marginal_minScoreCont,
      by_minScoreRev: marginal_minScoreRev,
    },
    raw_errors_sample: errorRows.slice(0, 8).map((r) => ({ scenarioId: r.scenarioId, error: r.error })),
  };

  const outPath = join(runDir, 'evaluation_report.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(
    JSON.stringify(
      {
        success: true,
        wrote: outPath.replace(/\\/g, '/'),
        run_directory: runDir.replace(/\\/g, '/'),
        metric_rows: metricsRows.length,
        feasible_rows: feasibleRows.length,
        pine_defaults_matched_exactly: !!exactBaseline,
        median_net_profit_all: quantiles(netProfits, [0.5])['p0.5'],
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ success: false, error: e.message }));
  process.exit(1);
});
