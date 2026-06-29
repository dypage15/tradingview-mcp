#!/usr/bin/env node
/**
 * Print CDP-visible study handles for an entity id: best getInputValues() length via studyBenchResolve logic.
 *
 * Usage: node scripts/_debug_probe_inputs.mjs [entity_id]
 */
import { evaluate, KNOWN_PATHS, disconnect } from '../src/connection.js';
import { buildResolveBenchStudyHandlesBlock } from '../src/core/studyBenchResolve.js';

const CHART_API = KNOWN_PATHS.chartApi;
const id = process.argv[2] || '';

if (!id) {
  console.error('Usage: node scripts/_debug_probe_inputs.mjs <entity_id>');
  process.exit(1);
}

const escaped = String(id).replace(/'/g, "\\'");
const rb = buildResolveBenchStudyHandlesBlock(escaped);

const r = await evaluate(`
(function(){
  try {
    ${rb}
    var api = ${CHART_API};
    var st = __resolveBenchStudyForInputs(api);
    if (!st || typeof st.getInputValues !== 'function')
      return { ok: false, err: 'no bench study with getInputValues' };
    var v = st.getInputValues();
    return { ok: true, len: v ? v.length : 0, sampleIds: v ? v.slice(0, 8).map(function(x){ return x.id; }) : [] };
  } catch (e) { return { ok: false, err: String(e.message) }; }
})()
`);

console.log(JSON.stringify(r, null, 2));
await disconnect();
