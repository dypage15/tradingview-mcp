#!/usr/bin/env node
/**
 * Bar-replay lab for MNQ Auto Levels + Advisor.
 * Samples level touches, holds vs breaks, and paper-trades the advisor plan.
 *
 * Env:
 *   REPLAY_DATE, REPLAY_STEPS, REPLAY_TF, REPLAY_SYMBOL
 *   ZONE_TOL (pts), STOP_PTS, TARGET_PTS, COOLDOWN_BARS
 *   TRADE_MODE = hold | break | both (default hold)
 *   MIN_TOUCHES (ignore levels with ×N below this; default 3)
 *   REQUIRE_BUDGET (1 = skip when session budget ≤ 0)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disconnect } from '../src/connection.js';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as replay from '../src/core/replay.js';

const SYMBOL = process.env.REPLAY_SYMBOL || 'CME_MINI:MNQ1!';
const TF = process.env.REPLAY_TF || '5';
const START_DATE = process.env.REPLAY_DATE || '2026-07-22';
const MAX_STEPS = Number(process.env.REPLAY_STEPS || 280);
const ZONE_TOL = Number(process.env.ZONE_TOL || 12);
const STOP_PTS = Number(process.env.STOP_PTS || 28);
const TARGET_PTS = Number(process.env.TARGET_PTS || 45);
const COOLDOWN_BARS = Number(process.env.COOLDOWN_BARS || 8);
const TRADE_MODE = (process.env.TRADE_MODE || 'hold').toLowerCase();
const MIN_TOUCHES = Number(process.env.MIN_TOUCHES || 3);
const REQUIRE_BUDGET = process.env.REQUIRE_BUDGET === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseAdvisor(tablesPayload) {
  const study = tablesPayload?.studies?.[0];
  const out = {
    price: null,
    bias: '—',
    trend: '—',
    vwapSide: '—',
    vwap: null,
    regime: '—',
    adx: null,
    res: null,
    resTouches: null,
    resDist: null,
    pivot: null,
    pivotTouches: null,
    sup: null,
    supTouches: null,
    supDist: null,
    near: null,
    nearSide: null,
    nearDist: null,
    planRaw: '',
    holdTarget: null,
    breakTarget: null,
    rangeUsedPct: null,
    budgetLeft: null,
    rvol: null,
    atrx: null,
    swing: null,
    rows: [],
  };
  if (!study) return out;

  for (const t of study.tables || []) {
    for (const row of t.rows || []) {
      out.rows.push(row);
      if (row.startsWith('◆ MNQ')) {
        const m = row.match(/\|\s*([\d.]+)/);
        if (m) out.price = parseFloat(m[1]);
      } else if (row.startsWith('Bias |')) {
        out.bias = row.split('|')[1]?.trim() || out.bias;
      } else if (row.startsWith('Trend |')) {
        out.trend = row.split('|')[1]?.trim() || out.trend;
      } else if (row.startsWith('VWAP |')) {
        const side = row.includes('below') ? 'below' : row.includes('above') ? 'above' : '—';
        out.vwapSide = side;
        const m = row.match(/([\d.]+)/);
        if (m) out.vwap = parseFloat(m[1]);
      } else if (row.startsWith('Regime |')) {
        out.regime = row.split('|')[1]?.trim() || out.regime;
        const m = row.match(/(\d+)/);
        if (m) out.adx = parseFloat(m[1]);
      } else if (row.startsWith('Res ▲ |') || row.startsWith('Res |')) {
        const m = row.match(/([\d.]+)\s+×(\d+)\s+\(([\d.]+)\)/);
        if (m) {
          out.res = parseFloat(m[1]);
          out.resTouches = parseInt(m[2], 10);
          out.resDist = parseFloat(m[3]);
        }
      } else if (row.startsWith('Pivot')) {
        const m = row.match(/([\d.]+)\s+×(\d+)/);
        if (m) {
          out.pivot = parseFloat(m[1]);
          out.pivotTouches = parseInt(m[2], 10);
        }
      } else if (row.startsWith('Sup ▼ |') || row.startsWith('Sup |')) {
        if (!row.includes('—')) {
          const m = row.match(/([\d.]+)\s+×(\d+)\s+\(([\d.]+)\)/);
          if (m) {
            out.sup = parseFloat(m[1]);
            out.supTouches = parseInt(m[2], 10);
            out.supDist = parseFloat(m[3]);
          }
        }
      } else if (row.startsWith('Near |')) {
        const m = row.match(/([↑↓])\s*([SR])\s+([\d.]+)\s+([\d.]+)p/);
        if (m) {
          out.nearSide = m[2];
          out.near = parseFloat(m[3]);
          out.nearDist = parseFloat(m[4]);
        } else if (/none/i.test(row)) {
          out.near = null;
        }
      } else if (row.startsWith('▶ |') || row.includes('holds →') || row.includes('breaks →')) {
        out.planRaw += (out.planRaw ? '\n' : '') + row;
        const hold = row.match(/holds\s*→\s*([\d.]+)/i);
        const brk = row.match(/breaks\s*→\s*([\d.]+)/i);
        if (hold) out.holdTarget = parseFloat(hold[1]);
        if (brk) out.breakTarget = parseFloat(brk[1]);
      } else if (row.startsWith('Range |')) {
        const m = row.match(/\((\d+)%\)/);
        if (m) out.rangeUsedPct = parseInt(m[1], 10);
      } else if (row.startsWith('Budget |')) {
        const m = row.match(/(-?\d+)p/);
        if (m) out.budgetLeft = parseInt(m[1], 10);
      } else if (row.startsWith('RVOL') || row.includes('RV ')) {
        const rv = row.match(/RV\s*([\d.]+)x/i);
        const atr = row.match(/ATR\s*([\d.]+)x/i);
        const sw = row.match(/sw\s*(\d+)/i);
        if (rv) out.rvol = parseFloat(rv[1]);
        if (atr) out.atrx = parseFloat(atr[1]);
        if (sw) out.swing = parseInt(sw[1], 10);
      }
    }
  }
  return out;
}

function parseLevelLabels(labelsPayload) {
  const levels = [];
  const study = labelsPayload?.studies?.[0];
  if (!study) return levels;
  for (const lab of study.labels || []) {
    const text = lab.text || '';
    const price = lab.price;
    if (price == null) continue;
    let kind = 'level';
    let touches = null;
    if (/PIVOT/i.test(text)) kind = 'pivot';
    else if (/Sess Hi/i.test(text)) kind = 'sess_hi';
    else if (/Sess Lo/i.test(text)) kind = 'sess_lo';
    else if (/^S\b/i.test(text)) kind = 'support';
    else if (/^R\b/i.test(text)) kind = 'resistance';
    const tm = text.match(/×(\d+)/);
    if (tm) touches = parseInt(tm[1], 10);
    levels.push({ kind, price, touches, text });
  }
  return levels;
}

function nearestLevel(px, levels) {
  let best = null;
  let bestDist = Infinity;
  for (const lv of levels) {
    if (lv.touches != null && lv.touches < MIN_TOUCHES && lv.kind !== 'sess_hi' && lv.kind !== 'sess_lo') {
      continue;
    }
    const d = Math.abs(px - lv.price);
    if (d < bestDist) {
      bestDist = d;
      best = lv;
    }
  }
  return bestDist <= ZONE_TOL ? { level: best, dist: bestDist } : null;
}

function parseWatchResistance(planRaw) {
  const m = planRaw?.match(/watch\s+([\d.]+)\s+as\s+resistance/i);
  return m ? parseFloat(m[1]) : null;
}

function decideTrade(px, adv, hit) {
  const level = hit.level;
  const isSup = level.kind === 'support' || level.kind === 'sess_lo'
    || (adv.nearSide === 'S' && Math.abs((adv.near ?? 0) - level.price) < 1);
  const isRes = level.kind === 'resistance' || level.kind === 'pivot' || level.kind === 'sess_hi'
    || (adv.nearSide === 'R' && Math.abs((adv.near ?? 0) - level.price) < 1);

  const biasBear = /BEAR/i.test(adv.bias);
  const biasBull = /BULL/i.test(adv.bias);
  const trendDn = /DOWN/i.test(adv.trend);
  const trendUp = /UP/i.test(adv.trend);
  const isTrend = /TREND/i.test(adv.regime);
  const belowAll = /Below all levels/i.test(adv.planRaw || '');

  // Continuation short when advisor says below all levels + bearish/down
  if (belowAll && (biasBear || trendDn) && (isSup || level.kind === 'sess_lo')) {
    if (TRADE_MODE === 'break' || TRADE_MODE === 'both' || TRADE_MODE === 'hold') {
      return {
        side: 'short',
        play: belowAll && isTrend ? 'below_all_cont_short' : 'sess_lo_fade_or_break',
        target: px - TARGET_PTS,
        stop: px + STOP_PTS,
      };
    }
  }

  if (TRADE_MODE === 'hold' || TRADE_MODE === 'both') {
    // Session low bounce only in RANGE and not hard bearish
    if (level.kind === 'sess_lo' && !isTrend && !biasBear) {
      return {
        side: 'long',
        play: 'sess_lo_bounce',
        target: px + TARGET_PTS,
        stop: px - STOP_PTS,
      };
    }
    if (level.kind === 'sess_hi' && !isTrend && !biasBull) {
      return {
        side: 'short',
        play: 'sess_hi_reject',
        target: px - TARGET_PTS,
        stop: px + STOP_PTS,
      };
    }
    if (isSup && level.kind === 'support' && !biasBear) {
      return {
        side: 'long',
        play: 'hold_bounce',
        target: adv.holdTarget ?? (px + TARGET_PTS),
        stop: adv.breakTarget ?? (px - STOP_PTS),
      };
    }
    if (isRes && (level.kind === 'resistance' || level.kind === 'pivot') && !biasBull) {
      return {
        side: 'short',
        play: 'hold_reject',
        target: adv.breakTarget ?? (px - TARGET_PTS),
        stop: (adv.holdTarget && adv.holdTarget > px) ? adv.holdTarget : (px + STOP_PTS),
      };
    }
  }

  if (TRADE_MODE === 'break' || TRADE_MODE === 'both') {
    if (isSup && px < level.price - 2 && (biasBear || trendDn)) {
      return {
        side: 'short',
        play: 'break_down',
        target: adv.breakTarget ?? (px - TARGET_PTS),
        stop: level.price + STOP_PTS * 0.35,
      };
    }
    if (isRes && px > level.price + 2 && (biasBull || trendUp)) {
      return {
        side: 'long',
        play: 'break_up',
        target: adv.holdTarget ?? (px + TARGET_PTS),
        stop: level.price - STOP_PTS * 0.35,
      };
    }
  }

  if (TRADE_MODE === 'hold' && isSup) {
    return { side: 'long', play: 'hold_bounce_soft', target: px + TARGET_PTS, stop: px - STOP_PTS };
  }
  if (TRADE_MODE === 'hold' && isRes) {
    return { side: 'short', play: 'hold_reject_soft', target: px - TARGET_PTS, stop: px + STOP_PTS };
  }
  return null;
}

function biasAlign(side, bias) {
  if (/MIXED|—|NEUTRAL/i.test(bias)) return 'neutral';
  if (side === 'short' && /BEAR/i.test(bias)) return 'aligned';
  if (side === 'long' && /BULL/i.test(bias)) return 'aligned';
  if (side === 'short' && /BULL/i.test(bias)) return 'counter';
  if (side === 'long' && /BEAR/i.test(bias)) return 'counter';
  return 'neutral';
}

function edgeStats(trades) {
  const by = (keyFn) => {
    const m = {};
    for (const t of trades) {
      const k = keyFn(t);
      if (!m[k]) m[k] = { n: 0, wins: 0, net: 0, grossWin: 0, grossLoss: 0 };
      m[k].n += 1;
      m[k].net += t.pnlPts;
      if (t.pnlPts > 0) { m[k].wins += 1; m[k].grossWin += t.pnlPts; }
      else m[k].grossLoss += Math.abs(t.pnlPts);
    }
    for (const k of Object.keys(m)) {
      const b = m[k];
      b.winRate = b.n ? `${((100 * b.wins) / b.n).toFixed(1)}%` : '—';
      b.avg = b.n ? (b.net / b.n).toFixed(2) : '—';
      b.pf = b.grossLoss > 0 ? (b.grossWin / b.grossLoss).toFixed(2) : (b.grossWin > 0 ? '∞' : '—');
    }
    return m;
  };
  const wins = trades.filter((t) => t.pnlPts > 0);
  const losses = trades.filter((t) => t.pnlPts <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlPts, 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnlPts), 0);
  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? `${((100 * wins.length) / trades.length).toFixed(1)}%` : '—',
    netPts: Math.round(trades.reduce((s, t) => s + t.pnlPts, 0) * 4) / 4,
    avgWin: wins.length ? (grossWin / wins.length).toFixed(2) : '—',
    avgLoss: losses.length ? (grossLoss / losses.length).toFixed(2) : '—',
    profitFactor: grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? '∞' : '—'),
    byPlay: by((t) => t.play),
    bySide: by((t) => t.side),
    byBiasAlign: by((t) => t.biasAlign),
    byLevelKind: by((t) => t.levelKind),
    byBudget: by((t) => (t.budgetLeft == null ? 'na' : t.budgetLeft <= 0 ? 'budget0' : t.budgetLeft < 100 ? 'budget_low' : 'budget_ok')),
    byExit: by((t) => t.reason),
    byOutcomeClass: by((t) => t.levelOutcome || 'na'),
  };
}

await chart.setSymbol({ symbol: SYMBOL });
await chart.setTimeframe({ timeframe: TF });
await sleep(800);

await replay.start({ date: START_DATE });
await sleep(1500);

const trades = [];
const touches = [];
const snapshots = [];
let openTrade = null;
let cooldownUntil = -1;
let lastDate = null;
let dayCount = 0;
let lastTouchKey = '';

for (let step = 0; step < MAX_STEPS; step++) {
  await replay.step();
  await sleep(260);

  const q = await data.getQuote().catch(() => null);
  const px = q?.last ?? q?.close;
  if (!px) continue;

  const st = await replay.status();
  const barDate = st.current_date ? new Date(st.current_date * 1000).toISOString().slice(0, 10) : null;
  if (barDate && barDate !== lastDate) {
    dayCount += 1;
    lastDate = barDate;
  }

  const tables = await data.getPineTables({ study_filter: 'MNQ Auto Levels' }).catch(() => ({}));
  const labels = await data.getPineLabels({ study_filter: 'MNQ Auto Levels', max_labels: 40 }).catch(() => ({}));
  const adv = parseAdvisor(tables);
  const levels = parseLevelLabels(labels);

  // Merge advisor S/R into level list if labels thin
  if (adv.sup != null) levels.push({ kind: 'support', price: adv.sup, touches: adv.supTouches, text: `S ×${adv.supTouches ?? '?'}` });
  if (adv.res != null) levels.push({ kind: 'resistance', price: adv.res, touches: adv.resTouches, text: `R ×${adv.resTouches ?? '?'}` });
  if (adv.pivot != null) levels.push({ kind: 'pivot', price: adv.pivot, touches: adv.pivotTouches, text: `PIVOT ×${adv.pivotTouches ?? '?'}` });
  const watchR = parseWatchResistance(adv.planRaw);
  if (watchR != null) levels.push({ kind: 'resistance', price: watchR, touches: 99, text: `watchR ${watchR}` });

  // Forward-fill outcomes for pending touches (bars after contact)
  for (const t of touches) {
    if (t.fwdDone) continue;
    const age = step - t.step;
    if (age <= 0) continue;
    const move = px - t.px;
    t.mfe = Math.max(t.mfe ?? 0, move);
    t.mae = Math.min(t.mae ?? 0, move);
    if (age === 3) t.move3 = Math.round(move * 4) / 4;
    if (age === 5) t.move5 = Math.round(move * 4) / 4;
    if (age === 10) {
      t.move10 = Math.round(move * 4) / 4;
      // hold vs break relative to level
      if (t.levelKind === 'sess_lo' || t.levelKind === 'support') {
        t.outcome = px < t.level - 8 ? 'broke' : (t.mfe > 12 ? 'held_bounce' : 'chop');
      } else if (t.levelKind === 'sess_hi' || t.levelKind === 'resistance' || t.levelKind === 'pivot') {
        t.outcome = px > t.level + 8 ? 'broke' : (t.mae < -12 ? 'held_reject' : 'chop');
      } else {
        t.outcome = 'na';
      }
      t.fwdDone = true;
    }
  }

  if (step % 20 === 0) {
    snapshots.push({
      step,
      barDate,
      px,
      bias: adv.bias,
      trend: adv.trend,
      regime: adv.regime,
      near: adv.near,
      nearDist: adv.nearDist,
      budgetLeft: adv.budgetLeft,
      rangeUsedPct: adv.rangeUsedPct,
      rvol: adv.rvol,
      plan: adv.planRaw.slice(0, 160),
    });
  }

  if (openTrade) {
    const pnlPts = openTrade.side === 'long' ? px - openTrade.entry : openTrade.entry - px;
    openTrade.mfe = Math.max(openTrade.mfe ?? 0, pnlPts);
    openTrade.mae = Math.min(openTrade.mae ?? 0, pnlPts);

    const stopDist = openTrade.side === 'long'
      ? openTrade.entry - openTrade.stop
      : openTrade.stop - openTrade.entry;
    const tgtDist = openTrade.side === 'long'
      ? openTrade.target - openTrade.entry
      : openTrade.entry - openTrade.target;
    const hitStop = pnlPts <= -Math.abs(stopDist || STOP_PTS);
    const hitTarget = pnlPts >= Math.abs(tgtDist || TARGET_PTS);

    // Classify level outcome while in trade
    if (openTrade.levelPrice != null) {
      if (openTrade.side === 'long' && px < openTrade.levelPrice - 4) openTrade.levelOutcome = 'broke';
      else if (openTrade.side === 'short' && px > openTrade.levelPrice + 4) openTrade.levelOutcome = 'broke';
      else if (pnlPts > 8) openTrade.levelOutcome = openTrade.levelOutcome || 'held';
    }

    if (hitStop || hitTarget) {
      await replay.trade({ action: 'close' }).catch(() => {});
      trades.push({
        ...openTrade,
        exit: px,
        exitStep: step,
        exitDate: barDate,
        pnlPts: Math.round(pnlPts * 4) / 4,
        reason: hitTarget ? 'target' : 'stop',
        barsHeld: step - openTrade.step,
        levelOutcome: openTrade.levelOutcome || (hitTarget ? 'held' : 'failed'),
      });
      openTrade = null;
      cooldownUntil = step + COOLDOWN_BARS;
    }
    continue;
  }

  if (step < cooldownUntil) continue;
  if (REQUIRE_BUDGET && adv.budgetLeft != null && adv.budgetLeft <= 0) continue;

  const hit = nearestLevel(px, levels);
  if (!hit) continue;

  const touchKey = `${hit.level.kind}:${hit.level.price.toFixed(2)}`;
  if (touchKey !== lastTouchKey) {
    touches.push({
      step,
      barDate,
      px,
      dist: Math.round(hit.dist * 4) / 4,
      level: hit.level.price,
      levelKind: hit.level.kind,
      touches: hit.level.touches,
      bias: adv.bias,
      trend: adv.trend,
      regime: adv.regime,
      vwapSide: adv.vwapSide,
      budgetLeft: adv.budgetLeft,
      rangeUsedPct: adv.rangeUsedPct,
      rvol: adv.rvol,
      atrx: adv.atrx,
      near: adv.near,
      plan: adv.planRaw.slice(0, 180),
      holdTarget: adv.holdTarget,
      breakTarget: adv.breakTarget,
    });
    lastTouchKey = touchKey;
  }

  const decision = decideTrade(px, adv, hit);
  if (!decision) continue;

  const action = decision.side === 'long' ? 'buy' : 'sell';
  await replay.trade({ action }).catch(() => {});
  openTrade = {
    side: decision.side,
    play: decision.play,
    entry: px,
    stop: decision.stop,
    target: decision.target,
    levelPrice: hit.level.price,
    levelKind: hit.level.kind,
    levelTouches: hit.level.touches,
    zoneDist: hit.dist,
    bias: adv.bias,
    trend: adv.trend,
    regime: adv.regime,
    vwapSide: adv.vwapSide,
    biasAlign: biasAlign(decision.side, adv.bias),
    budgetLeft: adv.budgetLeft,
    rangeUsedPct: adv.rangeUsedPct,
    rvol: adv.rvol,
    atrx: adv.atrx,
    step,
    entryDate: barDate,
    mfe: 0,
    mae: 0,
    levelOutcome: null,
  };
}

if (openTrade) {
  const q = await data.getQuote().catch(() => null);
  const px = q?.last ?? q?.close ?? openTrade.entry;
  await replay.trade({ action: 'close' }).catch(() => {});
  const pnlPts = openTrade.side === 'long' ? px - openTrade.entry : openTrade.entry - px;
  trades.push({
    ...openTrade,
    exit: px,
    exitStep: MAX_STEPS,
    pnlPts: Math.round(pnlPts * 4) / 4,
    reason: 'session_end',
    barsHeld: MAX_STEPS - openTrade.step,
    levelOutcome: openTrade.levelOutcome || 'open_end',
  });
}

const final = await replay.status();
const stats = edgeStats(trades);

// Touch → next 5/10 bar move sample (from logged touches vs later snapshots is hard);
// derive simple hold/break rates from trades + touch contexts.
const held = trades.filter((t) => t.levelOutcome === 'held').length;
const broke = trades.filter((t) => t.levelOutcome === 'broke' || t.levelOutcome === 'failed').length;

const touchOutcomes = {};
for (const t of touches) {
  const k = `${t.levelKind}:${t.outcome || 'pending'}`;
  touchOutcomes[k] = (touchOutcomes[k] || 0) + 1;
}
const avgMove = (arr, key) => {
  const vals = arr.map((t) => t[key]).filter((v) => typeof v === 'number');
  if (!vals.length) return null;
  return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 4) / 4;
};

const report = {
  run_at: new Date().toISOString(),
  symbol: SYMBOL,
  timeframe: TF,
  replay_start: START_DATE,
  steps: MAX_STEPS,
  trading_days_seen: dayCount,
  params: { ZONE_TOL, STOP_PTS, TARGET_PTS, COOLDOWN_BARS, TRADE_MODE, MIN_TOUCHES, REQUIRE_BUDGET },
  touches_logged: touches.length,
  touches,
  trades,
  snapshots,
  touch_outcomes: touchOutcomes,
  touch_forward: {
    avg_move3: avgMove(touches, 'move3'),
    avg_move5: avgMove(touches, 'move5'),
    avg_move10: avgMove(touches, 'move10'),
    sess_lo_broke: touches.filter((t) => t.levelKind === 'sess_lo' && t.outcome === 'broke').length,
    sess_lo_held: touches.filter((t) => t.levelKind === 'sess_lo' && t.outcome === 'held_bounce').length,
    sess_hi_broke: touches.filter((t) => t.levelKind === 'sess_hi' && t.outcome === 'broke').length,
    sess_hi_held: touches.filter((t) => t.levelKind === 'sess_hi' && t.outcome === 'held_reject').length,
  },
  level_outcome_counts: { held, broke, other: trades.length - held - broke },
  edge: stats,
  final_date: final.current_date,
  enhancements: {
    note: 'Derived from this replay pass — feed into advisor plan scoring',
    prefer_budget_ok: stats.byBudget?.budget_ok?.pf || null,
    prefer_aligned: stats.byBiasAlign?.aligned?.pf || null,
    prefer_counter: stats.byBiasAlign?.counter?.pf || null,
    best_play: Object.entries(stats.byPlay || {}).sort((a, b) => parseFloat(b[1].pf) - parseFloat(a[1].pf))[0] || null,
  },
};

const outDir = join(process.cwd(), 'data');
mkdirSync(outDir, { recursive: true });
const stamp = START_DATE.replace(/-/g, '');
const outFile = join(outDir, `replay-mnq-auto-levels-${stamp}-${MAX_STEPS}steps.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  outFile,
  touches: touches.length,
  trades: trades.length,
  edge: stats,
  enhancements: report.enhancements,
  level_outcome_counts: report.level_outcome_counts,
}, null, 2));

await replay.stop().catch(() => {});
await disconnect();
