"""
Sweep Engine — scenario grid (local proxy backtest).

Mirrors *reactive* sweep logic from sweep-engine-v2-secondary.pine (CT sessions,
IB / London / Asia sweeps, round/VWAP/Lon50 confluence, optional depth gate,
sandbox trend, flatten time). Does NOT replicate the predictive model.

150 unique scenarios (no duplicate parameter sets; each row includes its own contract count 2 or 3 MNQ).
For real CME backtests, run `node scripts/tv-sweep-150.mjs` with TradingView Desktop + CDP (see script header).

Usage:
  pip install pandas numpy yfinance
  python sweep_optimizer.py
  python sweep_optimizer.py --export-tv-json-only

Outputs:
  sweep_optimizer_results.csv
  sweep_optimizer_best.json
  data/sweep_tv_scenarios_150.json   # for tv-sweep-150.mjs
"""

from __future__ import annotations

import argparse
import json
import os
import random
from dataclasses import asdict, dataclass
from typing import Any, Literal

import numpy as np
import pandas as pd
import yfinance as yf

TZ = "America/Chicago"
POINT_USD = 2.0  # MNQ $/point/contract
COMMISSION_PER_CONTRACT_RT = 1.24  # ~0.62/side, round-turn proxy


@dataclass
class SweepScenario:
    scenario_id: int
    contracts: int
    atr_len: int
    sl_mult: float
    tp_mult: float
    cooldown: int
    min_conf: int
    round_intvl: int
    conf_prox: float
    sweep_depth_atr: float
    use_lon50: bool
    block_reactive_long_bear_pool: bool
    sandbox: Literal["none", "vwap", "ema200", "both"]
    exec_style: Literal["close", "limit_level"]
    flat_hr: int
    flat_mn: int


def download_mnq_5m() -> pd.DataFrame:
    df = yf.download("MNQ=F", period="60d", interval="5m", auto_adjust=False, progress=False)
    if df.empty:
        raise RuntimeError("No data from yfinance for MNQ=F")
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    df = df[["Open", "High", "Low", "Close", "Volume"]].astype(float).dropna()
    idx = pd.DatetimeIndex(df.index)
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    df.index = idx.tz_convert(TZ)
    return df


def session_flags(ts: pd.Timestamp) -> tuple[int, int, bool, bool, bool, bool, bool, bool, bool]:
    """Chicago hour, minute, isAsia, isLondon, isIB, isPostIB, isKillzone components."""
    t = ts.tz_convert(TZ)
    hr, mn = t.hour, t.minute
    is_asia = hr >= 18 or hr < 1
    is_london = 1 <= hr < 4
    is_ib = (hr == 8 and mn >= 30) or (hr == 9 and mn < 30)
    is_post_ib = (hr == 9 and mn >= 30) or (10 <= hr < 15)
    is_ny_am_kz = (hr == 7 and mn >= 30) or hr == 8 or (hr == 9 and mn < 30)
    is_sb_am = hr == 9 or (hr == 10 and mn == 0)
    is_lon_close = hr == 9 or (hr == 10 and mn < 30)
    is_killzone = is_ny_am_kz or is_sb_am or is_lon_close
    return hr, mn, is_asia, is_london, is_ib, is_post_ib, is_killzone


