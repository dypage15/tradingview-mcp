#!/usr/bin/env node
/**
 * Autonomous 300-run: riskier stop/TP ticks + trail offset + risk%, merged from 6×50 slices.
 * Clears checkpoint; writes MERGED JSON + lightweight insights for tuning defaults.
 */
import { spawnSync } from 'node:child_process';
import { unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHILD = join(ROOT, 'scripts', 'run-sec-ticks-risk-trail-300.mjs');
const CHECKPOINT = join(ROOT, 'data', 'sec_ticks_risk_trail_300_checkpoint.json');
const BUF = 80 * 1024 * 1024;

const SLICES = [
  [0, 50],
  [50, 100],
  [100, 150],
  [150, 200],
  [200, 250],
  [250, 300],
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
const mergedPath = join(ROOT, 'data', `sec_ticks_risk_trail_300_MERGED_${ts}.json`);

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
    console.error(JSON.stringify({ success: false, slice: `${a}:${b}`, status: r.status, stderr: err, stdout: out.slice(-3000) }, null, 2));
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

const top15 = allRows.slice(0, 15);
const learn = {
  best: allRows[0] || null,
  medianTop15: top15.length
    ? {
        in_6: median(top15.map((r) => r.in_6)),
        in_7: median(top15.map((r) => r.in_7)),
        in_11: median(top15.map((r) => r.in_11)),
        in_1: median(top15.map((r) => r.in_1)),
      }
    : null,
  priorBaselineNet: 3545.6,
  priorBaselineNote: 'Approx. best net from earlier entry-only grid (NQ 5m, same chart epoch may differ).',
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

if (existsSync(CHECKPOINT)) {
  try {
    unlinkSync(CHECKPOINT);
  } catch {
    /* ignore */
  }
}

console.log(JSON.stringify({ success: true, mergedPath, count: allRows.length, learn }, null, 2));
