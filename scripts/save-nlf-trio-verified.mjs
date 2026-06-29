/**
 * Reliably save NLF trio to TradingView cloud and verify via pine-facade.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { evaluate, disconnect } from '../src/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SCRIPTS = [
  {
    name: '01 — Cloud Regime',
    file: 'indicators/01-cloud-regime.pine',
    id: 'USER;954e7ef8b6de4533a779db83cc0cbae6',
    marker: 'var table cloudPanel',
  },
  {
    name: '02 — RSI Confluence',
    file: 'indicators/02-rsi-confluence.pine',
    id: 'USER;8560c5fdbc64445ab0897b7a8fd2309e',
    marker: 'var table rsiPanel',
  },
  {
    name: '03 — BB Confluence',
    file: 'indicators/03-bb-confluence.pine',
    id: 'USER;5dd67c10ef8a4b01985c816223402f27',
    marker: 'var table bbPanel',
  },
];

function parse(r) {
  const t = r?.content?.[0]?.text;
  if (!t) return { _err: 'no text' };
  try { return JSON.parse(t); } catch (e) { return { _err: e.message, _raw: t }; }
}

async function fetchCloud(id, ver) {
  return evaluate(`
    fetch('https://pine-facade.tradingview.com/pine-facade/get/${id}/${ver}', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const src = d.source || '';
        return { lines: src.split('\\n').length, ok: src.length > 100 };
      })
  `);
}

async function listVersion(id) {
  return evaluate(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(r => r.json())
      .then(list => {
        const hit = list.find(s => s.scriptIdPart === '${id}');
        return hit ? { version: hit.version, modified: hit.modified, name: hit.scriptName } : null;
      })
  `);
}

async function clickPineSave(client) {
  const click = parse(await client.callTool({
    name: 'ui_find_element',
    arguments: { query: 'Save', strategy: 'text' },
  }));
  const btn = click.elements?.find((e) => e.tag === 'button' && e.text?.includes('Save') && e.y < 120);
  if (btn) {
    await client.callTool({
      name: 'ui_mouse_click',
      arguments: { x: Math.round(btn.x + btn.width / 2), y: Math.round(btn.y + btn.height / 2) },
    });
    return 'toolbar_save_click';
  }
  await client.callTool({ name: 'pine_save', arguments: {} });
  return 'ctrl_s';
}

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'save-nlf-verified', version: '1.0.0' });
await client.connect(transport);

await client.callTool({ name: 'ui_open_panel', arguments: { panel: 'pine-editor', action: 'open' } });

const results = [];

for (const { name, file, id, marker } of SCRIPTS) {
  console.log('\n===', name, '===');
  const src = readFileSync(join(ROOT, file), 'utf8');
  const expectedLines = src.split('\n').length;
  const before = await listVersion(id);
  console.log('before:', before);

  const open = parse(await client.callTool({ name: 'pine_open', arguments: { name } }));
  if (!open.success) {
    console.error('OPEN FAILED:', open);
    results.push({ name, ok: false, reason: 'open_failed' });
    continue;
  }
  console.log('opened:', open.name, 'editor lines reported:', open.lines);

  await client.callTool({ name: 'pine_set_source', arguments: { source: src } });
  const err = parse(await client.callTool({ name: 'pine_get_errors', arguments: {} }));
  if (err.has_errors) {
    console.error('compile errors:', err.errors);
    results.push({ name, ok: false, reason: 'editor_errors' });
    continue;
  }

  const compile = parse(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
  console.log('compile:', compile.button_clicked);
  if (compile.has_errors) {
    console.error('compile failed:', compile.errors?.[0]);
    results.push({ name, ok: false, reason: 'compile_errors' });
    continue;
  }

  const saveMethod = await clickPineSave(client);
  console.log('save method:', saveMethod);
  await new Promise((r) => setTimeout(r, 4000));

  const save2 = await clickPineSave(client);
  await new Promise((r) => setTimeout(r, 3000));

  const after = await listVersion(id);
  console.log('after:', after);

  const ver = String(after?.version || before?.version || '1').replace(/\.0$/, '') || '1';
  const cloud = await fetchCloud(id, ver);
  const hasMarker = await evaluate(`
    fetch('https://pine-facade.tradingview.com/pine-facade/get/${id}/${ver}', { credentials: 'include' })
      .then(r => r.json())
      .then(d => (d.source || '').includes(${JSON.stringify(marker)}))
  `);

  const ok = hasMarker && cloud.lines >= expectedLines - 5;
  console.log('cloud verify:', { lines: cloud.lines, expectedLines, hasMarker, ok });
  results.push({ name, ok, version: after?.version, lines: cloud.lines, hasMarker });
}

console.log('\n=== SUMMARY ===');
for (const r of results) console.log(r.ok ? 'OK' : 'FAIL', r.name, r);

await client.close();
await disconnect();