def build_scenarios_150_unique(seed: int = 42) -> list[SweepScenario]:
    """150 distinct scenarios (full parameter tuple + contracts); none repeated."""
    rng = random.Random(seed)
    contracts_choices = [2, 3]
    sl_choices = [3.0, 3.5, 4.0, 4.5, 5.0]
    tp_choices = [2.5, 3.0, 3.5, 4.0, 4.5, 5.0]
    cd_choices = [4, 6, 8, 10, 12, 16]
    min_conf_choices = [0, 1, 2]
    round_choices = [50, 100, 250, 500]
    prox_choices = [0.75, 1.0, 1.25, 1.5, 2.0, 2.5]
    depth_choices = [0.0, 0.08, 0.12, 0.18, 0.25]
    sandbox_choices: list[Any] = ["none", "vwap", "ema200", "both"]
    exec_choices: list[Any] = ["close", "limit_level"]
    flat_hr_choices = [14, 15, 16]
    flat_mn_choices = [0, 15, 30]
    atr_choices = [10, 14, 20]

    out: list[SweepScenario] = []
    seen: set[tuple[Any, ...]] = set()
    sid = 0
    max_attempts = 50000
    attempts = 0
    while len(out) < 150 and attempts < max_attempts:
        attempts += 1
        tup = (
            rng.choice(contracts_choices),
            rng.choice(atr_choices),
            rng.choice(sl_choices),
            rng.choice(tp_choices),
            rng.choice(cd_choices),
            rng.choice(min_conf_choices),
            rng.choice(round_choices),
            round(rng.choice(prox_choices), 2),
            rng.choice(depth_choices),
            rng.choice([True, False]),
            rng.choice([True, False]),
            rng.choice(sandbox_choices),
            rng.choice(exec_choices),
            rng.choice(flat_hr_choices),
            rng.choice(flat_mn_choices),
        )
        if tup in seen:
            continue
        seen.add(tup)
        sid += 1
        out.append(
            SweepScenario(
                scenario_id=sid,
                contracts=tup[0],
                atr_len=tup[1],
                sl_mult=tup[2],
                tp_mult=tup[3],
                cooldown=tup[4],
                min_conf=tup[5],
                round_intvl=tup[6],
                conf_prox=tup[7],
                sweep_depth_atr=tup[8],
                use_lon50=tup[9],
                block_reactive_long_bear_pool=tup[10],
                sandbox=tup[11],
                exec_style=tup[12],
                flat_hr=tup[13],
                flat_mn=tup[14],
            )
        )
    if len(out) < 150:
        raise RuntimeError(f"Could only sample {len(out)} unique scenarios; expand choice lists.")
    return out


# Canonical in_* indices for sweep-engine-v2-secondary.pine WITH i_contracts (first Signal input = contracts).
EXPECTED_ENTRY_MODE_IN = 52
PINE_SCRIPT_INPUT_MAX_EXCLUSIVE = 63  # in_0 .. in_62


def scenario_to_tv_inputs(p: SweepScenario) -> dict[str, Any]:
    """TradingView study input overrides (Pine script section only)."""
    entry_str = (
        "Reactive sweep (close)"
        if p.exec_style == "close"
        else "Reactive limit (swept level)"
    )
    sandbox_tv = {
        "none": "None",
        "vwap": "VWAP",
        "ema200": "EMA200",
        "both": "VWAP+EMA200",
    }[p.sandbox]
    return {
        "in_0": p.contracts,
        "in_1": p.atr_len,
        "in_2": p.sl_mult,
        "in_3": p.tp_mult,
        "in_4": p.cooldown,
        "in_5": p.min_conf,
        "in_10": p.use_lon50,
        "in_11": p.round_intvl,
        "in_12": p.conf_prox,
        "in_13": p.flat_hr,
        "in_14": p.flat_mn,
        "in_22": True,
        "in_37": p.sweep_depth_atr,
        "in_52": entry_str,
        "in_59": p.block_reactive_long_bear_pool,
        "in_62": sandbox_tv,
    }


