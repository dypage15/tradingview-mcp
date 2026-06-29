import { evaluate, disconnect } from '../src/connection.js';

const r = await evaluate(`
(function() {
  var btns = [];
  document.querySelectorAll('button').forEach(function(b) {
    var t = b.textContent.trim();
    if (/save|publish/i.test(t) && b.offsetParent) {
      btns.push({ text: t, className: b.className, y: Math.round(b.getBoundingClientRect().y) });
    }
  });
  return { buttons: btns };
})()
`);
console.log(JSON.stringify(r, null, 2));
await disconnect();
