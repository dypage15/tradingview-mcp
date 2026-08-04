# GLP Course Guide — Reading Gamma for Intraday Futures

**Product:** Gamma Liquidity Platform (GLP)  
**Audience:** Traders who already use futures charts (NQ/ES/YM/GC) and want a measured way to use ETF options gamma as *terrain*, not a crystal ball.  
**Model:** Bring Your Own Key (Unusual Whales). The course teaches the software and the evidence — it does not redistribute vendor data.  
**Status:** Research & education. Not investment advice. Not a CTA signal service.

---

## What this course claims (and what it does not)

| We teach | We do not teach |
|---|---|
| How dealer gamma *mechanics* damp or amplify moves | That positive gamma = bullish |
| How to read Flip, Pin, walls, air pocket, term structure | That the flip is a bounce level |
| How wide Asia / London / RTH usually run by regime | Mechanical “fade the wall” entries as a holy grail |
| How often to refresh the book vs the ratio | That same-day 0DTE flow is fully visible in OI |

Every module ends with an **Evidence** box tied to the studies in `research/`. If a claim is not in those boxes, treat it as intuition, not curriculum.

---

## Course map (6 modules ≈ 4–6 hours + practice)

| # | Module | Time | You leave able to |
|---|---|---|---|
| 0 | Setup & mental model | 30–45 min | Run GLP, draw to TradingView, know the three clocks |
| 1 | Regime: Flip and net gamma | 45 min | Say “positive / negative / transition” and what that means for *volatility* |
| 2 | Levels: Pin, walls, air pocket | 45 min | Label the chart without treating every line as an entry |
| 3 | Term structure (near vs monthly) | 30 min | Use “fragile / recovering / aligned” as durability, not width |
| 4 | Sessions: Asia, London, RTH | 45 min | Pick a session, read the range band, size expectations |
| 5 | Playbook & practice | 60 min | Use Action Center + Session Map without overtrading the lines |
| 6 | (Optional) Research lab | 60 min | Re-run the studies that justify the course |

---

## Module 0 — Setup & mental model

### Objectives
- Install / launch GLP, add UW API key, map QQQ→NQ (or SPY→ES).
- Draw the action plan for the **correct session**.
- Recite the three refresh clocks.

### Mechanics in one paragraph
Dealers hedge options. When they are **long gamma** (spot above the flip), hedging sells strength and buys weakness → ranges hold. When they are **short gamma** (spot below the flip), hedging adds to the move → ranges expand. That is a statement about *how far*, not *which way*.

### Lab
1. Start GLP → underlying QQQ → horizon **weekly** → convert to **NQ** with **Live** ratio.  
2. Action Center should show Bias + Session expectations + Level refresh policy (not the old “long above / short below” template).  
3. Session dropdown: **RTH** during the US cash day; **Asia** / **London** overnight. Draw to TradingView.  
4. Confirm on chart: Flip, Struct flip (if shown), PIN, session range band, short banner.

### Three clocks (memorize)
| Clock | Interval | What moves |
|---|---|---|
| Chain / pin / walls | 15–30 min (default 20) | Re-price yesterday’s OI |
| Spot vs flip | ~60s | Regime can cross without magnets moving |
| Futures ratio | ~30s | Keeps lines on the NQ/ES print |
| Anchors | 09:25, 12:00, 15:00 ET | Force a full pull |

Code: `source/gex_refresh.py`.

### Evidence
OI settles overnight. Intraday refetches are mostly re-pricing, not a new book. Same-day 0DTE that never hits OI is invisible.

---

## Module 1 — Regime (Flip)

### Objectives
- Find Flip (near-dated zero gamma) on Action Center and the chart.
- Classify: positive / negative / transition (noise band around the flip).
- State invalidation: acceptance through the flip ends the pinning read.

### How to read it
- **Above flip** → positive gamma → expect *suppressed* travel; breakouts fail more often.  
- **Below flip** → negative gamma → expect *amplified* travel; do not fade blindly.  
- **On the flip** → lowest conviction; wait for acceptance.

### Lab
1. Note Flip and distance % in Action Center.  
2. On the Live Dashboard, confirm the purple Flip line (or “above/below view” if off-scale).  
3. Ask: if price accepts through Flip, what in the plan dies? (Answer: the pin/fade playbook.)

### Evidence
- Session range is ~1.3–1.6× wider in negative vs positive gamma on ES/NQ/YM (`research/scenario_study.py`).  
- Directional lean (P(up) by regime) did **not** clear a proper regime-vs-regime test.  
- Playbook “RECLAIM_FLIP” as a long entry lost money (`research/playbook_backtest.py`).

