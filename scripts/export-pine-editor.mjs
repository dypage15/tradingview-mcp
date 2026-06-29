#!/usr/bin/env node
/**
 * Dump current Pine Editor buffer to stdout or a file.
 * Requires TradingView Desktop with CDP (port 9222) and Pine Editor open
 * (optionally: open a saved script first via MCP `pine_open` or TV UI).
 *
 * Usage:
 *   node scripts/export-pine-editor.mjs
 *   node scripts/export-pine-editor.mjs path/to/out.pine
 */
import { writeFileSync } from 'fs';
import { getSource } from '../src/core/pine.js';

const out = process.argv[2];
const r = await getSource();
const text = r.source.replace(/\r\n/g, '\n');
if (out) {
  writeFileSync(out, text, 'utf8');
  console.error(`Wrote ${out} (${r.line_count} lines, ${text.length} chars)`);
} else {
  process.stdout.write(text);
}
