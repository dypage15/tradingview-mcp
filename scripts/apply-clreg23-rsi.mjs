#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
spawnSync(process.execPath, [join(dir, 'apply-clreg23-asia-ny.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, CLREG23_CONFLUENCE: 'RSI' },
});
