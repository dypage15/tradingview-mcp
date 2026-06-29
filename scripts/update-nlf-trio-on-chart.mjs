/**
 * Open each NLF indicator, inject fixed source, compile → Update on chart.
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

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'update-nlf-chart', version: '1.0.0' });
await client.connect(transport);

for (const { name, file } of SCRIPTS) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  console.log('\n---', name, '---');
  const open = parse(await client.callTool({ name: 'pine_open', arguments: { name } }));
  if (!open.success) { console.error('open failed', open); continue; }
  parse(await client.callTool({ name: 'pine_set_source', arguments: { source: src } }));
  const compile = parse(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
  console.log('compile:', compile.button_clicked, 'errors:', compile.errors?.length ?? 0, compile.errors?.[0]?.message || '');
  if (!compile.has_errors) {
    parse(await client.callTool({ name: 'pine_save', arguments: {} }));
    const again = parse(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
    console.log('2nd:', again.button_clicked, 'errors:', again.errors?.length ?? 0);
  }
}

await client.close();
