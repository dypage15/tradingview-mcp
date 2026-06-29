import { evaluate, disconnect } from '../src/connection.js';
import * as pine from '../src/core/pine.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as ind from '../src/core/indicators.js';

await pine.ensurePineEditorOpen();
for (let a = 0; a < 8; a++) {
  const btn = await evaluate(`(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var t = btns[i].textContent.trim();
      if (/save and add to chart/i.test(t)) { btns[i].click(); return t; }
      if (/^add to chart$/i.test(t)) { btns[i].click(); return t; }
    }
    return null;
  })()`);
  console.log('click:', btn);
  if (btn) break;
  await new Promise((r) => setTimeout(r, 2500));
}

await new Promise((r) => setTimeout(r, 10000));
const state = await chart.getState();
const study = state.studies?.find((s) => /v2\.1/i.test(s.name));
console.log('v2.1 study:', study);
if (study) {
  await ind.setInputs({
    entity_id: study.id,
    inputs: { in_4: 20, in_18: false, in_20: 10, in_6: 'Crossover', in_10: 'Momentum' },
  });
  await new Promise((r) => setTimeout(r, 25000));
  const res = await data.getStrategyResults();
  console.log('RESULT', {
    totalTrades: res.metrics?.totalTrades,
    netProfit: res.metrics?.netProfit,
    strategy: res.strategy_name,
  });
}
await disconnect();
