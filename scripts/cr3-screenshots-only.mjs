#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as capture from '../src/core/capture.js';

const runDir = process.argv[2];
if (!runDir) {
  console.error('Usage: node cr3-screenshots-only.mjs <runDir>');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csv = readFileSync(join(runDir, 'trades.csv'), 'utf8');
const days = [...new Set(csv.split('\n').slice(1).map((l) => l.split(',')[3]).filter(Boolean))].sort();
const screenshotDays = days.slice(-12);
const stamp = runDir.split('_').slice(-2).join('_');
const shotDir = join(runDir, 'screenshots');
mkdirSync(shotDir, { recursive: true });

await health.healthCheck();
const screenshotPaths = [];
for (const day of screenshotDays) {
  await chart.scrollToDate({ date: day });
  await sleep(3000);
  const fname = `cr3_review_${stamp}_day_${day}`;
  const res = await capture.captureScreenshot({ region: 'chart', filename: fname });
  const dest = join(shotDir, `day_${day}.png`);
  if (res?.file_path) copyFileSync(res.file_path, dest);
  screenshotPaths.push({ day, path: dest });
  await sleep(500);
}
writeFileSync(join(runDir, 'screenshot_manifest.json'), JSON.stringify(screenshotPaths, null, 2));
console.log(JSON.stringify({ screenshotDays, screenshotPaths }, null, 2));
await disconnect().catch(() => {});
