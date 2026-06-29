/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS } from '../connection.js';
import { strategyTesterClickUpdateReportIfPresent } from './ui.js';
import { buildResolveBenchStudyHandlesBlock } from './studyBenchResolve.js';

const MAX_OHLCV_BARS = 500;
/** Upper bound for trade list extraction; override with env TV_MAX_TRADES_HARD_CAP (e.g. advisor needs more rows). */
const MAX_TRADES = Number(process.env.TV_MAX_TRADES_HARD_CAP || 200);
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

/** Escape for embedding in Runtime.evaluate single-quoted string */
function embedStrategyPickFilter() {
  const explicit = process.env.ADVISOR_STRATEGY_SUBSTRING;
  const alias = process.env.TV_STRATEGY_NAME;
  let raw;
  if (explicit !== undefined) {
    raw = explicit.trim();
  } else if (alias !== undefined && alias !== null) {
    raw = alias.trim();
  } else {
    // No env set: do not filter by name (otherwise a hard-coded substring can pin the wrong study when
    // multiple strategies exist on the chart). Set ADVISOR_STRATEGY_SUBSTRING or TV_STRATEGY_NAME to pin one.
    raw = '';
  }
  return raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}

/**
 * Embedded in Runtime.evaluate: pick the Pine strategy study (metrics / trades / equity).
 * With no env vars, name filtering is off (highest internal score wins among strategies on chart).
 * Set ADVISOR_STRATEGY_SUBSTRING or TV_STRATEGY_NAME to pin one study (e.g. "CBC LIQUIDITY PRO V6 FIXED").
 * Built per call so process.env reflects the current run (e.g. advisor subprocess inheriting .env).
 */
