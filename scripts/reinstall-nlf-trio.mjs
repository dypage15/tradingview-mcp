/**
 * Remove all NLF studies on chart, push fixed source, re-add via Add to chart click.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SCRIPTS = [
  { name: '01 — Cloud Regime', file: 'indicators/01-cloud-regime.pine' },
  { name: '02 — RSI Confluence', file: 'indicators/02-rsi-confluence.pine' },
  { name: '03 — BB Confluence', file: 'indicators/03-bb-confluence.pine' },
];

function parse(r) {
  const t = r?.content?.[0]?.text;
  if (!t) return { _err: 'no text' };
  try { return JSON.parse(t); } catch (e) { return { _err: e.message, _raw: t }; }
}

async function chartStudies(client) {
  const s = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
  return s.studies || [];
}

async function removeNlf(client) {
  const studies = await chartStudies(client);
  for (const st of studies) {
    if (/Cloud Regime|RSI Confluence|BB Confluence/.test(st.name)) {
      const rm = parse(await client.callTool({
        name: 'chart_manage_indicator',
        arguments: { action: 'remove', indicator: st.name, entity_id: st.id },
      }));
      console.log('remove', st.name, rm.success ? 'ok' : rm);
    }
  }
}

async function clickAddToChart(client) {
  await new Promise((r) => setTimeout(r, 2800));
  const find = parse(await client.callTool({
    name: 'ui_find_element',
    arguments: { query: 'Add to chart', strategy: 'text' },
  }));
  const btn = find.elements?.find((e) => e.tag === 'button');
  if (!btn) return false;
  const x = Math.round(btn.x + btn.width / 2);
  const y = Math.round(btn.y + btn.height / 2);
  await client.callTool({ name: 'ui_mouse_click', arguments: { x, y } });
  await new Promise((r) => setTimeout(r, 3500));
  return true;
}

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'reinstall-nlf', version: '1.0.0' });
await client.connect(transport);

await client.callTool({ name: 'ui_open_panel', arguments: { panel: 'pine-editor', action: 'open' } });
await removeNlf(client);
console.log('start studies:', (await chartStudies(client)).map((s) => s.name).join(', ') || '(none)');

for (const { name, file } of SCRIPTS) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const before = (await chartStudies(client)).length;
  console.log('\n---', name, `(chart has ${before}) ---`);
  parse(await client.callTool({ name: 'pine_open', arguments: { name } }));
  parse(await client.callTool({ name: 'pine_set_source', arguments: { source: src } }));
  const compile = parse(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
  console.log('compile:', compile.button_clicked, 'errors:', compile.errors?.length ?? 0, compile.errors?.[0]?.message || '');
  if (compile.has_errors) continue;
  parse(await client.callTool({ name: 'pine_save', arguments: {} }));
  const clicked = await clickAddToChart(client);
  const after = (await chartStudies(client)).map((s) => s.name);
  console.log('add click:', clicked, 'studies:', after.join(', '));
}

console.log('\nfinal:', JSON.stringify(await chartStudies(client), null, 2));
await client.close();
