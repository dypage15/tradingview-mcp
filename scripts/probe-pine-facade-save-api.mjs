import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, disconnect } from '../src/connection.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const id = 'USER;5dd67c10ef8a4b01985c816223402f27';
const src = readFileSync(join(ROOT, 'indicators/03-bb-confluence.pine'), 'utf8');
const body = JSON.stringify({ source: src });

const paths = [
  `https://pine-facade.tradingview.com/pine-facade/save/${id}`,
  `https://pine-facade.tradingview.com/pine-facade/save/${id}/1`,
  `https://pine-facade.tradingview.com/pine-facade/update/${id}`,
  `https://pine-facade.tradingview.com/pine-facade/put/${id}/1`,
  `https://pine-facade.tradingview.com/pine-facade/write/${id}`,
];

const escapedBody = JSON.stringify(body);
const pathsJson = JSON.stringify(paths);

const r = await evaluate(`
(function() {
  var paths = ${pathsJson};
  var body = ${escapedBody};
  return Promise.all(paths.map(function(url) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    })
      .then(function(res) {
        return res.text().then(function(t) {
          return { url: url, status: res.status, preview: t.slice(0, 120) };
        });
      })
      .catch(function(e) { return { url: url, error: e.message }; });
  }));
})()
`);

console.log(JSON.stringify(r, null, 2));
await disconnect();
