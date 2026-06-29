import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parse = (r) => JSON.parse(r.content[0].text);

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src/server.js')], cwd: ROOT });
const client = new Client({ name: 'probe', version: '1' });
await client.connect(transport);

const r = parse(await client.callTool({
  name: 'ui_evaluate',
  arguments: {
    expression: `(function() {
      var out = {};
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb) {
          out.bwbKeys = Object.keys(bwb).slice(0, 40);
          var w = bwb._widgets && bwb._widgets['pine-editor'];
          if (w) out.pineWidgetKeys = Object.keys(w).slice(0, 40);
        }
      } catch (e) { out.bwbErr = e.message; }
      var btns = [];
      document.querySelectorAll('button').forEach(function(b) {
        var t = b.textContent.trim();
        if (/save|publish/i.test(t) && b.offsetParent) btns.push({ t: t.slice(0, 40), y: Math.round(b.getBoundingClientRect().y), cls: (b.className || '').slice(0, 40) });
      });
      out.buttons = btns;
      return out;
    })()`,
  },
}));

console.log(JSON.stringify(r, null, 2));
await client.close();
