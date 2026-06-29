/**
 * Check what's actually stored in TradingView cloud for NLF scripts.
 */
import { evaluate, disconnect } from '../src/connection.js';

const SCRIPTS = [
  { label: '01 — Cloud Regime', id: 'USER;954e7ef8b6de4533a779db83cc0cbae6', ver: '1' },
  { label: '01 — Cloud Regime 1 (dup)', id: 'USER;9aa3c1c6e71b4f359966634543dc56ad', ver: '52' },
  { label: '02 — RSI Confluence', id: 'USER;8560c5fdbc64445ab0897b7a8fd2309e', ver: '1' },
  { label: '03 — BB Confluence', id: 'USER;5dd67c10ef8a4b01985c816223402f27', ver: '1' },
];

for (const { label, id, ver } of SCRIPTS) {
  const data = await evaluate(`
    fetch('https://pine-facade.tradingview.com/pine-facade/get/${id}/${ver}', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const src = d.source || '';
        return {
          lines: src.split('\\n').length,
          hasVarTable: src.includes('var table'),
          hasLineContBug: /cloudScore = anyFlip[^\\n]*\\n\\s+\\?/.test(src),
          firstLine: src.split('\\n')[0],
        };
      })
  `);
  console.log(label, data);
}

await disconnect();
