#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluate, disconnect } from '../src/connection.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as pine from '../src/core/pine.js';
import * as ui from '../src/core/ui.js';
import * as h from '../src/core/health.js';

const ENTITY = process.env.CLREG22_ENTITY_ID || '1mHjSs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await h.healthCheck();
await ui.openPanel({ panel: 'pine-editor', action: 'open' });
await sleep(1000);
await pine.setSource({ source: readFileSync('cloud-regime-v2.2-rsi-confluence.pine', 'utf8') });
const err = await pine.getErrors();
if (err.entries?.length) {
  console.error(err.entries);
  process.exit(1);
}
await pine.compile();
for (let w = 0; w < 25; w++) {
  const c = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent.trim();
        if (/update on chart/i.test(t)) { btns[i].click(); return 'ok'; }
      }
      return null;
    })()
  `);
  if (c) {
    console.log('update clicked');
    break;
  }
  await sleep(1000);
}
await sleep(40000);
const ind = await data.getIndicator({ entity_id: ENTITY });
const inputs = ind.inputs || {};
console.log('strategyEnabled in_31', inputs.in_31);
console.log('useRsiConfluence in_35', inputs.in_35);
console.log('useBbConfluence in_36', inputs.in_36);
console.log('bbMode in_39', inputs.in_39);
await disconnect();