def export_tv_json(scenarios: list[SweepScenario], path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {
        "schema": "sweep-secondary-v1",
        "description": "Canonical in_* for sweep-engine-v2-secondary.pine with i_contracts. tv-sweep-150.mjs shifts keys if chart uses older saved script.",
        "expected_entry_mode_in": EXPECTED_ENTRY_MODE_IN,
        "pine_script_input_max_exclusive": PINE_SCRIPT_INPUT_MAX_EXCLUSIVE,
        "scenarios": [
            {
                "id": s.scenario_id,
                "contracts": s.contracts,
                "tv_inputs": scenario_to_tv_inputs(s),
                "semantic": asdict(s),
            }
            for s in scenarios
        ],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def run_sweep_backtest(df: pd.DataFrame, p: SweepScenario) -> dict[str, Any]:
    """Single-thread bar loop; returns aggregate stats."""
    o, h, l, c, v = df["Open"], df["High"], df["Low"], df["Close"], df["Volume"]

    tr = pd.concat(
        [
            h - l,
            (h - c.shift(1)).abs(),
            (l - c.shift(1)).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr_s = tr.rolling(p.atr_len, min_periods=p.atr_len).mean()
    ema200 = c.ewm(span=200, adjust=False).mean()

    # Per-day VWAP (reset at CT calendar day)
    days = df.index.tz_convert(TZ).normalize()
    tp = (h + l + c) / 3.0
    pv = tp * v
    vwap_series = pd.Series(index=df.index, dtype=float)
    for d in days.unique():
        m = days == d
        sub_pv = pv[m].cumsum()
        sub_v = v[m].cumsum()
        vwap_series.loc[m] = sub_pv / sub_v.replace(0, np.nan)

    times = list(df.index)
    n = len(df)

    position: dict[str, Any] | None = None
    last_entry_i = -10_000
    trades: list[float] = []
    equity = 0.0
    peak = 0.0
    max_dd = 0.0

    contracts = p.contracts

    def pnl_pts(side: str, e: float, x: float) -> float:
        raw = (x - e) * POINT_USD * contracts if side == "long" else (e - x) * POINT_USD * contracts
        return raw - COMMISSION_PER_CONTRACT_RT * contracts

    # Daily / session state (mirrors Pine vars)
    prev_ct_date = None
    ib_h = ib_l = np.nan
    lon_h = lon_l = lon_50 = np.nan
    asia_h = asia_l = np.nan
    ib_ok = lon_ok = asia_ok = False
    sw_ib_l = sw_ib_h = sw_lon_l = sw_lon_h = sw_as_l = sw_as_h = False
    trades_today = 0

    prev_is_ib = prev_is_lon = prev_is_asia = False

    for i in range(n):
        ts = times[i]
        ct = ts.tz_convert(TZ)
        ct_date = ct.date()
        hr, mn, is_asia, is_london, is_ib, is_post_ib, is_killzone = session_flags(ts)

        if prev_ct_date is None or ct_date != prev_ct_date:
            prev_ct_date = ct_date
            ib_h = ib_l = np.nan
            lon_h = lon_l = lon_50 = np.nan
            asia_h = asia_l = np.nan
            ib_ok = lon_ok = asia_ok = False
            sw_ib_l = sw_ib_h = sw_lon_l = sw_lon_h = sw_as_l = sw_as_h = False
            trades_today = 0

        atrv = atr_s.iat[i]
        vw = vwap_series.iat[i]
        cls = c.iat[i]
        hi = h.iat[i]
        lo = l.iat[i]

        past_flat = (hr > p.flat_hr) or (hr == p.flat_hr and mn >= p.flat_mn)

        # Form session boxes
        if is_ib:
            ib_h = hi if np.isnan(ib_h) else max(ib_h, hi)
            ib_l = lo if np.isnan(ib_l) else min(ib_l, lo)
        if prev_is_ib and not is_ib:
            ib_ok = not (np.isnan(ib_h) or np.isnan(ib_l))

        if is_london:
            lon_h = hi if np.isnan(lon_h) else max(lon_h, hi)
            lon_l = lo if np.isnan(lon_l) else min(lon_l, lo)
            lon_50 = (lon_h + lon_l) / 2.0
        if prev_is_lon and not is_london:
            lon_ok = not (np.isnan(lon_h) or np.isnan(lon_l))

        if is_asia:
            asia_h = hi if np.isnan(asia_h) else max(asia_h, hi)
            asia_l = lo if np.isnan(asia_l) else min(asia_l, lo)
        if prev_is_asia and not is_asia:
            asia_ok = not (np.isnan(asia_h) or np.isnan(asia_l))

        prev_is_ib, prev_is_lon, prev_is_asia = is_ib, is_london, is_asia

        if pd.isna(atrv):
            continue

        depth_req = p.sweep_depth_atr > 0
        lon50_bull = (not p.use_lon50) or (lon_ok and cls > lon_50)
        lon50_bear = (not p.use_lon50) or (lon_ok and cls < lon_50)

        def d_bull(level: float) -> bool:
            if not depth_req:
                return True
            return (level - lo) >= atrv * p.sweep_depth_atr

        def d_bear(level: float) -> bool:
            if not depth_req:
                return True
            return (hi - level) >= atrv * p.sweep_depth_atr

        sweep_ib_lo = (
            ib_ok
            and is_post_ib
            and lo < ib_l
            and cls > ib_l
            and lon50_bull
            and d_bull(ib_l)
        )
        sweep_ib_hi = (
            ib_ok
            and is_post_ib
            and hi > ib_h
            and cls < ib_h
            and lon50_bear
            and d_bear(ib_h)
        )
        sweep_lon_lo = (
            lon_ok
            and is_killzone
            and lo < lon_l
            and cls > lon_l
            and lon50_bull
            and d_bull(lon_l)
        )
        sweep_lon_hi = (
            lon_ok
            and is_killzone
            and hi > lon_h
            and cls < lon_h
            and lon50_bear
            and d_bear(lon_h)
        )
        sweep_as_lo = (
            asia_ok
            and is_killzone
            and lo < asia_l
            and cls > asia_l
            and lon50_bull
            and d_bull(asia_l)
        )
        sweep_as_hi = (
            asia_ok
            and is_killzone
            and hi > asia_h
            and cls < asia_h
            and lon50_bear
            and d_bear(asia_h)
        )

        if sweep_ib_lo:
            sw_ib_l = True
        if sweep_ib_hi:
            sw_ib_h = True
        if sweep_lon_lo:
            sw_lon_l = True
        if sweep_lon_hi:
            sw_lon_h = True
        if sweep_as_lo:
            sw_as_l = True
        if sweep_as_hi:
            sw_as_h = True

        bull_sweep = sweep_ib_lo or sweep_as_lo or sweep_lon_lo
        bear_sweep = sweep_ib_hi or sweep_as_hi or sweep_lon_hi

        rnd_a = np.ceil(cls / p.round_intvl) * p.round_intvl
        rnd_b = np.floor(cls / p.round_intvl) * p.round_intvl
        near_round = min(abs(cls - rnd_a), abs(cls - rnd_b)) < atrv * p.conf_prox
        near_vwap = abs(cls - vw) < atrv * p.conf_prox if not pd.isna(vw) else False
        lon50_abull = lon_ok and cls > lon_50
        lon50_abear = lon_ok and cls < lon_50
        conf_bull = int(near_round) + int(near_vwap) + int(lon50_abull)
        conf_bear = int(near_round) + int(near_vwap) + int(lon50_abear)

        # Pool edge proxy for reactive long block (bear pool)
        best_low = 0.0
        best_high = 0.0
        if ib_ok and not np.isnan(ib_l) and ib_l < cls:
            best_low = max(best_low, 1.0 / (1.0 + (cls - ib_l) / atrv * 0.68))
        if lon_ok and not np.isnan(lon_l) and lon_l < cls:
            best_low = max(best_low, 1.2 / (1.0 + (cls - lon_l) / atrv * 0.68))
        if asia_ok and not np.isnan(asia_l) and asia_l < cls:
            best_low = max(best_low, 1.1 / (1.0 + (cls - asia_l) / atrv * 0.68))
        if ib_ok and not np.isnan(ib_h) and ib_h > cls:
            best_high = max(best_high, 1.0 / (1.0 + (ib_h - cls) / atrv * 0.68))
        if lon_ok and not np.isnan(lon_h) and lon_h > cls:
            best_high = max(best_high, 1.2 / (1.0 + (lon_h - cls) / atrv * 0.68))
        if asia_ok and not np.isnan(asia_h) and asia_h > cls:
            best_high = max(best_high, 1.1 / (1.0 + (asia_h - cls) / atrv * 0.68))
        pred_dom = 1 if best_low > best_high else (-1 if best_high > best_low else 0)
        reactive_long_model_ok = (not p.block_reactive_long_bear_pool) or (pred_dom != -1)

        ema2 = ema200.iat[i]
        sandbox_long = sandbox_short = True
        if p.sandbox == "vwap":
            sandbox_long = pd.notna(vw) and cls > vw
            sandbox_short = pd.notna(vw) and cls < vw
        elif p.sandbox == "ema200":
            sandbox_long = not pd.isna(ema2) and cls > ema2
            sandbox_short = not pd.isna(ema2) and cls < ema2
        elif p.sandbox == "both":
            sandbox_long = (not pd.isna(vw) and cls > vw) and (not pd.isna(ema2) and cls > ema2)
            sandbox_short = (not pd.isna(vw) and cls < vw) and (not pd.isna(ema2) and cls < ema2)

        cd_ok = i - last_entry_i > p.cooldown
        can_enter = (not past_flat) and (position is None) and cd_ok

        long_sig = (
            bull_sweep
            and can_enter
            and conf_bull >= p.min_conf
            and reactive_long_model_ok
            and sandbox_long
        )
        short_sig = bear_sweep and can_enter and conf_bear >= p.min_conf and sandbox_short

        swept_long = np.nan
        if sweep_ib_lo:
            swept_long = ib_l
        elif sweep_as_lo:
            swept_long = asia_l
        elif sweep_lon_lo:
            swept_long = lon_l

        swept_short = np.nan
        if sweep_ib_hi:
            swept_short = ib_h
        elif sweep_as_hi:
            swept_short = asia_h
        elif sweep_lon_hi:
            swept_short = lon_h

        # Manage open position
        if position is not None:
            if past_flat:
                pnl = pnl_pts(position["side"], position["entry"], cls)
                trades.append(pnl)
                equity += pnl
                peak = max(peak, equity)
                max_dd = max(max_dd, peak - equity)
                position = None
            else:
                side = position["side"]
                sl = position["sl"]
                tp = position["tp"]
                if side == "long":
                    if lo <= sl:
                        pnl = pnl_pts("long", position["entry"], sl)
                        trades.append(pnl)
                        equity += pnl
                        peak = max(peak, equity)
                        max_dd = max(max_dd, peak - equity)
                        position = None
                    elif hi >= tp:
                        pnl = pnl_pts("long", position["entry"], tp)
                        trades.append(pnl)
                        equity += pnl
                        peak = max(peak, equity)
                        max_dd = max(max_dd, peak - equity)
                        position = None
                else:
                    if hi >= sl:
                        pnl = pnl_pts("short", position["entry"], sl)
                        trades.append(pnl)
                        equity += pnl
                        peak = max(peak, equity)
                        max_dd = max(max_dd, peak - equity)
                        position = None
                    elif lo <= tp:
                        pnl = pnl_pts("short", position["entry"], tp)
                        trades.append(pnl)
                        equity += pnl
                        peak = max(peak, equity)
                        max_dd = max(max_dd, peak - equity)
                        position = None

        if position is None and not past_flat:
            if long_sig:
                if p.exec_style == "close":
                    ent = cls
                else:
                    ent = float(swept_long)
                    if np.isnan(ent):
                        ent = cls
                    # same-bar stop: if wick violated SL below entry
                    sl_try = ent - atrv * p.sl_mult
                    if lo <= sl_try:
                        continue
                sl = ent - atrv * p.sl_mult
                tp = ent + atrv * p.tp_mult
                position = {"side": "long", "entry": ent, "sl": sl, "tp": tp}
                last_entry_i = i
                trades_today += 1
            elif short_sig:
                if p.exec_style == "close":
                    ent = cls
                else:
                    ent = float(swept_short)
                    if np.isnan(ent):
                        ent = cls
                    sl_try = ent + atrv * p.sl_mult
                    if hi >= sl_try:
                        continue
                sl = ent + atrv * p.sl_mult
                tp = ent - atrv * p.tp_mult
                position = {"side": "short", "entry": ent, "sl": sl, "tp": tp}
                last_entry_i = i
                trades_today += 1

    wins = sum(1 for x in trades if x > 0)
    n_tr = len(trades)
    win_rate = wins / n_tr if n_tr else 0.0
    gross_profit = sum(x for x in trades if x > 0)
    gross_loss = -sum(x for x in trades if x < 0)
    pf = gross_profit / gross_loss if gross_loss > 0 else float("inf") if gross_profit > 0 else 0.0

    return {
        "net_profit": float(equity),
        "max_drawdown": float(max_dd),
        "trades": n_tr,
        "win_rate": float(win_rate),
        "profit_factor": float(pf) if pf != float("inf") else 999.0,
        "contracts": contracts,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--export-tv-json-only",
        action="store_true",
        help="Only write data/sweep_tv_scenarios_150.json (no yfinance download).",
    )
    args = ap.parse_args()

    root = "C:\\Users\\dypag\\tradingview-mcp"
    tv_path = f"{root}\\data\\sweep_tv_scenarios_150.json"

    scenarios = build_scenarios_150_unique(seed=42)
    export_tv_json(scenarios, tv_path)
    print(f"Wrote {tv_path} ({len(scenarios)} unique scenarios)")

    if args.export_tv_json_only:
        return

    print("Downloading MNQ=F 5m ...")
    df = download_mnq_5m()
    print(f"Bars: {len(df)}  range: {df.index[0]} -> {df.index[-1]}")

    rows: list[dict[str, Any]] = []
    for s in scenarios:
        stats = run_sweep_backtest(df, s)
        rows.append({**asdict(s), **stats})

    out = pd.DataFrame(rows)
    path = f"{root}\\sweep_optimizer_results.csv"
    out.to_csv(path, index=False)
    print(f"Wrote {path} ({len(out)} rows)")

    for nq in (2, 3):
        sub = out[out["contracts"] == nq]
        if len(sub) == 0:
            continue
        best = sub.loc[sub["net_profit"].idxmax()]
        print(f"\nBest net profit @ {nq} MNQ:\n", best.to_string())

    best_row = out.loc[out["net_profit"].idxmax()]
    with open(f"{root}\\sweep_optimizer_best.json", "w", encoding="utf-8") as f:
        json.dump(best_row.to_dict(), f, indent=2)
    print("\nSaved sweep_optimizer_best.json (overall max net across 150 unique scenarios)")


if __name__ == "__main__":
    main()
