#!/usr/bin/env node
/**
 * Push CR3 Full Stack pine + apply labeled-review production inputs + set MNQ 5m.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disconnect } from '../src/connection.js';
import * as health from '../src/core/health.js';
import * as chart from '../src/core/chart.js';
import * as indicators from '../src/core/indicators.js';
import * as pine from '../src/core/pine.js';
import * as ui from '../src/core/ui.js';
import { CR3_LABELED_PROD_SPEC, pickCr3Entity, specToInputs } from './cr3-grid-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = process.env.CLOUD_REGIME_SRC || join(ROOT, 'cloud-regime-v3-full-stack-strategy.pine');
const TF = process.env.TV_BACKTEST_TIMEFRAME || '5';

process.env.ADVISOR_STRATEGY_SUBSTRING = process.env.ADVISOR_STRATEGY_SUBSTRING || 'Full Stack';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await health.healthCheck();
await ui.openPanel({ panel: 'pine-editor', action: 'open' });
await sleep(1500);

const src = readFileSync(SRC, 'utf8');
await pine.setSource({ source: src });
await sleep(500);
const comp = await pine.smartCompile({});
console.log('compile:', JSON.stringify({ success: comp.success, has_errors: comp.has_errors, errors: comp.errors?.slice(0, 3) }));
await sleep(4000);

let state = await chart.getState();
if (String(state.resolution) !== String(TF)) {
  await chart.setTimeframe({ timeframe: TF });
  await sleep(2500);
  state = await chart.getState();
}

const entityId = pickCr3Entity(state);
const inputs = specToInputs(CR3_LABELED_PROD_SPEC);
await indicators.setInputs({ entity_id: entityId, inputs });
await sleep(2000);
await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5 }).catch(() => {});
await sleep(3000);

console.log(
  JSON.stringify(
    {
      symbol: state.symbol,
      timeframe: TF,
      entity_id: entityId,
      preset: CR3_LABELED_PROD_SPEC,
      inputs_applied: inputs,
    },
    null,
    2,
  ),
);

await disconnect().catch(() => {});
