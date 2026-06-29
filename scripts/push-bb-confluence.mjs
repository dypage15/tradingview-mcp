/**
 * Push fixed 03 — BB Confluence and add via Indicators dialog (no editor replace).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_ID = 'USER;5dd67c10ef8a4b01985c816223402f27';
const NAME = '03 — BB Confluence';
const src = readFileSync(join(ROOT, 'indicators/03-bb-confluence.pine'), 'utf8');

const parse = (r) => JSON.parse(r.content[0].text);

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'push-bb', version: '1' });
await client.connect(transport);

async function getStudies() {
  return parse(await client.callTool({ name: 'chart_get_state', arguments: {} })).studies || [];
}

let before = await getStudies();
console.log('before:', before.map((s) => s.name).join(', '));

// Remove broken BB if present
for (const st of before) {
  if (st.name === NAME) {
    await client.callTool({
      name: 'chart_manage_indicator',
      arguments: { action: 'remove', indicator: st.name, entity_id: st.id },
    });
    console.log('removed old BB', st.id);
  }
}

await client.callTool({ name: 'ui_open_panel', arguments: { panel: 'pine-editor', action: 'open' } });
await new Promise((r) => setTimeout(r, 1200));

const open = parse(await client.callTool({ name: 'pine_open', arguments: { name: NAME, script_id: SCRIPT_ID } }));
console.log('open:', open.lines, 'lines');

await client.callTool({ name: 'pine_set_source', arguments: { source: src } });
const err = parse(await client.callTool({ name: 'pine_get_errors', arguments: {} }));
console.log('compile errors:', err.error_count);
if (err.error_count) {
  console.log(err.errors?.slice(0, 3));
  await client.close();
  process.exit(1);
}

await client.callTool({ name: 'pine_smart_compile', arguments: {} });
await new Promise((r) => setTimeout(r, 2000));

// Add via Indicators dialog
await client.callTool({ name: 'ui_click', arguments: { by: 'data-name', value: 'open-indicators-dialog' } });
await new Promise((r) => setTimeout(r, 900));
await client.callTool({ name: 'ui_mouse_click', arguments: { x: 660, y: 384 } });
await new Promise((r) => setTimeout(r, 500));
const row = parse(await client.callTool({ name: 'ui_find_element', arguments: { query: NAME, strategy: 'text' } }));
const div = row.elements?.find((e) => e.tag === 'div' && e.y > 280 && e.y < 720 && e.width > 350);
if (div) {
  await client.callTool({
    name: 'ui_mouse_click',
    arguments: { x: Math.round(div.x + 40), y: Math.round(div.y + div.height / 2) },
  });
  await client.callTool({ name: 'ui_keyboard', arguments: { key: 'Enter' } });
  await new Promise((r) => setTimeout(r, 4000));
  await client.callTool({ name: 'ui_keyboard', arguments: { key: 'Escape' } });
}

const after = await getStudies();
console.log('after:', after.map((s) => s.name).join(', '));

const tables = parse(await client.callTool({ name: 'data_get_pine_tables', arguments: { study_filter: 'BB' } }));
console.log('BB panel rows:', tables.studies?.[0]?.tables?.[0]?.rows?.slice(0, 3) || '(none)');

await client.close();