**Rule of thumb:** Flip = regime boundary and invalidation — not a buy/sell magnet.

---

## Module 2 — Pin, walls, air pocket

### Objectives
- Define Pin (largest +GEX strike), Call wall (+GEX above), Support shelf (+GEX below), Air pocket (−GEX below).  
- Never call a negative-gamma strike “support.”

### How to read it
| Level | Mechanism | Use |
|---|---|---|
| Pin | Heaviest +GEX | Range reference / magnet narrative in positive gamma |
| Call wall | +GEX above spot | Ceiling *candidate*; weak walls are labeled — ignore for fades |
| Support shelf | +GEX below spot | Floor *candidate* in positive gamma |
| Air pocket | −GEX below | Acceleration zone — not a bid |

### Lab
1. Match Action Center lines to TV labels (PIN, Call wall / +GEX shelf, Air pocket).  
2. If Call wall is “weak,” say out loud: “I will not fade that.”  
3. Sketch: spot → pin gap. Is the pin also the call wall? Then it is target **and** cap — not “fade back to itself.”

### Evidence
- Pin convergence into the close did not beat a mirror placebo on SPY/QQQ (`research/pin_study.py`).  
- Mechanical FADE_WALL / BUY_SHELF setups lost on average (`research/playbook_backtest.py`).  
- Walls still matter as **map** (where hedging is thick) even when they are not ATMs.

**Rule of thumb:** Trade *location and size* from the map; do not auto-enter because price tagged a line.

---

## Module 3 — Term structure (near vs monthly)

### Objectives
- Read Flip (near) vs Flip (monthly) / Struct flip.  
- States: **aligned**, **fragile**, **recovering**, **unknown**.

### How to read it
- **Aligned** — near and monthly agree → more durable regime story.  
- **Fragile** — pinning near-dated but spot still under monthly flip → day-trade condition, not overnight faith.  
- **Recovering** — stress near-dated, calmer monthly → reclaim of near flip more believable.  
- **Unknown** — “all” horizon or degenerate monthly = do not invent confidence.

### Lab
1. Find “Term structure” in Action Center / metrics bar.  
2. If banner says FRAGILE, write one sentence: “I will not hold this pin thesis into Asia.”

### Evidence
With near-dated sign held fixed, monthly sign did **not** change expected session width (`research/scenario_study.py`). Monthly flip stays as **durability context**, not a second width input.

---

## Module 4 — Sessions (Asia / London / RTH)

### Objectives
- Know windows (ET): Asia 18:00–03:00, London 03:00–09:30, RTH 09:30–16:00.  
- Read Session Map cones (quiet / typical / wide).  
- Pick the session that matches what you are trading *now*.

### How to read it
- Cones are **symmetric on purpose** — no directional edge was measured.  
- Use **wide** (upper quartile) as “how bad can travel get,” not typical as a hard cap (half the days exceed the median by definition).  
- Overnight: US options are closed; the book is frozen; futures still hedge → width signal often cleaner.

### Lab
1. Open **Session Map** tab after futures conversion.  
2. Compare NQ negative vs positive typical points for Asia.  
3. Draw with session = Asia before the open; confirm drawings span from *now* through session close during prep.

### Evidence
- Regime widens range in Asia/London/RTH for ES, NQ, YM; not established for GC; weak/lopsided for RTY (`research/scenario_study.py`, `session_study.py`).  
- Calibration file: `source/gex_calibration.json` (rebuild: `python research/scenario_study.py --emit`).

---

## Module 5 — Daily playbook (how to actually use it)

### Pre-market / session open checklist
1. Pull weekly book → convert to futures (live ratio).  
2. Write in one line: `Regime ____ | Term ____ | Pin ____ | Flip ____ | Session ____ typical ____ / wide ____`.  
3. Draw **that** session only.  
4. Set mental invalidation: acceptance through Flip (positive) or reclaim/hold Flip (negative).  
5. Size stops using session **wide** band, not yesterday’s tick noise.

### During the session
- Refresh chain ~20 min; watch Flip crosses live.  
- If price is chopping inside the range band in positive gamma → patience, not chase.  
- If negative gamma and range is already “wide” early → reduce size; expansion is the base case.  
- Do **not** add because a wall was tagged unless *your* discretionary trigger (structure, tape) agrees.

### After the session
- Screenshot TV + paste Action Center summary into a journal.  
- Tag: Did realized range sit under wide? Did Flip break? Did you invent a direction the tool did not give?

