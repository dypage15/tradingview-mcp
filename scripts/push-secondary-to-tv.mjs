/**
 * Load sweep-engine-v2-secondary.pine into the open TradingView Pine editor and save to chart.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ensurePineEditorOpen, setSource, compile, getErrors } from '../src/core/pine.js';
import { disconnect } from '../src/connection.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'sweep-engine-v2-secondary.pine'), 'utf8');

await ensurePineEditorOpen();
await setSource({ source: src });
await compile();
await new Promise((r) => setTimeout(r, 2800));
const err = await getErrors();
console.log(JSON.stringify(err, null, 2));
await disconnect();
