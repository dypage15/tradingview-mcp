#!/usr/bin/env node
/** Apply Asia + NY session preset with optimized v2.3 spec. */
import { disconnect } from '../src/connection.js';
import * as chart from '../src/core/chart.js';
import * as indicators from '../src/core/indicators.js';
import * as data from '../src/core/data.js';
import * as ui from '../src/core/ui.js';
import { confluenceInputs } from './clreg23-confluence-inputs.mjs';

const BEST = {
  in_0: 9,
  in_1: 21,
  in_2: 50,
  in_3: 3,
  in_4: 6,
  in_6: 'Combined',
  in_7: 30,
  in_8: 70,
  in_9: 5,
  in_10: 30,
  in_11: 15,
  in_12: true,
  in_14: 3,
  in_15: 0,
  in_16: 0,
  in_24: 'Points',
  in_28: 'Asia + NY',
  in_29: '1800-0100',
  in_30: '0830-1500',
  in_31: true,
  in_32: true,
  in_33: true,
  ...confluenceInputs(process.env.CLREG23_CONFLUENCE || 'BB'),
  in_37: 20,
  in_38: 2.0,
  in_39: 'Proximity',
  in_40: 3.0,
  in_41: 14,
};

process.env.ADVISOR_STRATEGY_SUBSTRING = 'v2.3';
const state = await chart.getState();
const hit = (state.studies || []).filter((s) => /v2\.3|ClReg2\.3/i.test(s.name || '')).pop();
if (!hit?.id) throw new Error('ClReg2.3 not on chart');

await indicators.setInputs({
  entity_id: hit.id,
  inputs: JSON.stringify(BEST),
  persist_layout: true,
});
await new Promise((r) => setTimeout(r, 12000));
await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5 }).catch(() => {});
const strat = await data.getStrategyResults();
console.log('Applied on', hit.id, 'RSI=', BEST.in_35, 'BB=', BEST.in_36);
console.log({
  trades: strat.metrics?.totalTrades,
  net: strat.metrics?.netProfit,
  pf: strat.metrics?.profitFactor,
  wr: strat.metrics?.percentProfitable,
});
await disconnect().catch(() => {});
