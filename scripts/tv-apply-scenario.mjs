#!/usr/bin/env node
/**
 * Apply one scenario from data/sweep_tv_scenarios_150.json to Secondary on chart.
 * Usage: node scripts/tv-apply-scenario.mjs [scenario_id=139]
 */
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tv = join(root, 'src/cli/index.js');
const BUF = 50 * 1024 * 1024;

const ENTRY_OPTIONS = new Set([
  'Reactive sweep (close)',
  'Reactive limit (swept level)',
  'Predictive limit (model)',
]);
const EXPECTED_ENTRY_IN = 52;
const PINE_MAX_EXCL = 63;

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

function resolveSecondaryEntity() {
  const ex = (process.env.TV_ENTITY_SECONDARY || '').trim();
  if (ex) return ex;
  const st = tvJson(['state']);
  const hit = (st.studies || []).find((s) => /secondary/i.test(s.name || ''));
  if (!hit) throw new Error('Secondary strategy not on chart.');
  return hit.id;
}

function detectEntryModeIndex(inputs) {
  for (const row of inputs || []) {
    if (!row || !/^in_\d+$/.test(row.id)) continue;
    if (ENTRY_OPTIONS.has(row.value)) return Number(row.id.slice(3));
  }
  return null;
}

function findDefaultQtyInputId(inputs) {
  const arr = (inputs || []).filter((i) => i && /^in_\d+$/.test(i.id));
  for (let i = 0; i < arr.length - 1; i++) {
    if (
      arr[i].value === 'fixed' &&
      typeof arr[i + 1].value === 'number' &&
      arr[i + 1].value >= 1 &&
      arr[i + 1].value <= 100
    ) {
      return arr[i + 1].id;
    }
  }
  return 'in_64';
}

function buildShiftedOverrides(tvInputsCanonical, shift, contracts, strategyQtyId) {
  const out = {};
  for (const [key, val] of Object.entries(tvInputsCanonical)) {
    const m = /^in_(\d+)$/.exec(key);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= PINE_MAX_EXCL) continue;
    if (n === 0) {
      if (shift === 0) out.in_0 = val;
      else out[strategyQtyId] = contracts;
      continue;
    }
    const nn = n + shift;
    if (nn < 0) continue;
    out[`in_${nn}`] = val;
  }
  return out;
}

const scenarioId = Number(process.argv[2] || 139);
const raw = JSON.parse(readFileSync(join(root, 'data', 'sweep_tv_scenarios_150.json'), 'utf8'));
const sc = (raw.scenarios || []).find((x) => x.id === scenarioId);
if (!sc) {
  console.error(`Scenario ${scenarioId} not found in sweep_tv_scenarios_150.json`);
  process.exit(1);
}

process.env.ADVISOR_STRATEGY_SUBSTRING = 'Secondary';
tvJson(['status']);
const entityId = resolveSecondaryEntity();
const ig = tvJson(['indicator', 'get', entityId]);
const entryN = detectEntryModeIndex(ig.inputs);
if (entryN == null) {
  console.error('Could not find Entry style input.');
  process.exit(1);
}
const shift = entryN - EXPECTED_ENTRY_IN;
const qtyId = findDefaultQtyInputId(ig.inputs);
const contracts = sc.contracts ?? sc.semantic?.contracts ?? 2;
const merged = buildShiftedOverrides(sc.tv_inputs, shift, contracts, qtyId);

console.error(
  JSON.stringify(
    { entityId, scenarioId, contracts, shift, entryModeIndex: entryN, qtyId, keysSet: Object.keys(merged).length },
    null,
    2
  )
);

const setResult = tvJson(['indicator', 'set', entityId, '-i', JSON.stringify(merged)]);
console.log(JSON.stringify({ success: true, scenarioId, merged, setResult }, null, 2));