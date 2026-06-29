#!/usr/bin/env node
/**
 * Push scripts/current.pine → TradingView editor, then compile.
 * Opens the Pine widget first (TradingView hides Monaco until the editor tab is focused).
 */
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';

const srcPath = new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const src = readFileSync(srcPath, 'utf-8');

const OPEN_PINE_JS = `
(function(){
  try {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (!bwb) return 'no_bottom_bar';
    if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
    else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    var btn = document.querySelector('[aria-label="Pine"]')
      || document.querySelector('[data-name="pine-dialog-button"]');
    if (btn) btn.click();
    return 'opened';
  } catch (e) { return 'error:' + (e && e.message); }
})()`;

async function pineMonacoReady(Runtime) {
  const r = await Runtime.evaluate({
    expression: `(function(){ return !!document.querySelector('.monaco-editor.pine-editor-monaco'); })()`,
    returnByValue: true,
  });
  return !!r.result?.value;
}

async function ensurePineEditorOpen(Runtime, maxWaitMs = 10000) {
  if (await pineMonacoReady(Runtime)) return true;
  await Runtime.evaluate({ expression: OPEN_PINE_JS, returnByValue: true });
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 200));
    if (await pineMonacoReady(Runtime)) return true;
  }
  return false;
}

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find((x) => x.url?.includes('tradingview.com'));
if (!t) {
  console.error('No TradingView target');
  process.exit(1);
}
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

const ready = await ensurePineEditorOpen(c.Runtime);
if (!ready) console.error('Warning: Monaco Pine editor did not mount in time — injection may fail');

// Inject source (fiber walk — same discovery as MCP pine_set_source)
const escaped = JSON.stringify(src);
async function tryInject() {
  const set = await c.Runtime.evaluate({
    expression: `(function(){var c=document.querySelector(".monaco-editor.pine-editor-monaco");if(!c)return false;var el=c;var fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}if(!fk)return false;var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0){eds[0].setValue(${escaped});return true}}}cur=cur.return}return false})()`,
    returnByValue: true,
  });
  return !!set.result?.value;
}

let injected = await tryInject();
for (let a = 0; !injected && a < 5; a++) {
  await ensurePineEditorOpen(c.Runtime);
  await new Promise((r) => setTimeout(r, 400));
  injected = await tryInject();
}

if (!injected) {
  console.error('Could not inject into Pine editor (open Pine Editor from TV and retry)');
  await c.close();
  process.exit(1);
}
console.log(`Pushed ${src.split('\n').length} lines → Pine editor`);

// Click compile / update buttons (second pass catches post-save UI)
async function clickCompilePass() {
  const expr =
    `(function(){var btns=document.querySelectorAll("button");for(var i=0;i<btns.length;i++){var t=btns[i].textContent.trim();if(/save and add to chart/i.test(t)){btns[i].click();return t}if(/^update on chart/i.test(t)){btns[i].click();return t}}for(var i=0;i<btns.length;i++){var tx=btns[i].textContent.trim();if(/^add to chart$/i.test(tx)&&!/save and/i.test(tx)){btns[i].click();return tx}}for(var i=0;i<btns.length;i++){if(btns[i].className.indexOf("saveButton")!==-1&&btns[i].offsetParent!==null){btns[i].click();return "Pine Save"}}return null})()`;
  return (await c.Runtime.evaluate({ expression: expr, returnByValue: true })).result?.value;
}

let clicked = await clickCompilePass();
if (!clicked) {
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  clicked = 'keyboard fallback';
}

console.log('Compile:', clicked || '(none)');
await new Promise((r) => setTimeout(r, 2200));

const clicked2 = await clickCompilePass();
if (clicked2 && clicked2 !== clicked) console.log('Compile (2nd pass):', clicked2);

// Wait then check errors
await new Promise((r) => setTimeout(r, 800));
const errors = (await c.Runtime.evaluate({
  expression:
    '(function(){var c=document.querySelector(".monaco-editor.pine-editor-monaco");if(!c)return[];var el=c;var fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}if(!fk)return[];var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0){var model=eds[0].getModel();var markers=env.editor.getModelMarkers({resource:model.uri});return markers.map(function(m){return{line:m.startLineNumber,msg:m.message}})}}}cur=cur.return}return[]})()',
  returnByValue: true,
})).result?.value || [];

if (errors.length === 0) {
  console.log('✅ Compiled clean — 0 errors');
} else {
  console.log(`❌ ${errors.length} errors:`);
  errors.forEach((e) => console.log(`  Line ${e.line}: ${e.msg}`));
}

await c.close();
