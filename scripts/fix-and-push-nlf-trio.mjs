/**
 * Fix + save all three NLF chart indicators to TradingView cloud (by script ID).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SCRIPTS = [
  {
    name: '01 — Cloud Regime',
    script_id: 'USER;954e7ef8b6de4533a779db83cc0cbae6',
    file: 'indicators/01-cloud-regime.pine',
    marker: 'var table cloudPanel',
  },
  {
    name: '02 — RSI Confluence',
    script_id: 'USER;8560c5fdbc64445ab0897b7a8fd2309e',
    file: 'indicators/02-rsi-confluence.pine',
    marker: 'var table rsiPanel',
  },
  {
    name: '03 — BB Confluence',
    script_id: 'USER;5dd67c10ef8a4b01985c816223402f27',
    file: 'indicators/03-bb-confluence.pine',
    marker: 'var table bbPanel',
  },
];

function parse(r) {
  const t = r?.content?.[0]?.text;
  if (!t) return { _err: 'no text' };
  try { return JSON.parse(t); } catch (e) { return { _err: e.message, _raw: t }; }
}

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'fix-nlf-trio', version: '1.0.0' });
await client.connect(transport);

await client.callTool({ name: 'ui_open_panel', arguments: { panel: 'pine-editor', action: 'open' } });
await new Promise((r) => setTimeout(r, 1500));

for (const { name, script_id, file, marker } of SCRIPTS) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const expectedLines = src.split('\n').length;
  console.log('\n---', name, '---');

  const open = parse(await client.callTool({ name: 'pine_open', arguments: { script_id } }));
  if (!open.success) {
    console.error('open failed:', open);
    continue;
  }
  console.log('opened:', open.name, 'v' + (open.version || '?'), 'lines:', open.lines, 'id:', open.script_id);

  const set = parse(await client.callTool({ name: 'pine_set_source', arguments: { source: src } }));
  console.log('set_source:', set.lines_set, 'lines (expected', expectedLines + ')');

  const err = parse(await client.callTool({ name: 'pine_get_errors', arguments: {} }));
  if (err.has_errors) {
    console.error('editor errors:', err.errors?.[0]);
    continue;
  }

  const compile = parse(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
  console.log('compile:', compile.button_clicked);
  if (compile.has_errors) {
    console.error('compile failed:', compile.errors?.[0]);
    continue;
  }

  let save = parse(await client.callTool({ name: 'pine_save', arguments: {} }));
  console.log('save:', save.action);
  await new Promise((r) => setTimeout(r, 4000));
  save = parse(await client.callTool({ name: 'pine_save', arguments: {} }));
  console.log('save2:', save.action);

  const got = parse(await client.callTool({ name: 'pine_get_source', arguments: {} }));
  const editorOk = (got.source || '').includes(marker);
  console.log('editor:', editorOk ? 'OK' : 'FAIL', (got.source || '').split('\n').length, 'lines');

  const reopen = parse(await client.callTool({ name: 'pine_open', arguments: { script_id } }));
  const cloudOk = reopen.lines >= expectedLines - 5 && reopen.lines <= expectedLines + 5;
  console.log('cloud reopen:', reopen.lines, 'lines', cloudOk ? 'OK' : 'STALE (save may not have synced)');

  const list = parse(await client.callTool({ name: 'pine_list_scripts', arguments: {} }));
  const hit = list.scripts?.find((s) => s.id === script_id);
  console.log('cloud meta:', hit?.name, 'v' + hit?.version, 'modified', hit?.modified);
}

await client.close();
