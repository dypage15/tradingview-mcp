/**
 * Cloud Regime v3 Full Stack — grid helpers (research table + input mapping).
 */

/** Map grid spec → TradingView in_N keys (declaration order in pine). */
export function specToInputs(spec) {
  const s = spec || {};
  return {
    in_0: s.htfTF ?? '5',
    in_1: s.fastEmaLen ?? 9,
    in_2: s.slowEmaLen ?? 21,
    in_3: s.smaLen ?? 50,
    in_4: s.cloudSmooth ?? 3,
    in_5: s.cSlopeLen ?? 5,
    in_6: s.cSteepT ?? 0.15,
    in_7: s.macdFast ?? 12,
    in_8: s.macdSlow ?? 26,
    in_9: s.macdSig ?? 9,
    in_10: s.proxMult ?? 1.0,
    in_11: s.proxAtrLn ?? 14,
    in_12: s.vwapTrigMode ?? '2-Bar',
    in_13: s.adxLen ?? 14,
    in_14: s.adxSmooth ?? 14,
    in_15: s.zOptLow ?? 18,
    in_16: s.zOptHigh ?? 35,
    in_17: s.useDRSI ?? true,
    in_18: s.drsiRSILen ?? 21,
    in_19: s.drsiWindow ?? 14,
    in_20: s.drsiSigLen ?? 9,
    in_21: s.drsiMode ?? 'Direction Change',
    in_22: s.showBB ?? true,
    in_23: s.showWicks ?? true,
    in_24: s.wickBBLen ?? 20,
    in_25: s.wickBBMult ?? 2.0,
    in_26: s.wickRSILen ?? 14,
    in_27: s.rsiOversold ?? 30,
    in_28: s.rsiOverbought ?? 70,
    in_29: s.minWickConfDisplay ?? 3,
    in_30: s.tpPoints ?? 20,
    in_31: s.slPoints ?? 10,
    in_32: s.useSession ?? true,
    in_33: s.sessStart ?? '0930-1600',
    in_34: s.useLunchBlock ?? true,
    in_35: s.useTrendTier ?? true,
    in_36: s.useWickTier ?? true,
    in_37: s.wickMinConf ?? 2,
    in_38: s.wickMaxConfLong ?? 4,
    in_39: s.wickMaxConfShort ?? 4,
    in_40: s.wickRequireOs ?? false,
    in_41: s.wickRequireOb ?? true,
    in_42: s.wickBlockTrendStack ?? true,
    in_43: s.applyAdxBlockToWick ?? false,
    in_44: s.wickEntryStyle ?? 'Immediate',
    in_45: s.wickRetestBars ?? 20,
    in_46: s.wickRetestTol ?? 0.5,
    in_47: s.wickRetestLongAnchor ?? 'Signal High',
    in_48: s.wickRetestShortAnchor ?? 'Prior Close',
    in_49: s.showRetestLines ?? true,
    in_50: s.wickRetestSeparateBar ?? true,
    in_51: s.wickRetestConfirmCandle ?? false,
    in_52: s.showTable ?? true,
    in_53: s.enableResearch ?? true,
    in_54: s.outcomeLB ?? 10,
    in_55: s.clusterBars ?? 12,
    in_56: s.winThreshPts ?? 0,
    in_57: s.trackMfeMae ?? true,
    in_58: s.showResearchTable ?? true,
    in_59: s.adxEntryHigh ?? 35,
    in_60: s.enforce_adx ?? true,
    in_61: s.enforce_drsi ?? true,
    in_62: s.enforce_slope ?? true,
    in_63: s.enforce_session ?? true,
  };
}

export const CR3_DEFAULT_SPEC = {
  htfTF: '5',
  cloudSmooth: 3,
  zOptLow: 18,
  zOptHigh: 35,
  proxMult: 1.0,
  vwapTrigMode: '2-Bar',
  tpPoints: 20,
  slPoints: 10,
  useSession: true,
  sessStart: '0930-1600',
  useLunchBlock: true,
  enableResearch: true,
  outcomeLB: 10,
  clusterBars: 12,
  useTrendTier: true,
  useWickTier: true,
  wickMinConf: 2,
  wickMaxConfLong: 4,
  wickMaxConfShort: 4,
  wickRequireOs: false,
  wickRequireOb: true,
  wickBlockTrendStack: true,
  applyAdxBlockToWick: false,
  adxEntryHigh: 35,
  enforce_drsi: true,
  enforce_slope: true,
  minWickConfDisplay: 3,
};

