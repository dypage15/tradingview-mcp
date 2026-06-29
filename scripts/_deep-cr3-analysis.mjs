#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const runDir = process.argv[2] || join(process.cwd(), 'data/grid_runs/cr3_trade_review_2026-05-30T00-00-54');
const trades = JSON.parse(readFileSync(join(runDir, 'trades_with_labels.json'), 'utf8')).trades;

function agg(trades, keyFn, label) {
  const g = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (!g[k]) g[k] = { n: 0, w: 0, pnl: 0, pts: 0, mfe: 0, mae: 0, tp: 0, sl: 0, adx: 0 };
    const x = g[k];
    x.n++;
    x.pnl += t.pnl || 0;
    x.pts += t.pts || 0;
    x.mfe += t.mfe_pts || 0;
    x.mae += t.mae_pts || 0;
    if (t.win) x.w++;
    if (t.exit_class === 'TP_40') x.tp++;
    if (t.exit_class === 'SL_20') x.sl++;
    if (t.adx_opt) x.adx++;
  }
  return Object.entries(g)
    .map(([k, v]) => ({
      [label]: k,
      n: v.n,
      wr: +(100 * v.w / v.n).toFixed(1),
      pnl: +v.pnl.toFixed(2),
      avg_pnl: +(v.pnl / v.n).toFixed(2),
      avg_pts: +(v.pts / v.n).toFixed(2),
      tp_rate: +(100 * v.tp / v.n).toFixed(1),
      sl_rate: +(100 * v.sl / v.n).toFixed(1),
      adx_opt_pct: +(100 * v.adx / v.n).toFixed(1),
      pf: v.pnl > 0 ? null : null,
    }))
    .sort((a, b) => b.pnl - a.pnl);
}

function pf(trades) {
  const wins = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  return loss ? +(wins / loss).toFixed(2) : null;
}

function pfGroup(trades) {
  const g = agg(trades, () => 'all', 'x');
  return pf(trades);
}

// Cloud alignment: long wants BULL, short wants BEAR
function cloudAlign(t) {
  if (t.side === 'Long') return t.cloud === 'BULL' ? 'with_cloud' : t.cloud === 'BEAR' ? 'counter_cloud' : 'neutral';
  return t.cloud === 'BEAR' ? 'with_cloud' : t.cloud === 'BULL' ? 'counter_cloud' : 'neutral';
}

function vwapAlign(t) {
  if (t.side === 'Long') return t.vwap === 'above' ? 'favorable' : 'below';
  return t.vwap === 'below' ? 'favorable' : 'above';
}

function hourEt(iso) {
  return iso ? iso.slice(11, 13) : '?';
}

function confBucket(c) {
  if (c == null) return '?';
  if (c === 1) return '1';
  if (c === 2) return '2';
  return '3+';
}

const analysis = {
  overview: {
    n: trades.length,
    net_pnl: +trades.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    wr: +(100 * trades.filter((t) => t.win).length / trades.length).toFixed(1),
    pf: pf(trades),
    avg_win: +(trades.filter((t) => t.win).reduce((s, t) => s + t.pnl, 0) / trades.filter((t) => t.win).length).toFixed(2),
    avg_loss: +(trades.filter((t) => !t.win).reduce((s, t) => s + t.pnl, 0) / trades.filter((t) => !t.win).length).toFixed(2),
  },
  by_research_bucket: agg(trades, (t) => t.research_bucket || '?', 'bucket'),
  by_conf: agg(trades, (t) => confBucket(t.conf), 'conf'),
  by_side: agg(trades, (t) => t.side, 'side'),
  by_exit_class: agg(trades, (t) => t.exit_class, 'exit'),
  by_exit_sig: agg(trades, (t) => t.exit_sig, 'exit_sig'),
  by_cloud_align: agg(trades, cloudAlign, 'align'),
  by_vwap_align: agg(trades, vwapAlign, 'vwap'),
  by_hour: agg(trades, (t) => hourEt(t.entry_time), 'hour'),
  by_adx_opt: agg(trades, (t) => (t.adx_opt ? 'adx_18_35' : 'adx_outside'), 'adx_band'),
  by_rsi_os_long: agg(
    trades.filter((t) => t.side === 'Long'),
    (t) => (t.rsi_os ? 'rsi_os' : t.rsi != null && t.rsi <= 40 ? 'rsi_low' : t.rsi != null && t.rsi >= 60 ? 'rsi_high' : 'rsi_mid'),
    'rsi_zone',
  ),
  by_rsi_ob_short: agg(
    trades.filter((t) => t.side === 'Short'),
    (t) => (t.rsi_ob ? 'rsi_ob' : t.rsi != null && t.rsi >= 60 ? 'rsi_high' : t.rsi != null && t.rsi <= 40 ? 'rsi_low' : 'rsi_mid'),
    'rsi_zone',
  ),
  long_conf_matrix: agg(
    trades.filter((t) => t.side === 'Long'),
    (t) => `conf${t.conf}_cloud_${cloudAlign(t)}`,
    'cell',
  ),
  short_conf_matrix: agg(
    trades.filter((t) => t.side === 'Short'),
    (t) => `conf${t.conf}_cloud_${cloudAlign(t)}`,
    'cell',
  ),
  worst_days: agg(trades, (t) => t.entry_date, 'day').slice(-5).reverse(),
  best_days: agg(trades, (t) => t.entry_date, 'day').slice(0, 5),
};

