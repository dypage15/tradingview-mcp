import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'Cloud Regime v2.2 — RSI Confluence';
const src = readFileSync(join(ROOT, 'cloud-regime-v2.2-rsi-confluence.pine'), 'utf8');
const parse = (r) => JSON.parse(r.content[0].text);

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'v22', version: '1' });
await client.connect(transport);

await client.callTool({ name: 'ui_open_panel', arguments: { panel: 'pine-editor', action: 'open' } });
await new Promise((r) => setTimeout(r, 1500));
parse(await client.callTool({ name: 'pine_open', arguments: { name: NAME } }));
await client.callTool({ name: 'pine_set_source', arguments: { source: src } });
await new Promise((r) => setTimeout(r, 500));

for (let pass = 0; pass < 2; pass++) {
  const compile = parse(await client.callTool({ name: 'pine_smart_compile', arguments: {} }));
  console.log(`pass ${pass + 1}:`, compile.button_clicked, compile.has_errors, compile.errors?.[0]?.message || '');
  await new Promise((r) => setTimeout(r, 4000));
}

const find = parse(await client.callTool({ name: 'ui_find_element', arguments: { query: 'Update on chart', strategy: 'text' } }));
const btn = find.elements?.find((e) => e.tag === 'button');
if (btn) {
  await client.callTool({
    name: 'ui_mouse_click',
    arguments: { x: Math.round(btn.x + btn.width / 2), y: Math.round(btn.y + btn.height / 2) },
  });
  console.log('clicked Update on chart');
}

console.log('waiting for backtest...');
await new Promise((r) => setTimeout(r, 20000));

const strat = parse(await client.callTool({ name: 'data_get_strategy_results', arguments: { study_filter: 'v2.2' } }));
console.log('trades:', strat.metrics?.totalTrades, 'net:', strat.metrics?.netProfit, 'grossP:', strat.metrics?.grossProfit);

const trades = parse(await client.callTool({ name: 'data_get_trades', arguments: { max_trades: 3 } }));
console.log('trade list:', trades.trade_count, trades.strategy_name);

await client.close();
