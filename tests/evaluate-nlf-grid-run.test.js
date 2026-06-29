/**
 * Evaluator smoke test — runs CLI on a tiny fixture (no TradingView).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const fixtureDir = join(ROOT, 'tests', 'fixtures', 'nlf_eval_mini');
const script = join(ROOT, 'scripts', 'evaluate-nlf-grid-run.mjs');
const outReport = join(fixtureDir, 'evaluation_report.json');

describe('evaluate-nlf-grid-run', () => {
  it('writes evaluation_report.json with expected shape', () => {
    if (existsSync(outReport)) unlinkSync(outReport);

    const r = spawnSync(process.execPath, [script, fixtureDir], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);

    assert.ok(existsSync(outReport), 'evaluation_report.json created');
    const rep = JSON.parse(readFileSync(outReport, 'utf8'));

    assert.equal(rep.schema_version, 1);
    assert.equal(rep.data_quality.row_count_total, 3);
    assert.equal(rep.data_quality.row_count_executor_errors, 1);
    assert.equal(rep.feasibility.met_constraint_count, 1);
    assert.ok(Array.isArray(rep.hypothesis_buckets_marginal.by_minBarsBetween));

    unlinkSync(outReport);
  });
});
