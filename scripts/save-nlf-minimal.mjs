/**
 * Minimal save test: set_source → save only (no compile) → re-fetch by ID.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parse = (r) => JSON.parse(r.content[0].text);

const test = {
  name: '03 — BB Confluence',
  script_id: 'USER;5dd67c10ef8a4b01985c816223402f27',
  file: 'indicators/03-bb-confluence.pine',
};

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'save-min', version: '1' });
await client.connect(transport);

for (let attempt = 0; attempt < 3; attempt++) {
  await client.callTool({ name: 'ui_open_panel', arguments: { panel: 'pine-editor', action: 'open' } });
  await new Promise((r) => setTimeout(r, 2000));
  const panel = parse(await client.callTool({ name: 'tv_health_check', arguments: {} }));
  console.log('attempt', attempt, 'health ok:', panel.success);
}

const src = readFileSync(join(ROOT, test.file), 'utf8');
const open1 = parse(await client.callTool({ name: 'pine_open', arguments: { script_id: test.script_id } }));
console.log('open1', open1.lines, open1.success);

await client.callTool({ name: 'pine_set_source', arguments: { source: src } });
const got = parse(await client.callTool({ name: 'pine_get_source', arguments: {} }));
console.log('after set', (got.source || '').split('\n').length, 'lines');

for (let i = 0; i < 3; i++) {
  const save = parse(await client.callTool({ name: 'pine_save', arguments: {} }));
  console.log('save', i, save.action);
  await new Promise((r) => setTimeout(r, 5000));
}

const open2 = parse(await client.callTool({ name: 'pine_open', arguments: { script_id: test.script_id } }));
console.log('open2 after save', open2.lines, 'expected ~158');

await client.close();
