#!/usr/bin/env node
/** Pause all new entries (flip exits still run). */
import { disconnect } from '../src/connection.js';
import * as chart from '../src/core/chart.js';
import * as indicators from '../src/core/indicators.js';

process.env.ADVISOR_STRATEGY_SUBSTRING = 'v2.3';
const state = await chart.getState();
const hit = (state.studies || []).filter((s) => /v2\.3|ClReg2\.3/i.test(s.name || '')).pop();
if (!hit?.id) throw new Error('ClReg2.3 not on chart');
await indicators.setInputs({ entity_id: hit.id, inputs: JSON.stringify({ in_31: false }), persist_layout: true });
console.log('Strategy entries OFF on', hit.id);
await disconnect().catch(() => {});