### Evidence (playbook backtest)
`python research/playbook_backtest.py`  
Mechanical fades/reclaims: **~−4.6 bp/trade**, win ~28%, CI through zero (NQ+ES, ~2.5 months of strike history).  
**Curriculum conclusion:** GLP is a **volatility & invalidation framework**, not a turnkey entry bot.

---

## Module 6 — Research lab (optional, advanced)

Rebuild the claims yourself (requires UW key + cached data under `research/data/`):

```text
python research/scenario_study.py --emit
python research/session_study.py
python research/pin_study.py SPY QQQ
python research/playbook_backtest.py --fut NQ --session rth
python research/close_regime_study.py
```

Deliverable: one page — “What I will use tomorrow” vs “What I will ignore.”

---

## Illustrations (RocketScooter-style expectations)

The **Session Map** is the illustration layer: measured cones by regime/session, Flip shaded as a boundary, levels color-matched to TV.  
It deliberately does **not** tilt cones bullish/bearish — the data did not support that.

Files: `source/gex_illustrate.py`, `source/gex_scenarios.py`.

---

## Stream companion (YouTube / OBS)

Secondary program for play-by-play education while you stream:

1. `Start-GLP-Stream-Companion.cmd` → director desk at http://127.0.0.1:8765/?mode=desk  
2. OBS Browser Source: `http://127.0.0.1:8765/?mode=overlay` (transparent) or `?mode=lower`  
3. Keep GLP desktop converting — it writes talk-track state to `%APPDATA%\GLP\stream_state.json`  
4. On stream: advance **Beats** (what to say) while the lower-third cycles levels  

Always on-screen: educational only / not financial advice.  
Journal for research: `%APPDATA%\GLP\stream_journal.jsonl` → `python research/advisor_scorecard.py`

## Discord webhooks (optional ops)

GLP can post the Action Center embed to a webhook (private channel recommended).

- Desktop: **Futures Conversion** → paste webhook → **Post to Discord** (optional Auto-post on convert, 5 min cooldown).  
- CLI: `python source/glp_pipeline.py -u QQQ --discord` (uses `GLP_DISCORD_WEBHOOK`) or `--discord https://discord.com/api/webhooks/...`  
- Module: `source/discord_webhook.py`

### Mention bot (update + chart screenshot)

Webhooks cannot hear `@mentions`. For “@tag → refresh → screenshot → analysis,” run the local bot:

1. Create a Discord bot, enable **Message Content Intent**, invite with Send/Attach/Embed.  
2. Run **`Setup-GLP-Discord-Bot.cmd`** — installs `discord.py`, saves token to `%APPDATA%\GLP\discord_bot_token` (same pattern as the UW key).  
3. Keep TradingView Desktop on CDP **9222** + UW key on that PC.  
4. **`Start-GLP-Discord-Bot.cmd`** (preflight then runs).  
5. In Discord: `@Argos trade NQ` (senior what-I-would-watch read — **not** financial advice), `@Argos daily NQ`, or `!argos daily ES`.  

This bot is **not** Cursor — it runs GLP on your machine and replies in-channel. Optional allow-lists via setup or `%APPDATA%\GLP\discord_bot_allowlist.env`.

**Safe path:** private / cohort channel, each student BYOK.  
**Risky path:** paid public blast of live vendor-derived GEX as “signals.”

## Monetization / packaging notes (instructor)

- **Safe path:** Sell software + education; student uses their own UW key; no public Discord dump of live GEX tables.  
- **Risky path:** Publishing live vendor-derived levels to a paid channel without redistribution rights; marketing “signals” that look like CTA advice.  
- Course language: “how the tool frames the day,” never “guaranteed reaction at HP/MHP.”  
- HP/MHP in older slides = **Flip (near)** and **Flip (monthly) / Struct flip** in current GLP.

---

## Quick reference card (print this)

```text
POSITIVE GAMMA     → expect quieter travel; pin is a reference; Flip is invalidation
NEGATIVE GAMMA     → expect wider travel; do not fade; Flip reclaim ≠ auto-long
FRAGILE TERM       → pin is for the day, not the overnight hold
SESSION BAND       → size with WIDE; typical is not a ceiling
REFRESH            → chain 20m | regime 60s | ratio 30s | anchors 09:25 / 12:00 / 15:00
ENTRIES            → your discretion + structure; GEX is the map, not the trigger
```

---

## Version

Aligned with GLP Standalone studies through the playbook backtest and calibration sample (`gex_calibration.json`).  
Rebuild evidence before each cohort if the API history window or markets change.
