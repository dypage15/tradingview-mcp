/**
 * One-shot: fix Pine shorttitle length for Sweep Secondary (TV max 10 chars).
 */
import { ensurePineEditorOpen, getSource, setSource, getErrors } from '../src/core/pine.js';
import { disconnect } from '../src/connection.js';

const FROM = 'shorttitle="Sweep v2 Sec"';
const TO = 'shorttitle="Sweep v2 S"';

await ensurePineEditorOpen();
const { source } = await getSource();
if (!source.includes(FROM)) {
  console.log('Pattern not found; already fixed or different script.');
  console.log(await getErrors());
  await disconnect();
  process.exit(0);
}
const next = source.replace(FROM, TO);
await setSource({ source: next });
const err = await getErrors();
console.log(JSON.stringify({ replaced: true, errors: err }, null, 2));
await disconnect();
