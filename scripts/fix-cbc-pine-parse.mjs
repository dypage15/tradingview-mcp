#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tv = join(root, 'src', 'cli', 'index.js');

const PINE_FILE = process.env.CBC_PINE_FILE || 'cbc-engine-asia-sweep-mmt-v2.pine';
const TITLE_HINT = (process.env.TV_STRATEGY_NAME || 'CBC Engine + Asia Sweep [MMT v2]').trim();
const MAX_ROUNDS = Number(process.env.CBC_PARSE_FIX_ROUNDS || 6);
const BUF = 50 * 1024 * 1024;

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function tvJson(args, label = args.join(' ')) {
  try {
    const out = execFileSync(process.execPath, [tv, ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: BUF,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch (e) {
    const msg = e?.message || String(e);
    throw new Error(`[${label}] failed: ${msg}`);
  }
}

function findStudyIdByName() {
  const st = tvJson(['state'], 'state');
  const studies = st.studies || [];
  const hit = studies.find((s) => (s.name || '').toLowerCase().includes(TITLE_HINT.toLowerCase()));
  return hit?.id || null;
}

function compileAndReadErrors() {
  const c = tvJson(['pine', 'compile'], 'pine compile');
  const e = tvJson(['pine', 'errors'], 'pine errors');
  return { compile: c, errors: e };
}

function removeAndReaddIfPresent() {
  const id = findStudyIdByName();
  if (id) {
    try { tvJson(['indicator', 'remove', id], 'indicator remove'); } catch {}
    sleep(1000);
  }
  // Add from Pine editor by raw compile click.
  tvJson(['pine', 'raw-compile'], 'pine raw-compile');
  sleep(1200);
}

function main() {
  const pinePath = join(root, PINE_FILE);
  if (!existsSync(pinePath)) {
    throw new Error(`Pine file not found: ${pinePath}`);
  }

  tvJson(['ui', 'panel', 'pine-editor', 'open'], 'open pine-editor');
  tvJson(['pine', 'set', '--file', pinePath], 'pine set');
  sleep(800);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const { compile, errors } = compileAndReadErrors();
    const hasErrors = errors?.has_errors === true && Number(errors?.error_count || 0) > 0;
    const parseLike = (errors?.errors || []).some((x) =>
      /parse|mismatched|syntax|expect/i.test(String(x?.message || ''))
    );
    console.error(
      `[fix-cbc-parse] round ${round}/${MAX_ROUNDS} has_errors=${!!hasErrors} parse_like=${!!parseLike} study_added=${compile?.study_added === true}`
    );
    if (!hasErrors) {
      const id = findStudyIdByName();
      console.log(
        JSON.stringify({
          success: true,
          rounds: round,
          strategy_id: id,
          strategy_name_hint: TITLE_HINT,
          message: 'Pine compile clean with zero errors.',
        }, null, 2)
      );
      return;
    }
    removeAndReaddIfPresent();
    tvJson(['pine', 'set', '--file', pinePath], 'pine set');
    sleep(800);
  }

  const finalErrors = tvJson(['pine', 'errors'], 'pine errors');
  console.log(
    JSON.stringify({
      success: false,
      message: 'Parse/compile errors persist after fix rounds.',
      errors: finalErrors,
    }, null, 2)
  );
  process.exit(2);
}

main();