function pickStrategyDetailJs() {
  const escaped = embedStrategyPickFilter();
  return `
function strategyDataReadyBonus(s) {
  var bonus = 0;
  try {
    if (s.reportData) {
      var rd = typeof s.reportData === 'function' ? s.reportData() : s.reportData;
      if (rd != null && typeof rd === 'object' && typeof rd.value === 'function') rd = rd.value();
      if (rd != null && typeof rd === 'object') {
        bonus += 150;
        try {
          var rkeys = Object.keys(rd);
          if (rkeys.length > 0) bonus += 100;
        } catch (rk) {}
        if (Array.isArray(rd.trades) && rd.trades.length > 0) bonus += 120;
        if (Array.isArray(rd.filledOrders) && rd.filledOrders.length > 0) bonus += 120;
      }
    }
  } catch (e1) {}
  try {
    if (s.ordersData) {
      var od = typeof s.ordersData === 'function' ? s.ordersData() : s.ordersData;
      if (od != null && typeof od === 'object' && typeof od.value === 'function') od = od.value();
      if (Array.isArray(od)) bonus += od.length > 0 ? 250 : 50;
    }
  } catch (e2) {}
  return bonus;
}
function extractStrategyOrdersList(strat) {
  var orders = null;
  try {
    if (strat.ordersData) {
      orders = typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData;
      if (orders != null && typeof orders === 'object' && typeof orders.value === 'function') orders = orders.value();
    }
  } catch (e) { orders = null; }
  if (orders != null && Array.isArray(orders)) return orders;
  try {
    if (strat.reportData) {
      var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
      if (rd != null && typeof rd === 'object' && typeof rd.value === 'function') rd = rd.value();
      if (rd != null && typeof rd === 'object') {
        if (Array.isArray(rd.trades)) return rd.trades;
        if (Array.isArray(rd.filledOrders)) return rd.filledOrders;
      }
    }
  } catch (e2) {}
  return null;
}
function pickStrategySourceDetailed(sources) {
  var NAME_FILTER = '${escaped}';
  var candidates = [];
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    if (!s.metaInfo) continue;
    var meta = s.metaInfo();
    if (!(s.reportData || s.performance || s.ordersData)) continue;
    var score = 0;
    if (meta.isTVScriptStrategy === true) score += 100;
    if (s.reportData) score += 50;
    var desc = (meta.description || meta.shortDescription || '');
    if (/strategy/i.test(desc)) score += 10;
    score += strategyDataReadyBonus(s);
    candidates.push({ s: s, score: score, desc: desc });
  }
  var pickNote = null;
  if (candidates.length === 0) {
    return { strat: null, name: '', pickNote: null, candidateCount: 0 };
  }
  function pickBest(arr) {
    var best = arr[0];
    for (var k = 1; k < arr.length; k++) {
      if (arr[k].score > best.score) best = arr[k];
    }
    return best;
  }
  var pool = candidates;
  if (NAME_FILTER) {
    var filtered = [];
    var nf = NAME_FILTER.toLowerCase();
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].desc.toLowerCase().indexOf(nf) !== -1) filtered.push(candidates[j]);
    }
    if (filtered.length >= 1) {
      pool = filtered;
      if (filtered.length > 1) {
        pickNote = 'Multiple strategies match ADVISOR_STRATEGY_SUBSTRING — picked highest internal score among matches.';
      }
    } else {
      pickNote = 'ADVISOR_STRATEGY_SUBSTRING did not match any strategy name; using best-scoring strategy on chart.';
      pool = candidates;
    }
  } else if (candidates.length > 1) {
    pickNote = 'Multiple strategies on chart — picked highest internal score. Set ADVISOR_STRATEGY_SUBSTRING (e.g. Sweep v2) to pin one.';
  }
  var best = pickBest(pool);
  return { strat: best.s, name: best.desc, pickNote: pickNote, candidateCount: candidates.length };
}
function pickStrategySource(sources) {
  var d = pickStrategySourceDetailed(sources);
  if (d.strat) return d.strat;
  for (var j = 0; j < sources.length; j++) {
    var s2 = sources[j];
    if (s2.metaInfo && s2.metaInfo().is_price_study === false && (s2.reportData || s2.performance || s2.ordersData)) return s2;
  }
  return null;
}
`;
}

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = '${filter}';
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: Math.round((Math.max(...highs) - Math.min(...lows)) * 100) / 100,
      change: Math.round((last.close - first.open) * 100) / 100,
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getIndicator({ entity_id }) {
  const escapedId = String(entity_id || '').replace(/'/g, "\\'");
  const resolveBlock = buildResolveBenchStudyHandlesBlock(escapedId);
  const data = await evaluate(`
    (function() {
      ${resolveBlock}
      var api = ${CHART_API};
      var study = __resolveBenchStudyForInputs(api);
      if (!study) return { error: 'Study not found: ${escapedId}' };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

export async function getStrategyResults() {
  await strategyTesterClickUpdateReportIfPresent();
  const results = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        ${pickStrategyDetailJs()}
        var pick = pickStrategySourceDetailed(sources);
        var strat = pick.strat;
        if (!strat) return {metrics: {}, source: 'internal_api', strategyName: pick.name, pickNote: pick.pickNote, candidateCount: pick.candidateCount, error: 'No strategy found on chart. Add a strategy indicator first.'};
        var metrics = {};
        if (strat.reportData) {
          var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
          if (rd && typeof rd === 'object') {
            if (typeof rd.value === 'function') rd = rd.value();
            if (rd) {
              var skipBulk = { buyHold: 1, buyHoldPercent: 1, filledOrders: 1, trades: 1, performance: 1 };
              var keys = Object.keys(rd);
              for (var k = 0; k < keys.length; k++) {
                var key = keys[k];
                if (skipBulk[key]) continue;
                var val = rd[key];
                if (val !== null && val !== undefined && typeof val === 'object' && typeof val.value === 'function') {
                  try { val = val.value(); } catch (ev) { continue; }
                }
                if (val !== null && val !== undefined && typeof val !== 'function') {
                  if (Array.isArray(val) && val.length > 100) continue;
                  metrics[key] = val;
                }
              }
            }
            if (rd && rd.performance) {
              var perfInner = rd.performance;
              if (typeof perfInner.value === 'function') perfInner = perfInner.value();
              if (perfInner && perfInner.all) {
                var allInner = perfInner.all;
                if (typeof allInner.value === 'function') allInner = allInner.value();
                if (allInner && typeof allInner === 'object') {
                  var akeys = Object.keys(allInner);
                  for (var ai = 0; ai < akeys.length; ai++) {
                    var ak = akeys[ai];
                    var aval = allInner[ak];
                    if (aval !== null && aval !== undefined && typeof aval === 'function') continue;
                    if (aval !== null && aval !== undefined && typeof aval === 'object' && typeof aval.value === 'function') aval = aval.value();
                    if (aval !== null && aval !== undefined && typeof aval !== 'function') metrics[ak] = aval;
                  }
                }
              }
            }
          }
        }
        if (Object.keys(metrics).length === 0 && strat.performance) {
          var perf = strat.performance();
          if (perf && typeof perf.value === 'function') perf = perf.value();
          if (perf && typeof perf === 'object') {
            var pkeys = Object.keys(perf);
            for (var p = 0; p < pkeys.length; p++) {
              var pval = perf[pkeys[p]];
              if (pval !== null && pval !== undefined && typeof pval === 'object' && typeof pval.value === 'function') {
                try { pval = pval.value(); } catch (ep) { continue; }
              }
              if (pval !== null && pval !== undefined && typeof pval !== 'function') metrics[pkeys[p]] = pval;
            }
          }
        }
        var reportReady = false;
        try {
          var rd0 = strat.reportData ? (typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData) : null;
          if (rd0 != null && typeof rd0 === 'object' && typeof rd0.value === 'function') rd0 = rd0.value();
          reportReady = !!(rd0 && typeof rd0 === 'object' && Object.keys(rd0).length > 0);
        } catch (er) { reportReady = false; }
        return {metrics: metrics, source: 'internal_api', strategyName: pick.name, pickNote: pick.pickNote, candidateCount: pick.candidateCount, report_ready: reportReady};
      } catch(e) { return {metrics: {}, source: 'internal_api', error: e.message}; }
    })()
  `);
  const metricCount = Object.keys(results?.metrics || {}).length;
  const hint =
    !results?.error && metricCount === 0 && results?.report_ready === false
      ? 'Strategy Tester has no report yet for the selected study (reportData is empty). Open Strategy Tester, wait for the backtest to finish, fix compile/runtime errors, or run a deep backtest. Charts with only a loading strategy show zero metrics until calculation completes.'
      : undefined;
  return {
    success: true,
    metric_count: metricCount,
    source: results?.source,
    metrics: results?.metrics || {},
    strategy_name: results?.strategyName,
    pick_note: results?.pickNote,
    candidate_count: results?.candidateCount,
    error: results?.error,
    report_ready: results?.report_ready,
    hint,
  };
}

export async function getTrades({ max_trades } = {}) {
  await strategyTesterClickUpdateReportIfPresent();
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const trades = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        ${pickStrategyDetailJs()}
        var pick = pickStrategySourceDetailed(sources);
        var strat = pick.strat;
        if (!strat) return {trades: [], source: 'internal_api', strategyName: pick.name, pickNote: pick.pickNote, candidateCount: pick.candidateCount, error: 'No strategy found on chart.'};
        var orders = extractStrategyOrdersList(strat);
        if (!orders || !Array.isArray(orders)) {
          if (strat._orders && Array.isArray(strat._orders)) orders = strat._orders;
          else if (strat.tradesData) {
            try {
              orders = typeof strat.tradesData === 'function' ? strat.tradesData() : strat.tradesData;
              if (orders != null && typeof orders === 'object' && typeof orders.value === 'function') orders = orders.value();
            } catch (et) { orders = null; }
          }
        }
        if (!orders || !Array.isArray(orders)) {
          return {
            trades: [],
            source: 'internal_api',
            strategyName: pick.name,
            pickNote: pick.pickNote,
            candidateCount: pick.candidateCount,
            error: 'No trade list available yet.',
            hint: 'TradingView only populates orders after the strategy backtest completes. Open Strategy Tester, confirm there are no compile errors, wait for calculation (or run Deep Backtesting). If you use ADVISOR_STRATEGY_SUBSTRING / TV_STRATEGY_NAME, ensure it matches the study that actually has results.'
          };
        }
        var result = [];
        for (var t = 0; t < Math.min(orders.length, ${limit}); t++) {
          var o = orders[t];
          if (typeof o === 'object' && o !== null) {
            var trade = {};
            var okeys = Object.keys(o);
            for (var k = 0; k < okeys.length; k++) {
              var key = okeys[k];
              var v = o[key];
              if (v === null || v === undefined || typeof v === 'function') continue;
              if (typeof v !== 'object') trade[key] = v;
              else {
                var sk = Object.keys(v);
                for (var si = 0; si < sk.length; si++) {
                  var sv = v[sk[si]];
                  if (sv !== null && sv !== undefined && typeof sv !== 'function' && typeof sv !== 'object') {
                    trade[key + '_' + sk[si]] = sv;
                  }
                }
              }
            }
            result.push(trade);
          }
        }
        return {trades: result, source: 'internal_api', strategyName: pick.name, pickNote: pick.pickNote, candidateCount: pick.candidateCount};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: true,
    trade_count: trades?.trades?.length || 0,
    source: trades?.source,
    trades: trades?.trades || [],
    strategy_name: trades?.strategyName,
    pick_note: trades?.pickNote,
    candidate_count: trades?.candidateCount,
    error: trades?.error,
  };
}

