import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = '04 — Confluence Data Recorder';
const src = readFileSync(join(ROOT, 'indicators/04-confluence-data-recorder.pine'), 'utf8');
const parse = (r) => JSON.parse(r.content[0].text);

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'push-cdr', version: '1' });
await client.connect(transport);

async function getStudies() {
  return parse(await client.callTool({ name: 'chart_get_state', arguments: {} })).studies || [];
}

// Dedupe Cloud Regime — keep first entity only
const clouds = (await getStudies()).filter((s) => s.name === '01 — Cloud Regime');
for (let i = 1; i < clouds.length; i++) {
  await client.callTool({
    name: 'chart_manage_indicator',
    arguments: { action: 'remove', indicator: clouds[i].name, entity_id: clouds[i].id },
  });
  console.log('removed duplicate cloud', clouds[i].id);
}

await client.callTool({ name: 'ui_open_panel', arguments: { panel: 'pine-editor', action: 'open' } });
await new Promise((r) => setTimeout(r, 1500));

const open = parse(await client.callTool({ name: 'pine_open', arguments: { name: NAME } }));
console.log('open:', open.name, open.lines, open.error);

await client.callTool({ name: 'pine_set_source', arguments: { source: src } });
const err = parse(await client.callTool({ name: 'pine_get_errors', arguments: {} }));
console.log('errors:', err.error_count);
if (err.error_count) {
  console.log(err.errors);
  await client.close();
  process.exit(1);
}

const compile = parse(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
console.log('compile:', compile.button_clicked, compile.study_added, compile.has_errors);

if (!compile.study_added) {
  await new Promise((r) => setTimeout(r, 2500));
  const find = parse(await client.callTool({ name: 'ui_find_element', arguments: { query: 'Add to chart', strategy: 'text' } }));
  const btn = find.elements?.find((e) => e.tag === 'button');
  if (btn) {
    const x = Math.round(btn.x + btn.width / 2);
    const y = Math.round(btn.y + btn.height / 2);
    await client.callTool({ name: 'ui_mouse_click', arguments: { x, y } });
    console.log('clicked Add to chart');
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const after = await getStudies();
console.log('studies:', after.map((s) => s.name).join(', '));

const tables = parse(await client.callTool({ name: 'data_get_pine_tables', arguments: { study_filter: 'Recorder' } }));
console.log('CDR panel:', tables.studies?.[0]?.tables?.[0]?.rows?.slice(0, 3) || '(none)');

await client.close();
