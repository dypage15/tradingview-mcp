import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = '04 — Confluence Data Recorder';
const FILE = join(ROOT, 'indicators/04-confluence-data-recorder.pine');

const parse = (r) => JSON.parse(r.content[0].text);
const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'fix-cdr', version: '1' });
await client.connect(transport);

await client.callTool({ name: 'ui_open_panel', arguments: { panel: 'pine-editor', action: 'open' } });
await new Promise((r) => setTimeout(r, 1200));
parse(await client.callTool({ name: 'pine_open', arguments: { name: NAME } }));

if (existsSync(FILE)) {
  const src = readFileSync(FILE, 'utf8');
  await client.callTool({ name: 'pine_set_source', arguments: { source: src } });
}

const err = parse(await client.callTool({ name: 'pine_get_errors', arguments: {} }));
console.log(JSON.stringify(err, null, 2));

const srcBack = parse(await client.callTool({ name: 'pine_get_source', arguments: {} }));
if (srcBack.source) {
  const lines = srcBack.source.split('\n');
  console.log('lines:', lines.length);
  // show lines around first error if any
  for (const e of err.errors || []) {
    const ln = e.line || e.startLine;
    if (ln) console.log('--- around line', ln, '---');
    for (let i = Math.max(0, ln - 3); i < Math.min(lines.length, ln + 2); i++) {
      console.log(`${i + 1}: ${lines[i]}`);
    }
  }
}

await client.close();
