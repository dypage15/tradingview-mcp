#!/usr/bin/env node
import { evaluate, disconnect } from '../src/connection.js';
import * as chart from '../src/core/chart.js';

const s = await chart.getState();
const hits = (s.studies || []).filter((x) => /v2\.2/i.test(x.name || ''));
for (const h of hits) {
  const r = await evaluate(`
    (function() {
      var chart = window.TradingViewApi.activeChart();
      var st = chart.getStudyById('${h.id}');
      if (!st) return { id: '${h.id}', err: 'missing' };
      var meta = st.metaInfo();
      var backtest = null;
      try {
        var iv = st.getInputValues();
        for (var i = 0; i < iv.length; i++) {
          if (iv[i].id === 'in_35') backtest = iv[i].value;
        }
      } catch (e) {}
      return {
        id: '${h.id}',
        name: meta.description || meta.shortDescription,
        isStrategy: meta.isTVScriptStrategy,
        backtestMode: backtest
      };
    })()
  `);
  console.log(JSON.stringify(r));
}
await disconnect().catch(() => {});
