/**
 * Stability battery for MACD CHOCH/BOS advisor + strategy:
 * - Offline static analysis (pine analyze rules)
 * - Repeated TV pine-facade compile (pine check) for flaky API / warning drift
 * - Strategy file hash unchanged after build_sniper_strategy.mjs (advisor is source of truth)
 */
import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { check, analyze } from '../src/core/pine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const ADVISOR = join(ROOT, 'CHOCH_BOS_MACD_Market_Structure_advisor.pine');
const STRATEGY = join(ROOT, 'CHOCH_BOS_MACD_Sniper_Strategy.pine');
const BUILD_MJS = join(ROOT, 'build_sniper_strategy.mjs');

const CHECK_ROUNDS = Number(process.env.STABILITY_CHECK_ROUNDS || 12);

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

async function runCheckBattery(label, path) {
  const source = readFileSync(path, 'utf8');
  const staticResult = analyze({ source });
  const rounds = [];
  let minMs = Infinity;
  let maxMs = 0;
  for (let i = 0; i < CHECK_ROUNDS; i++) {
    const t0 = performance.now();
    const r = await check({ source });
    const ms = Math.round(performance.now() - t0);
    minMs = Math.min(minMs, ms);
    maxMs = Math.max(maxMs, ms);
    const row = {
      i: i + 1,
      compiled: r.compiled,
      errors: r.error_count,
      warnings: r.warning_count,
      ms,
    };
    if (!r.compiled) row.detail = r.errors;
    rounds.push(row);
  }
  const failed = rounds.filter((x) => !x.compiled || x.errors > 0);
  const warnDrift = new Set(rounds.map((x) => x.warnings)).size > 1;
  return {
    label,
    path,
    bytes: source.length,
    lines: source.split('\n').length,
    sha256: sha256(source),
    analyze: {
      issue_count: staticResult.issue_count,
      diagnostics: staticResult.diagnostics,
    },
    check_rounds: rounds,
    check_consistent: failed.length === 0 && rounds.every((x) => x.warnings === rounds[0].warnings),
    timing_ms: { min: minMs, max: maxMs, rounds: CHECK_ROUNDS },
    warning_drift_across_rounds: warnDrift,
  };
}

function requireFiles() {
  const missing = [ADVISOR, STRATEGY, BUILD_MJS].filter((p) => !existsSync(p));
  if (missing.length)
    throw new Error(`missing_files: ${missing.join('; ')}`);
}

function rebuildStrategy() {
  execFileSync(process.execPath, [BUILD_MJS], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

requireFiles();

async function main() {
  const report = {
    generated_at: new Date().toISOString(),
    check_rounds_per_file: CHECK_ROUNDS,
    advisor: await runCheckBattery('advisor (indicator)', ADVISOR),
    strategy: await runCheckBattery('strategy (before rebuild)', STRATEGY),
  };

  const hashBefore = report.strategy.sha256;
  rebuildStrategy();
  const strategyAfter = readFileSync(STRATEGY, 'utf8');
  const hashAfter = sha256(strategyAfter);
  report.strategy_rebuild = {
    sha256_before: hashBefore,
    sha256_after: hashAfter,
    idempotent: hashAfter === hashBefore,
  };

  if (!report.strategy_rebuild.idempotent) {
    const r = await check({ source: strategyAfter });
    report.strategy_after_rebuild_single_check = {
      compiled: r.compiled,
      error_count: r.error_count,
      warning_count: r.warning_count,
      errors: r.errors,
      warnings: r.warnings,
    };
  }

  const compilesClean = (bat) =>
    bat.analyze.issue_count === 0 &&
    bat.check_consistent &&
    bat.check_rounds.every((x) => x.compiled && x.warnings === 0);

  report.summary = {
    advisor_ok: compilesClean(report.advisor),
    strategy_ok: compilesClean(report.strategy),
    rebuild_idempotent: report.strategy_rebuild.idempotent,
    all_pass:
      compilesClean(report.advisor) &&
      compilesClean(report.strategy) &&
      report.strategy_rebuild.idempotent,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.summary.all_pass ? 0 : 1;
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
