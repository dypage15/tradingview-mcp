#!/usr/bin/env node
/** Apply Cloud+BB best from bb-grid (Proximity buffer 3.0, Asia+NY). */
import { disconnect } from '../src/connection.js';
import * as chart from '../src/core/chart.js';
import * as indicators from '../src/core/indicators.js';
import * as data from '../src/core/data.js';
import * as ui from '../src/core/ui.js';

const INPUTS = {
  in_0: 9,
  in_1: 21,
  in_2: 50,
  in_3: 3,
  in_4: 6,
  in_6: 'Combined',
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
  in_35: false,
  in_36: true,
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

await indicators.setInputs({ entity_id: hit.id, inputs: JSON.stringify(INPUTS), persist_layout: true });
await new Promise((r) => setTimeout(r, 12000));
await ui.strategyTesterClickUpdateReportIfPresent({ max_attempts: 5 }).catch(() => {});
const strat = await data.getStrategyResults();
console.log('Applied Cloud+BB Proximity 3.0 on', hit.id);
console.log({
  trades: strat.metrics?.totalTrades,
  net: strat.metrics?.netProfit,
  pf: strat.metrics?.profitFactor,
  wr: strat.metrics?.percentProfitable,
});
await disconnect().catch(() => {});
