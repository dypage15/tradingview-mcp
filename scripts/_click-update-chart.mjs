#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/connection.js';
import * as pine from '../src/core/pine.js';
import * as ui from '../src/core/ui.js';
import * as data from '../src/core/data.js';
import { disconnect } from '../src/connection.js';

const src = readFileSync('cloud-regime-v2.2-rsi-confluence.pine', 'utf8');
await ui.openPanel({ panel: 'pine-editor', action: 'open' });
await new Promise((r) => setTimeout(r, 1500));
await pine.setSource({ source: src });
await new Promise((r) => setTimeout(r, 400));
const c1 = await pine.pineEditorToolbarCompilePass();
console.log('pass1', c1.button_clicked, c1.has_errors);
for (let w = 0; w < 6; w++) {
  await new Promise((r) => setTimeout(r, 2000));
  const click = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/update on chart/i.test(text)) { btns[i].click(); return text; }
      }
      return null;
    })()
  `);
  if (click) {
    console.log('clicked', click, 'after', (w + 1) * 2, 's');
    break;
  }
}
await new Promise((r) => setTimeout(r, 30000));
process.env.ADVISOR_STRATEGY_SUBSTRING = 'v2.2';
const s = await data.getStrategyResults();
console.log('tester', s.strategy_name, 'trades', s.metrics?.totalTrades, 'net', s.metrics?.netProfit);
const t = await data.getPineTables({ study_filter: 'v2.2' });
const rows = t.studies?.[0]?.tables?.[1]?.rows || [];
console.log('table', rows.slice(0, 10).join('\n'));
await disconnect().catch(() => {});
