#!/usr/bin/env node
/**
 * Fully autonomous exit grid: runs 6 sequential slices (50 scenarios each) so each
 * `tv` subprocess exits cleanly (fewer host timeouts than one 300× loop process).
 * Merges results, writes a single ranked JSON + clears checkpoint.
 *
 * Usage: node scripts/run-sec-ticks-exits-autonomous.mjs
 */
import { spawnSync } from 'node:child_process';
import { unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHILD = join(ROOT, 'scripts', 'run-sec-ticks-exits-300.mjs');
const CHECKPOINT = join(ROOT, 'data', 'sec_ticks_exits_300_checkpoint.json');
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
const mergedPath = join(ROOT, 'data', `sec_ticks_exits_300_MERGED_${ts}.json`);

const sliceMeta = [];
const allRows = [];

for (const [a, b] of SLICES) {
  const env = { ...process.env, GRID_SLICE: `${a}:${b}` };
  delete env.RESUME;
  const r = spawnSync(process.execPath, [CHILD], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: BUF,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const err = (r.stderr || '').trim();
  const out = (r.stdout || '').trim();
  if (r.status !== 0) {
    console.error(JSON.stringify({ success: false, slice: `${a}:${b}`, status: r.status, stderr: err, stdoutTail: out.slice(-2000) }, null, 2));
    process.exit(r.status || 1);
  }
  let summary;
  try {
    summary = JSON.parse(out);
  } catch (e) {
    console.error(JSON.stringify({ success: false, slice: `${a}:${b}`, parseError: String(e), stdout: out.slice(0, 4000) }, null, 2));
    process.exit(1);
  }
  sliceMeta.push({ slice: `${a}:${b}`, ...summary });
  const body = JSON.parse(readFileSync(summary.outPath, 'utf8'));
  const rows = body.all || [];
  for (const row of rows) allRows.push(row);
}

function scoreRow(m) {
  const np = m.netProfit ?? -Infinity;
  const dd = Number(m.maxStrategyDrawDownPercent ?? m.maxDrawdownPercent ?? 0);
  const ddSafe = Number.isFinite(dd) ? dd : 0;
  const pf = m.profitFactor ?? 0;
  const n = m.totalTrades ?? 0;
  if (n < 6) return np - 800;
  return np - 42 * ddSafe + 0.06 * pf * Math.sign(np) * Math.min(Math.abs(np), 8000);
}

for (const row of allRows) {
  if (typeof row.score !== 'number' || Number.isNaN(row.score)) {
    const m = {
      netProfit: row.netProfit,
      maxStrategyDrawDownPercent: row.maxStrategyDrawDownPercent,
      profitFactor: row.profitFactor,
      totalTrades: row.totalTrades,
    };
    row.score = scoreRow(m);
  }
}

allRows.sort((a, b) => b.score - a.score);
const top = allRows.slice(0, 25);

writeFileSync(
  mergedPath,
  JSON.stringify(
    {
      success: true,
      generatedAt: new Date().toISOString(),
      mergedPath,
      slices: sliceMeta,
      count: allRows.length,
      top25: top,
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

console.log(
  JSON.stringify(
    {
      success: true,
      mergedPath,
      totalRows: allRows.length,
      best: top[0] || null,
      top5: top.slice(0, 5),
    },
    null,
    2
  )
);
