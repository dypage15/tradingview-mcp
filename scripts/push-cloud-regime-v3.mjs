/**
 * Push Cloud Regime v3.0 Pine (repo: cloud-regime-v3-strategy.pine) → TV editor + compile.
 * Usage: node scripts/push-cloud-regime-v3.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_PATH =
  process.env.CLOUD_REGIME_SRC ||
  join(ROOT, 'cloud-regime-v3-strategy.pine');

const src = readFileSync(SRC_PATH, 'utf8');

function parseToolResult(toolResult) {
  const text = toolResult?.content?.[0]?.text;
  if (!text) return { _parseError: 'no text content in tool result' };
  try {
    return JSON.parse(text);
  } catch (e) {
    return { _parseError: e.message, _raw: text };
  }
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [join(ROOT, 'src/server.js')],
  cwd: ROOT,
});
const client = new Client({ name: 'push-cloud-regime-v3', version: '1.0.0' });
await client.connect(transport);

const setRes = parseToolResult(await client.callTool({ name: 'pine_set_source', arguments: { source: src } }));
console.log('pine_set_source:', JSON.stringify(setRes, null, 2));

const compileRes = parseToolResult(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
console.log('pine_smart_compile:', JSON.stringify(compileRes, null, 2));

await client.close().catch(() => {});
