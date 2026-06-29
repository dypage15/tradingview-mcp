/**
 * Embed in Runtime.evaluate snippets: pick the TradingView chart object that exposes
 * getInputValues()/setInputValues for a study/strategy entity id (getStudyById alone is unreliable).
 */

export function buildResolveBenchStudyHandlesBlock(escapedEntityId) {
  return `
function __collectStudyHandlesForId(api) {
  var id = '${escapedEntityId}';
  var list = [];
  try {
    var all = api.getAllStudies();
    for (var si = 0; si < all.length; si++) {
      if (all[si].id !== id) continue;
      list.push(all[si]);
      try {
        if (all[si]._study) list.push(all[si]._study);
      } catch (_) {}
    }
  } catch (_) {}
  try {
    var byId = api.getStudyById(id);
    if (byId) {
      list.push(byId);
      try {
        if (byId._study) list.push(byId._study);
      } catch (_) {}
    }
  } catch (_) {}
  return list;
}
function __resolveBenchStudyForInputs(api) {
  var list = __collectStudyHandlesForId(api);
  var best = null;
  var bestLen = -1;
  for (var li = 0; li < list.length; li++) {
    var h = list[li];
    if (!h || typeof h.getInputValues !== 'function') continue;
    try {
      var iv = h.getInputValues();
      var L = iv ? iv.length : 0;
      if (L > bestLen) {
        best = h;
        bestLen = L;
      }
    } catch (_) {}
  }
  return best;
}
function __resolveStudyForVisibility(api) {
  var list = __collectStudyHandlesForId(api);
  for (var vi = 0; vi < list.length; vi++) {
    var h = list[vi];
    if (h && typeof h.setVisible === 'function' && typeof h.isVisible === 'function') return h;
  }
  return list[0] || null;
}`;
}