export async function getEquity() {
  await strategyTesterClickUpdateReportIfPresent();
  const equity = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        ${pickStrategyDetailJs()}
        var pick = pickStrategySourceDetailed(sources);
        var strat = pick.strat;
        if (!strat) return {data: [], source: 'internal_api', strategyName: pick.name, pickNote: pick.pickNote, candidateCount: pick.candidateCount, error: 'No strategy found on chart.'};
        var data = [];
        if (strat.equityData) {
          var eq = typeof strat.equityData === 'function' ? strat.equityData() : strat.equityData;
          if (eq && typeof eq.value === 'function') eq = eq.value();
          if (Array.isArray(eq)) data = eq;
        }
        if (data.length === 0 && strat.bars) {
          var bars = typeof strat.bars === 'function' ? strat.bars() : strat.bars;
          if (bars && typeof bars.lastIndex === 'function') {
            var end = bars.lastIndex(); var start = bars.firstIndex();
            for (var i = start; i <= end; i++) { var v = bars.valueAt(i); if (v) data.push({time: v[0], equity: v[1], drawdown: v[2] || null}); }
          }
        }
        if (data.length === 0) {
          var perfData = {};
          if (strat.performance) {
            var perf = strat.performance();
            if (perf && typeof perf.value === 'function') perf = perf.value();
            if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { if (/equity|drawdown|profit|net/i.test(pkeys[p])) perfData[pkeys[p]] = perf[pkeys[p]]; } }
          }
          if (Object.keys(perfData).length > 0) return {data: [], equity_summary: perfData, source: 'internal_api', strategyName: pick.name, pickNote: pick.pickNote, candidateCount: pick.candidateCount, note: 'Full equity curve not available via API; equity summary metrics returned instead.'};
        }
        return {data: data, source: 'internal_api', strategyName: pick.name, pickNote: pick.pickNote, candidateCount: pick.candidateCount};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: true,
    data_points: equity?.data?.length || 0,
    source: equity?.source,
    data: equity?.data || [],
    equity_summary: equity?.equity_summary,
    note: equity?.note,
    strategy_name: equity?.strategyName,
    pick_note: equity?.pickNote,
    candidate_count: equity?.candidateCount,
    error: equity?.error,
  };
}

export async function getQuote({ symbol } = {}) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var sym = '${symbol || ''}';
      if (!sym) { try { sym = api.symbol(); } catch(e) {} }
      if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
      var ext = {};
      try { ext = api.symbolExt() || {}; } catch(e) {}
      var bars = ${BARS_PATH};
      var quote = { symbol: sym };
      if (bars && typeof bars.lastIndex === 'function') {
        var last = bars.valueAt(bars.lastIndex());
        if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
      }
      try {
        var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
        var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
        if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
        if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
      } catch(e) {}
      try {
        var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
        if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
      } catch(e) {}
      if (ext.description) quote.description = ext.description;
      if (ext.exchange) quote.exchange = ext.exchange;
      if (ext.type) quote.type = ext.type;
      return quote;
    })()
  `);
  if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
  return { success: true, ...data };
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = v.y1 != null ? Math.round(v.y1 * 100) / 100 : null;
      const y2 = v.y2 != null ? Math.round(v.y2 * 100) / 100 : null;
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = v.y != null ? Math.round(v.y * 100) / 100 : null;
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1, v.y2) * 100) / 100 : null;
      const low = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1, v.y2) * 100) / 100 : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
