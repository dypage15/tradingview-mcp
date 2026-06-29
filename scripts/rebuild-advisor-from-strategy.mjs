/**
 * Rebuild indicator advisor from strategy: strips strategy block only.
 * Usage: node scripts/rebuild-advisor-from-strategy.mjs
 */
import fs from 'fs';

const stratPath = 'C:/Users/dypag/CHOCH_BOS_MACD_Sniper_Strategy.pine';
const advPath = 'C:/Users/dypag/CHOCH_BOS_MACD_Market_Structure_advisor.pine';

const lines = fs.readFileSync(stratPath, 'utf8').split(/\r?\n/);

const indicatorHdr =
  "indicator('CHOCH & BOS (MACD Swing-Based) MTF + Trendlines + POC Rejection Dashboard', shorttitle = 'MACD Market Structure', overlay = false, max_lines_count = 500, max_labels_count = 500, max_boxes_count = 500)";

const iStrat = lines.findIndex((l) => l.startsWith('strategy('));
const iStratBlock = lines.findIndex((l) => l.includes('Strategy Tester - execution'));
const iDash = lines.findIndex((l) => l.includes('COMBINED DASHBOARD'));

if (iStrat < 0 || iStratBlock < 0 || iDash < 0) {
  console.error('markers not found', { iStrat, iStratBlock, iDash });
  process.exit(1);
}

const head = [`//@version=6`, indicatorHdr, ...lines.slice(iStrat + 1, iStratBlock)];
const tail = lines.slice(iDash - 1); // keep "// ===== ... DASHBOARD" line onward

const out = [...head, ...tail].join('\n') + '\n';
fs.writeFileSync(advPath, out, 'utf8');
console.log('wrote', advPath, 'lines', out.split('\n').length);
