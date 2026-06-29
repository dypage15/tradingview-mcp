#!/usr/bin/env node
/**
 * Force-deploy ClReg2.2: open saved script, set source, compile, Update on chart, verify trades.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, disconnect } from '../src/connection.js';
import * as pine from '../src/core/pine.js';
import * as ui from '../src/core/ui.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { parseExecutionTable } from './clreg22-grid-utils.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_NAME = process.env.CLREG22_SCRIPT_NAME || 'Cloud Regime v2.3 — RSI Confluence';
const src = readFileSync(join(ROOT, 'cloud-regime-v2.2-rsi-confluence.pine'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickChartToolbar(regex) {
  return evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent.trim();
        if (${regex}.test(t) && btns[i].offsetParent !== null) {
          btns[i].click();
          return t;
        }
      }
      return null;
    })()
  `);
}

async function waitForUpdateButton(maxSec = 24) {
  for (let w = 0; w < maxSec; w++) {
    const clicked = await evaluate(`
      (function() {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var t = btns[i].textContent.trim();
          if (/update on chart/i.test(t)) { btns[i].click(); return 'Update on chart'; }
          if (/save and add to chart/i.test(t)) { btns[i].click(); return 'Save and add to chart'; }
          if (/^add to chart$/i.test(t)) { btns[i].click(); return 'Add to chart'; }
        }
        return null;
      })()
    `);
    if (clicked) return clicked;
    await sleep(1000);
  }
  return null;
}

async function verify() {
  await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5, pause_ms: 400 }).catch(() => {});
  process.env.ADVISOR_STRATEGY_SUBSTRING = 'v2.3';
  const strat = await data.getStrategyResults();
  const tbl = await data.getPineTables({ study_filter: 'v2.3' });
  const exec = parseExecutionTable(tbl);
  const trades = strat.metrics?.totalTrades ?? 0;
  const engine = exec.engineClosed ?? 0;
  const closed = exec.closedTrades ?? 0;
  return { strat, exec, ok: trades > 0 || engine > 0 || closed > 0 };
}

console.log('1) Chart state');
let state0 = await chart.getState();
console.log('   symbol:', state0.symbol, 'tf:', state0.resolution);
let v22 = (state0.studies || []).filter((s) => /v2\.3|ClReg2\.3|v2\.2|ClReg2\.2/i.test(s.name || ''));
console.log('   ClReg instances:', v22.map((s) => s.id).join(', ') || 'none');

// Always remove ALL ClReg instances — stale copies show 0 fills while tester reads another.
if (v22.length > 0) {
  console.log('   removing all ClReg instances before fresh deploy');
  for (const st of v22) {
    await chart.manageIndicator({ action: 'remove', entity_id: st.id }).catch(() => {});
    await sleep(500);
  }
  state0 = await chart.getState();
  v22 = [];
}

if (String(state0.resolution) === '1') {
  console.log('   switching to 5m for backtest stability');
  await chart.setTimeframe({ timeframe: '5' });
  await sleep(2000);
}

console.log('2) Pine editor');
await ui.openPanel({ panel: 'pine-editor', action: 'open' });
await sleep(1500);

try {
  const opened = await pine.openScript({ name: SCRIPT_NAME });
  console.log('   opened:', opened.scriptName || opened.action || 'ok');
} catch (e) {
  console.warn('   openScript:', e.message, '— continuing with current editor buffer');
}

await pine.setSource({ source: src });
await sleep(500);

const err0 = await pine.getErrors();
if (err0.entries?.length) {
  console.error('COMPILE ERRORS:', err0.entries);
  process.exit(1);
}

console.log('3) Compile → Add to chart (single instance)');
let clicked = await pine.compile();
console.log('   compile:', clicked.button_clicked);
await sleep(3000);
clicked = await waitForUpdateButton(20);
console.log('   chart apply:', clicked);
if (!clicked) {
  try {
    await pine.pineEditorToolbarCompilePass();
    await sleep(4000);
    clicked = await waitForUpdateButton(12);
    console.log('   retry apply:', clicked);
  } catch (e) {
    console.warn('   toolbar compile pass:', e.message);
  }
}

console.log('4) Wait for backtest (45s)');
await sleep(45000);

let result = await verify();
console.log('\n--- Strategy Tester ---');
console.log('name:', result.strat.strategy_name);
console.log('trades:', result.strat.metrics?.totalTrades, 'net:', result.strat.metrics?.netProfit, 'PF:', result.strat.metrics?.profitFactor);
console.log('\n--- EXECUTION DATA ---');
console.log(JSON.stringify(result.exec, null, 2));

const inst = await chart.getState();
const n = (inst.studies || []).filter((s) => /v2\.3|ClReg2\.3|v2\.2|ClReg2\.2/i.test(s.name || '')).length;
console.log('   ClReg count on chart:', n);

await disconnect().catch(() => {});
if (result.ok) {
  console.log('\nSUCCESS: ClReg2.3 is filling trades.');
  process.exit(0);
}
console.error('\nFAILED: Still 0 trades. Open Pine editor, click Update on chart manually.');
process.exit(2);
