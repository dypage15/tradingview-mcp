/**
 * Save NLF trio to TradingView cloud — open by ID, inject, save, verify facade.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

async function facadeGet(client, scriptId) {
  return parse(await client.callTool({
    name: 'pine_open',
    arguments: { script_id: scriptId },
  }));
}

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'save-nlf-cloud', version: '1.0.0' });
await client.connect(transport);

await client.callTool({ name: 'ui_open_panel', arguments: { panel: 'pine-editor', action: 'open' } });
await new Promise((r) => setTimeout(r, 2000));

const results = [];

for (const { name, script_id, file, marker } of SCRIPTS) {
  console.log('\n==========', name, '==========');
  const src = readFileSync(join(ROOT, file), 'utf8');
  const expected = src.split('\n').length;

  const beforeList = parse(await client.callTool({ name: 'pine_list_scripts', arguments: {} }));
  const before = beforeList.scripts?.find((s) => s.id === script_id);
  console.log('before:', before?.name, 'v' + before?.version, 'modified', before?.modified);

  const open = parse(await client.callTool({ name: 'pine_open', arguments: { script_id } }));
  if (!open.success) {
    console.error('OPEN FAILED', open);
    results.push({ name, ok: false, reason: 'open' });
    continue;
  }
  console.log('opened:', open.lines, 'lines, v' + (open.version || '?'));

  await client.callTool({ name: 'pine_set_source', arguments: { source: src } });
  const err = parse(await client.callTool({ name: 'pine_get_errors', arguments: {} }));
  if (err.has_errors) {
    console.error('errors:', err.errors?.[0]);
    results.push({ name, ok: false, reason: 'compile' });
    continue;
  }

  // Save via toolbar (triggers TV internal save pipeline)
  parse(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
  await new Promise((r) => setTimeout(r, 2000));

  for (let i = 0; i < 4; i++) {
    const save = parse(await client.callTool({ name: 'pine_save', arguments: {} }));
    console.log('save', i + 1, save.action, save.saved_state);
    await new Promise((r) => setTimeout(r, 3500));
  }

  const editor = parse(await client.callTool({ name: 'pine_get_source', arguments: {} }));
  const editorOk = (editor.source || '').includes(marker);
  console.log('editor check:', editorOk, (editor.source || '').split('\n').length, 'lines');

  const reopen = parse(await client.callTool({ name: 'pine_open', arguments: { script_id } }));
  const cloudOk = (reopen.lines >= expected - 3) && (reopen.lines <= expected + 3);
  console.log('cloud reopen:', reopen.lines, 'lines (expected', expected + ')', cloudOk ? 'OK' : 'STALE');

  const afterList = parse(await client.callTool({ name: 'pine_list_scripts', arguments: {} }));
  const after = afterList.scripts?.find((s) => s.id === script_id);
  console.log('after:', after?.name, 'v' + after?.version, 'modified', after?.modified);
  const versionBumped = after?.modified !== before?.modified || after?.version !== before?.version;

  results.push({
    name,
    ok: cloudOk && editorOk,
    cloudOk,
    editorOk,
    versionBumped,
    lines: reopen.lines,
    version: after?.version,
  });
}

console.log('\n========== SUMMARY ==========');
for (const r of results) {
  console.log(r.ok ? 'OK' : 'FAIL', r.name, '| lines', r.lines, '| v' + r.version, '| bumped', r.versionBumped);
}

await client.close();
