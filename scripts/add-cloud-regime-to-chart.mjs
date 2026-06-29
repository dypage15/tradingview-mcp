/**
 * Push 01 — Cloud Regime to Pine editor and add to chart.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_ID = 'USER;954e7ef8b6de4533a779db83cc0cbae6';
const NAME = '01 — Cloud Regime';
const src = readFileSync(join(ROOT, 'indicators/01-cloud-regime.pine'), 'utf8');

const parse = (r) => JSON.parse(r.content[0].text);

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'add-cloud', version: '1' });
await client.connect(transport);

console.log('Chart before:', parse(await client.callTool({ name: 'chart_get_state', arguments: {} })).studies);

await client.callTool({ name: 'ui_open_panel', arguments: { panel: 'pine-editor', action: 'open' } });
await new Promise((r) => setTimeout(r, 1500));

const open = parse(await client.callTool({ name: 'pine_open', arguments: { name: NAME, script_id: SCRIPT_ID } }));
console.log('open:', open.success, open.name, open.lines, open.error);

await client.callTool({ name: 'pine_set_source', arguments: { source: src } });
const err = parse(await client.callTool({ name: 'pine_get_errors', arguments: {} }));
console.log('errors:', err.error_count, err.errors?.[0]?.message || 'none');

let compile = parse(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
console.log('compile1:', compile.button_clicked, compile.study_added, compile.has_errors);

if (!compile.study_added && !compile.has_errors) {
  await new Promise((r) => setTimeout(r, 3000));
  compile = parse(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
  console.log('compile2:', compile.button_clicked, compile.study_added);
}

const find = parse(await client.callTool({ name: 'ui_find_element', arguments: { query: 'Add to chart', strategy: 'text' } }));
const btn = find.elements?.find((e) => e.tag === 'button');
if (btn && !compile.study_added) {
  const x = Math.round(btn.x + btn.width / 2);
  const y = Math.round(btn.y + btn.height / 2);
  await client.callTool({ name: 'ui_mouse_click', arguments: { x, y } });
  console.log('clicked Add to chart at', x, y);
  await new Promise((r) => setTimeout(r, 4000));
}

// Fallback: Indicators dialog
const state = parse(await client.callTool({ name: 'chart_get_state', arguments: {} }));
const hasCloud = state.studies?.some((s) => /Cloud Regime/.test(s.name));
if (!hasCloud) {
  console.log('Trying Indicators dialog...');
  await client.callTool({ name: 'ui_click', arguments: { by: 'data-name', value: 'open-indicators-dialog' } });
  await new Promise((r) => setTimeout(r, 800));
  await client.callTool({ name: 'ui_mouse_click', arguments: { x: 660, y: 384 } });
  await new Promise((r) => setTimeout(r, 400));
  const row = parse(await client.callTool({ name: 'ui_find_element', arguments: { query: NAME, strategy: 'text' } }));
  const div = row.elements?.find((e) => e.tag === 'div' && e.y > 300 && e.y < 700 && e.width > 400);
  if (div) {
    await client.callTool({ name: 'ui_mouse_click', arguments: { x: Math.round(div.x + 50), y: Math.round(div.y + div.height / 2) } });
    await client.callTool({ name: 'ui_keyboard', arguments: { key: 'Enter' } });
    await new Promise((r) => setTimeout(r, 3500));
    await client.callTool({ name: 'ui_keyboard', arguments: { key: 'Escape' } });
  }
}

console.log('Chart after:', parse(await client.callTool({ name: 'chart_get_state', arguments: {} })).studies);

await client.close();
