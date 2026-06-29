/**
 * Repairs UTF-8 Text that was mis-decoded as Windows-1252 / Latin-1 (mojibake).
 */
import { readFileSync, writeFileSync } from 'fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/fix-pine-utf8-garbled.mjs <path.pine>');
  process.exit(1);
}

let s = readFileSync(path, 'utf8');

// Full decorative comment lines only
s = s.replace(/^\/\/ (?:(?:ΓöÇ)|(?:ΓòÉ))+\r?$/gm, `// ${'-'.repeat(76)}`);

/** Long / multi-char first to avoid chopping compound sequences */
const replacements = [
  ['ΓùóΓùñ', '\u25e2\u25e4'], // ◢◤
  ['ΓùÑΓùú', '\u25e5\u25e3'], // ◥◣
  ['ΓÇª', '\u2026'],       // …
  ['ΓÇö', '\u2014'],       // —
  ['ΓÇô', '\u2013'],       // –
  ['ΓëÑ', '\u2265'],       // ≥
  ['ΓåÆ', '\u2192'],       // →
  ['Γåæ', '\u2191'],       // ↑
  ['Γåô', '\u2193'],       // ↓
  ['ΓêÆ', '\u2212'],       // − (minus sign)
  ['┬╖', '\u00b7'],        // ·
  ['├ù', '\u00d7'],        // ×
  ['Γû╕', '\u25b8'],       // ▸
  ['Γû▓', '\u25b2'],       // ▲
  ['Γû╝', '\u25bc'],       // ▼
  ['ΓÜí', '\u26a1'],       // ⚡
  ['Γå╗', '\u21bb'],       // ↻
  ['Γùñ', '\u25e4'],
  ['Γùú', '\u25e3'],
  ['Γùå', '\u25c6'],
  ['ΓùÅ', '\u25cf'],
  ['Γùï', '\u25cb'],
];

for (const [bad, good] of replacements) {
  while (s.includes(bad)) {
    s = s.split(bad).join(good);
  }
}

s = s.split('ΓöÇ').join('-');
s = s.split('ΓòÉ').join('=');

writeFileSync(path, s, 'utf8');
console.log('fixed UTF-8 mojibake:', path);