/** Post–labeled-review production preset (dual tier + wick filters). */
export const CR3_LABELED_PROD_SPEC = { ...CR3_DEFAULT_SPEC };

export function pickCr3Entity(state) {
  const forced = (process.env.CR3_ENTITY_ID || process.env.CLREG22_ENTITY_ID || '').trim();
  if (forced) return forced;
  const sub = process.env.ADVISOR_STRATEGY_SUBSTRING || 'Full Stack';
  const hits = (state.studies || []).filter((s) => {
    const n = s.name || '';
    return /Full Stack|CR_v3|Cloud Regime v3/i.test(n) && !/v2\.|ClReg2/i.test(n);
  });
  if (!hits.length) {
    const loose = (state.studies || []).filter((s) => /CR_v3|Cloud Regime v3/i.test(s.name || ''));
    if (loose.length) return loose[loose.length - 1].id;
    throw new Error(`CR3 Full Stack not on chart (filter: ${sub})`);
  }
  return hits[hits.length - 1].id;
}

function numCell(s) {
  if (s == null || s === '—' || s === '') return NaN;
  const cleaned = String(s).replace(/[%+]/g, '').trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/** Parse CR3 RESEARCH table from data_get_pine_tables. */
export function parseResearchTable(pineTablesResult) {
  const study = pineTablesResult?.studies?.[0];
  const table = study?.tables?.find((t) => (t.rows?.[0] || '').includes('CR3 RESEARCH'));
  if (!table) return { parsed: false, buckets: [], raw: pineTablesResult };

  const header = table.rows[0] || '';
  const lbMatch = header.match(/lb=(\d+)/);
  const outcomeLB = lbMatch ? parseInt(lbMatch[1], 10) : NaN;

  const buckets = [];
  for (const row of table.rows.slice(1)) {
    const cols = row.split(' | ').map((s) => s.trim());
    if (cols.length < 4) continue;
    const signal = cols[0];
    if (!signal || signal === 'N') continue;
    buckets.push({
      signal,
      n: parseInt(cols[1], 10) || 0,
      winPct: numCell(cols[2]),
      avgPts: numCell(cols[3]),
      avgMfe: cols[4] != null ? numCell(cols[4]) : NaN,
      avgMae: cols[5] != null ? numCell(cols[5]) : NaN,
    });
  }

  const wickRows = buckets.filter((b) => /^W_/.test(b.signal));
  const trendRows = buckets.filter((b) => /^T_/.test(b.signal));
  const entryRows = buckets.filter((b) => /^E_/.test(b.signal));
  const wickEntryRows = buckets.filter((b) => /^WK_/.test(b.signal));

  const bestByWin = [...buckets]
    .filter((b) => b.n >= 30 && Number.isFinite(b.winPct) && Number.isFinite(b.avgPts))
    .sort((a, b) => b.winPct - a.winPct || b.avgPts - a.avgPts)[0];

  const bestByPts = [...buckets]
    .filter((b) => b.n >= 30 && Number.isFinite(b.avgPts))
    .sort((a, b) => b.avgPts - a.avgPts)[0];

  return {
    parsed: true,
    outcomeLB,
    buckets,
    wickRows,
    trendRows,
    entryRows,
    wickEntryRows,
    bestByWin,
    bestByPts,
    studyName: study?.name,
    row_count: buckets.length,
  };
}

/** Random-entry baseline: same session length, random direction, same TP/SL in pts. */
export function randomEntryBaseline({ tradeCount, tpPts, slPts, winRate = 0.5, seed = 42 }) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const pnls = [];
  for (let i = 0; i < tradeCount; i++) {
    const win = rand() < winRate;
    pnls.push(win ? tpPts : -slPts);
  }
  const net = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    simulated_trades: tradeCount,
    tpPts,
    slPts,
    netPts: net,
    winPct: tradeCount ? (wins.length / tradeCount) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: tradeCount ? net / tradeCount : NaN,
    note: 'Null baseline — random direction at same TP/SL; not session-aware',
  };
}
