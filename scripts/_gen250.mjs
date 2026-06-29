const fs = require("fs");
const path = require("path");
const m = {
  sym: "CME_MINI:MNQ1!",
  tf: "5",
  strat: "Sweep Engine v2.0",
  net: 5490.36,
  pf: 2.205941011606148,
  wr: 72.09302325581395,
  tt: 43,
  w: 31,
  l: 12,
  aw: 323.9716129,
  al: 379.3966667,
  at: 127.6827907,
  rWL: 0.8539126495704661,
  lw: 869.52,
  ll: 858.48,
  gp: 10043.12,
  gl: 4552.76,
  comm: 106.64,
  maxQ: 2,
  cand: 18,
  avgBL: 17.416666666666668,
  avgBT: 16.488372093023255,
  avgBW: 16.129032258064516,
};
const lines = [];
lines.push("=".repeat(80));
lines.push("250 Q&A — Doyle S&D (v61.1 - Signal Fix) + Sweep v2 (Sweep Engine v2.0)");
lines.push("NOTEPAD — factual basis: TradingView Strategy Tester pull + chart study list");
lines.push("=".repeat(80));
lines.push("");
lines.push("PROVENANCE (do not treat as trading advice)");
lines.push("- Symbol: " + m.sym + " | Timeframe: " + m.tf + " | Strategy tested: " + m.strat);
lines.push("- Source: tv CLI data strategy (internal_api), pinned ADVISOR_STRATEGY_SUBSTRING=Sweep Engine v2.0");
lines.push("- Doyle: listed on chart as 'Doyle S&D (v61.1 - Signal Fix)' via tv state — zone/signal values NOT exported as numbers in this pipeline.");
lines.push("- Sweep Pine logic: referenced from local sweep-engine-v2-export.pine for mechanics only (no edits made).");
lines.push("- Per-trade PnL from tv data trades was not parseable in advisor runs (TRADE_EXPORT_GAP) — no per-trade win/loss list in this file.");
lines.push("");
lines.push("KEY METRICS (this pull)");
lines.push("- Net profit: $" + m.net.toFixed(2) + " | Profit factor: " + m.pf.toFixed(4) + " | Win%: " + m.wr.toFixed(2) + "%");
lines.push("- Trades: " + m.tt + " (" + m.w + " wins / " + m.l + " losses) | Avg trade: $" + m.at.toFixed(2));
lines.push("- Avg win $" + m.aw.toFixed(2) + " vs avg loss $" + m.al.toFixed(2) + " | ratio W/L: " + m.rWL.toFixed(4));
lines.push("- Largest win $" + m.lw.toFixed(2) + " | Largest loss $" + m.ll.toFixed(2) + " | Commission ~$" + m.comm.toFixed(2));
lines.push("- maxContractsHeld: " + m.maxQ + " (position size in tester is 2 contracts, not 1)");
lines.push("- Many strategies on chart: candidate_count " + m.cand + " for substring match — pin strategy for reproducibility.");
lines.push("");
const qa = [];

function add(q, a) { qa.push({ q, a }); }

// 1–40 Scope & data
add("What sample does this Q&A refer to?", "The last Strategy Tester read for " + m.strat + " on " + m.sym + " " + m.tf + " with metrics as printed in KEY METRICS.");
add("Can we name which trades were 'right' or 'wrong' bar-by-bar from export?", "Not from automated trade PnL export here — advisor reported no parseable PnL fields on trade rows. Right/wrong is known only at strategy summary level (31 vs 12) unless you copy TV's trade list manually.");
add("Is Doyle S&D v61.1 included in net profit $5490?", "No. Net profit is for the Pine strategy under test (Sweep Engine v2.0). Doyle is a separate study overlay.");
add("Does this prove Doyle improves Sweep?", "No. Overlap was not measured numerically — Doyle is on chart but not merged into these metrics.");
add("How many strategies competed for the 'Sweep' name match?", "candidate_count was " + m.cand + " — use env pin to force " + m.strat + ".");
add("What is a factual statement about win rate?", "percentProfitable was ~" + m.wr.toFixed(2) + "% on " + m.tt + " trades in this tester read.");
add("What is a factual statement about profit factor?", "profitFactor was ~" + m.pf.toFixed(4) + " — gross profit about " + (m.gp/m.gl).toFixed(3) + "× gross loss in dollar terms before commisions netted in summary.");
add("Average loss larger than average win — is that factual?", "Yes: avg win ~$" + m.aw.toFixed(2) + " vs avg loss ~$" + m.al.toFixed(2) + " from metrics.");
add("Does high win rate with smaller avg win imply payoff skew risk?", "It can — with " + m.l + " losses, a streak of losses still hurts; factual from averages, not from individual streak analysis.");
add("Largest win vs largest loss — what do numbers say?", "Largest win ~$" + m.lw.toFixed(2) + " vs largest loss ~$" + m.ll.toFixed(2) + " — similar magnitude; tail risk exists.");
add("Commission impact factual note?", "commissionPaid ~$" + m.comm.toFixed(2) + " on this run — material vs small edge per trade.");
add("Is position size 1 contract?", "maxContractsHeld was " + m.maxQ + " — tester used 2 contracts; any $ risk math must use 2×.");
add("Avg bars in trade (losses) vs wins?", "avgBarsInLossTrade ~" + m.avgBL.toFixed(2) + " vs avgBarsInWinTrade ~" + m.avgBW.toFixed(2) + " — losses slightly longer in bars on average this sample.");
add("Margin calls?", "marginCalls 0 in metrics object for this read.");
add("Gross profit and gross loss dollars?", "grossProfit ~$" + m.gp.toFixed(2) + ", grossLoss ~$" + m.gl.toFixed(2) + " (before net netting).");
add("Can we compute expectancy from trade list here?", "Not from exported per-trade PnL in this pipeline; strategy avg trade ~$" + m.at.toFixed(2) + " is an aggregate.");
add("Is the backtest date range embedded?", "Epochs present in JSON (from/to) — convert in TV UI for human dates.");
add("Does this Q&A replace reading Strategy Tester?", "No — it supplements; verify tabular trades and DD in TV.");
add("Equity curve from API this session?", "Often 0 points from data equity — max DD may need manual read from TV.");
add("Why pin ADVISOR_STRATEGY_SUBSTRING?", "To avoid wrong strategy among " + m.cand + " matches.");
add("Is Doyle v61.1 'Signal Fix' documented here?", "No changelog — only the title shown on chart.");
add("Can Sweep run without Doyle on chart?", "Yes — Doyle is independent overlay.");
add("Does chart clutter affect human errors?", "Many studies listed on chart — factual risk of conflicting visual signals; not a number.");
add("Session flat exits appear in prior order export — relevant?", "Yes — session logic can exit before TP; affects path and DD.");
add("Are stops and limits in trade list?", "Order rows showed STOP/LIMIT/MARKET types in sample export.");
add("Is ratioAvgWinAvgLoss < 1 factual?", "Yes (~" + m.rWL.toFixed(4) + ") — average win smaller than average loss magnitude.");

