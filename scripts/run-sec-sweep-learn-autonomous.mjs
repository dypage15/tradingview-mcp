#!/usr/bin/env node
/**
 * Autonomous 800-run: London vs IB sweep sources + TP/stop grid, merged from 8×100 slices.
 * Clears checkpoint; writes MERGED JSON + learn hints for the next manual grid tightening.
 *
 * Env:
 *   LEARN_STATE=1 — write data/sec_sweep_london_ib_learn_state.json (median top-20 axes + mode preference)
 */
import { spawnSync } from 'node:child_process';
import { unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHILD = join(ROOT, 'scripts', 'run-sec-sweep-london-ib-800.mjs');
const CHECKPOINT = join(ROOT, 'data', 'sec_sweep_london_ib_800_checkpoint.json');
const LEARN_PATH = join(ROOT, 'data', 'sec_sweep_london_ib_learn_state.json');
const BUF = 80 * 1024 * 1024;

const SLICES = [
  [0, 100],
  [100, 200],
  [200, 300],
  [300, 400],
  [400, 500],
  [500, 600],
  [600, 700],
  [700, 800],
];

if (existsSync(CHECKPOINT)) {
  try {
    unlinkSync(CHECKPOINT);
  } catch {
    /* ignore */
  }
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const mergedPath = join(ROOT, 'data', `sec_sweep_london_ib_800_MERGED_${ts}.json`);

const sliceMeta = [];
const allRows = [];

for (const [a, b] of SLICES) {
  const r = spawnSync(process.execPath, [CHILD], {
    cwd: ROOT,
    env: { ...process.env, GRID_SLICE: `${a}:${b}` },
    encoding: 'utf8',
    maxBuffer: BUF,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const err = (r.stderr || '').trim();
  const out = (r.stdout || '').trim();
  if (r.status !== 0) {
    console.error(
      JSON.stringify(
        { success: false, slice: `${a}:${b}`, status: r.status, stderr: err.slice(-4000), stdout: out.slice(-3000) },
        null,
        2
      )
    );
    process.exit(r.status || 1);
  }
  let summary;
  try {
    summary = JSON.parse(out);
  } catch (e) {
    console.error(JSON.stringify({ success: false, slice: `${a}:${b}`, parseError: String(e), stdout: out.slice(0, 5000) }, null, 2));
    process.exit(1);
  }
  sliceMeta.push({ slice: `${a}:${b}`, ...summary });
  const body = JSON.parse(readFileSync(summary.outPath, 'utf8'));
  for (const row of body.all || []) allRows.push(row);
}

allRows.sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9));
const top = allRows.slice(0, 40);

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function mean(nums) {
  const x = nums.filter((v) => Number.isFinite(v));
  if (!x.length) return null;
  return x.reduce((s, v) => s + v, 0) / x.length;
}

const top20 = allRows.slice(0, 20);
const londonRows = allRows.filter((r) => r.sweepMode === 1);
const ibRows = allRows.filter((r) => r.sweepMode === 2);

const learn = {
  best: allRows[0] || null,
  medianTop20: top20.length
    ? {
        in_5: median(top20.map((r) => r.in_5)),
        in_25: median(top20.map((r) => r.in_25)),
        in_6: median(top20.map((r) => r.in_6)),
        in_7: median(top20.map((r) => r.in_7)),
        sweepMode: median(top20.map((r) => r.sweepMode)),
      }
    : null,
  avgScoreBySweepMode: {
    london_1: mean(londonRows.map((r) => r.score)),
    ib_2: mean(ibRows.map((r) => r.score)),
  },
  suggestedNextGrid: top20.length
    ? {
        note: 'Narrow arrays around medians; keep 800 factorial shape or switch to finer step on in_7/in_6 only.',
        in_7_tpLegTicks_suggest: [
          Math.max(120, Math.round(median(top20.map((r) => r.in_7))) - 20),
          Math.round(median(top20.map((r) => r.in_7))),
          Math.round(median(top20.map((r) => r.in_7))) + 20,
        ].filter((v, i, arr) => arr.indexOf(v) === i),
        in_6_stopTicks_suggest: [
          Math.max(28, Math.round(median(top20.map((r) => r.in_6))) - 8),
          Math.round(median(top20.map((r) => r.in_6))),
          Math.round(median(top20.map((r) => r.in_6))) + 8,
        ].filter((v, i, arr) => arr.indexOf(v) === i),
      }
    : null,
};

writeFileSync(
  mergedPath,
  JSON.stringify(
    {
      success: true,
      generatedAt: new Date().toISOString(),
      mergedPath,
      slices: sliceMeta,
      count: allRows.length,
      learn,
      top40: top,
      all: allRows,
    },
    null,
    2
  ),
  'utf8'
);

if (process.env.LEARN_STATE === '1') {
  writeFileSync(
    LEARN_PATH,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        sourceMerged: mergedPath,
        learn,
      },
      null,
      2
    ),
    'utf8'
  );
}

if (existsSync(CHECKPOINT)) {
  try {
    unlinkSync(CHECKPOINT);
  } catch {
    /* ignore */
  }
}

console.log(JSON.stringify({ success: true, mergedPath, count: allRows.length, learn }, null, 2));