// Counter-trend wick flag (CT in research): cloud opposite to wick direction
const ct = trades.filter((t) => cloudAlign(t) === 'counter_cloud');
const wt = trades.filter((t) => cloudAlign(t) === 'with_cloud');
analysis.counter_trend = { n: ct.length, pnl: +ct.reduce((s, t) => s + t.pnl, 0).toFixed(2), wr: +(100 * ct.filter((t) => t.win).length / ct.length).toFixed(1), pf: pf(ct) };
analysis.with_trend = { n: wt.length, pnl: +wt.reduce((s, t) => s + t.pnl, 0).toFixed(2), wr: +(100 * wt.filter((t) => t.win).length / wt.length).toFixed(1), pf: pf(wt) };

// D-RSI sign alignment
function drsiAlign(t) {
  if (t.drsi == null) return '?';
  if (t.side === 'Long') return t.drsi > 0 ? 'drsi_pos' : 'drsi_neg';
  return t.drsi < 0 ? 'drsi_neg' : 'drsi_pos';
}
analysis.by_drsi = agg(trades, drsiAlign, 'drsi');

// MACD hist sign
function macdAlign(t) {
  if (t.macd == null) return '?';
  if (t.side === 'Long') return t.macd > 0 ? 'macd_pos' : 'macd_neg';
  return t.macd < 0 ? 'macd_neg' : 'macd_pos';
}
analysis.by_macd = agg(trades, macdAlign, 'macd');

// Simulated filter: wickMinConf=2 only
const conf2plus = trades.filter((t) => (t.conf || 0) >= 2);
analysis.sim_conf2 = {
  n: conf2plus.length,
  pnl: +conf2plus.reduce((s, t) => s + t.pnl, 0).toFixed(2),
  wr: +(100 * conf2plus.filter((t) => t.win).length / conf2plus.length).toFixed(1),
  pf: pf(conf2plus),
};

// Simulated: longs W_L_2 only
const wl2 = trades.filter((t) => t.research_bucket === 'W_L_2');
analysis.sim_wl2_only = { n: wl2.length, pnl: +wl2.reduce((s, t) => s + t.pnl, 0).toFixed(2), wr: +(100 * wl2.filter((t) => t.win).length / wl2.length).toFixed(1), pf: pf(wl2) };

// Simulated: drop conf1 longs
const noConf1Long = trades.filter((t) => !(t.side === 'Long' && t.conf === 1));
analysis.sim_no_conf1_long = { n: noConf1Long.length, pnl: +noConf1Long.reduce((s, t) => s + t.pnl, 0).toFixed(2), pf: pf(noConf1Long) };

// Simulated: no 13:00 hour
const no13 = trades.filter((t) => hourEt(t.entry_time) !== '13');
analysis.sim_no_hour13 = { n: no13.length, pnl: +no13.reduce((s, t) => s + t.pnl, 0).toFixed(2), pf: pf(no13) };

// Simulated: conf>=2 + no hour 13
const combo = trades.filter((t) => (t.conf || 0) >= 2 && hourEt(t.entry_time) !== '13');
analysis.sim_conf2_no13 = { n: combo.length, pnl: +combo.reduce((s, t) => s + t.pnl, 0).toFixed(2), pf: pf(combo) };

// ADX block deep dive
const adxBlock = trades.filter((t) => t.exit_sig === 'ADX_Block');
analysis.adx_block_trades = {
  n: adxBlock.length,
  pnl: +adxBlock.reduce((s, t) => s + t.pnl, 0).toFixed(2),
  wr: +(100 * adxBlock.filter((t) => t.win).length / adxBlock.length).toFixed(1),
  avg_mfe: +(adxBlock.reduce((s, t) => s + (t.mfe_pts || 0), 0) / adxBlock.length).toFixed(1),
  avg_mae: +(adxBlock.reduce((s, t) => s + (t.mae_pts || 0), 0) / adxBlock.length).toFixed(1),
  by_bucket: agg(adxBlock, (t) => t.research_bucket, 'bucket'),
};

// Winners that hit SL vs TP path
analysis.exit_leak = {
  sl_total_pnl: +trades.filter((t) => t.exit_class === 'SL_20').reduce((s, t) => s + t.pnl, 0).toFixed(2),
  tp_total_pnl: +trades.filter((t) => t.exit_class === 'TP_40').reduce((s, t) => s + t.pnl, 0).toFixed(2),
};

writeFileSync(join(runDir, 'deep_analysis.json'), JSON.stringify(analysis, null, 2));
console.log(JSON.stringify(analysis, null, 2));