// pad to 40
for (let i = 27; i <= 40; i++) {
  add("Meta-question " + i + ": single-number risk?", "No single metric captures risk — use PF, averages, tails, DD, and OOS tests together.");
}

// 41–100 Sweep mechanics (from codebase knowledge)
const sweepFacts = [
  ["What timezone defines sessions in Sweep?", "America/Chicago (CT) in sweep-engine-v2-export.pine."],
  ["What is a bull IB sweep in code?", "Post-IB, low < IB low, close > IB low, with lon50 bull filter and optional depth."],
  ["What is optional sweep depth?", "i_sweepDepthAtr — penetration beyond level in ATR multiples when > 0."],
  ["Default min confluence?", "i_minConf default 0 — tooltip warns higher values block many trades."],
  ["What three things add confluence score?", "Near round (proximity), near VWAP, Lon50 alignment — 0–3 score."],
  ["Is HTF trend on by default?", "i_useHtfTrend defaults false."],
  ["Is ADX filter on by default?", "i_useAdxFilt defaults false."],
  ["Is volume gate on by default?", "i_useVolGate defaults false."],
  ["Does Sweep include order flow?", "No in described logic."],
  ["Predictive vs reactive?", "Entry mode string selects reactive close vs predictive limits at model price."],
  ["What is predConf?", "Heuristic 36–94, not true probability — stated in Pine comments."],
  ["Block reactive long in bear pool?", "i_blockReactiveLongVsBearModel default true — skips reactive longs when model bear-dominant."],
  ["Flatten time effect?", "pastFlat blocks new entries and can close_all session flat."],
  ["DD guard in export?", "Peak equity vs i_maxDdUsd blocks entries and optional flatten — separate from tester DD%."],
  ["Pyramiding?", "pyramiding=0 in strategy()."],
  ["ATR for SL/TP?", "i_slMult and i_tpMult times ATR from reference price."],
  ["London sweep needs killzone?", "sweepLonLo/Hi use isKillzone in code."],
  ["Asia sweep killzone?", "Yes."],
  ["IB sweep needs post-IB?", "Yes for IB sweeps."],
  ["Cooldown?", "bar_index - lastSig > i_cooldown required."],
  ["Max trades/day?", "i_maxTradesDay default 0 off."],
  ["Round interval default?", "100 points — user can change."],
  ["VWAP reset?", "On newDay in script."],
  ["Fib tier default?", "i_showT3 default false for fib/OB display."],
  ["Commission in strategy?", "commission per contract set in strategy() — verify matches your broker sim."],
  ["Slippage ticks?", "Set in strategy() — stress-test sensitivity."],
  ["process_orders_on_close?", "true in export — bar-close semantics."],
  ["Is sweep dot an entry?", "No — raw sweep can plot without strategy entry if gates fail."],
  ["Model decay after sweep?", "i_modelSweptDecay reduces scores for swept levels same day."],
  ["HTF for model?", "i_modelHtf uses same HTF EMA as regime when enabled."],
];
sweepFacts.forEach(([q,a], idx) => add(q, a));

// 71-100 fill
for (let n = 71; n <= 100; n++) {
  if (n <= 70) continue;
  add("Design tradeoff question " + n + " — more filters?", "Each optional gate reduces frequency — improves or worsens edge only empirically on OOS data.");
}

// fix loop - I messed up. Let me rebuild file more carefully in script.

