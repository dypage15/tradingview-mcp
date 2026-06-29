/**
 * Capture network when saving an opened-by-ID Pine script.
 */
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.TRADINGVIEW_CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.TRADINGVIEW_CDP_PORT || 9222);
const SCRIPT_ID = 'USER;5dd67c10ef8a4b01985c816223402f27';

const targets = await (await fetch(`http://${HOST}:${PORT}/json/list`)).json();
const t = targets.find((x) => x.url?.includes('tradingview.com/chart'));
if (!t) {
  console.error('No TV chart target');
  process.exit(1);
}

const c = await CDP({ host: HOST, port: PORT, target: t.id });
await c.Runtime.enable();
await c.Network.enable();

const saves = [];
c.Network.on('requestWillBeSent', (params) => {
  const url = params.request.url || '';
  if (/tradingview\.com/i.test(url)) saves.push({ url, method: params.request.method });
});

const src = readFileSync(join(ROOT, 'indicators/03-bb-confluence.pine'), 'utf8');

// Open pine editor + load script from facade by ID
const openRes = await c.Runtime.evaluate({
  expression: `(function() {
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (bwb && bwb.activateScriptEditorTab) bwb.activateScriptEditorTab();
    var id = ${JSON.stringify(SCRIPT_ID)};
    return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(r => r.json())
      .then(list => {
        var m = list.find(s => s.scriptIdPart === id);
        if (!m) return { err: 'not in list' };
        var ver = String(m.version || '1').replace(/\\.0$/, '');
        return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
          .then(r2 => r2.json())
          .then(data => {
            var c = document.querySelector('.monaco-editor.pine-editor-monaco');
            if (!c) return { err: 'no monaco' };
            var el = c, fk;
            for (var i = 0; i < 20; i++) {
              if (!el) break;
              fk = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
              if (fk) break;
              el = el.parentElement;
            }
            if (!fk) return { err: 'no fiber' };
            var cur = el[fk];
            for (var d = 0; d < 15; d++) {
              if (!cur) break;
              if (cur.memoizedProps && cur.memoizedProps.value && cur.memoizedProps.value.monacoEnv) {
                cur.memoizedProps.value.monacoEnv.editor.getEditors()[0].setValue(data.source || '');
                return { ok: true, lines: (data.source || '').split('\\n').length };
              }
              cur = cur.return;
            }
            return { err: 'no editor' };
          });
      });
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
console.log('open:', openRes.result?.value);

await new Promise((r) => setTimeout(r, 1500));

// Patch source
const escaped = JSON.stringify(src);
await c.Runtime.evaluate({
  expression: `(function(){
    var c=document.querySelector('.monaco-editor.pine-editor-monaco');
    var el=c,fk;
    for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));if(fk)break;el=el.parentElement}
    var cur=el[fk];
    for(var d=0;d<15;d++){
      if(!cur)break;
      if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){
        cur.memoizedProps.value.monacoEnv.editor.getEditors()[0].setValue(${escaped});
        return (cur.memoizedProps.value.monacoEnv.editor.getEditors()[0].getValue()||'').split('\\n').length;
      }
      cur=cur.return;
    }
  })()`,
  returnByValue: true,
});
console.log('patched lines:', (await c.Runtime.evaluate({ expression: '1', returnByValue: true })).result?.value);

const before = saves.length;
await c.Runtime.evaluate({
  expression: `(function(){
    var btns=document.querySelectorAll('button');
    for(var i=0;i<btns.length;i++){
      if(btns[i].className.indexOf('saveButton')!==-1&&btns[i].offsetParent){btns[i].click();return true;}
    }
  })()`,
  returnByValue: true,
});
await new Promise((r) => setTimeout(r, 6000));

console.log('requests after save:', saves.length - before);
saves.slice(before).forEach((s) => console.log(s.method, s.url.slice(0, 100)));

await c.close();
