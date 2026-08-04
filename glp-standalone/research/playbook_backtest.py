"""Backtest the Action Center playbook on NQ/ES 5-minute bars.

Uses the prior session's by-strike book (same lag as live GLP) so there is no
lookahead on levels. Rules mirror gex_bias / the chart plan:

  Positive gamma
    FADE_WALL   short when price tags the call wall; target pin; stop beyond wall
    BUY_SHELF   long when price tags the +GEX support shelf; target pin; stop
                through the flip (regime invalidation)

  Negative gamma
    BREAK_POCKET  short when price loses the air pocket; target = 1x session
                  quiet range; stop back above the pocket
    RECLAIM_FLIP  long when price reclaims the flip; same target/stop pattern

One trade per setup per session. Sessions: Asia / London / RTH.

Usage:
  python research/playbook_backtest.py
  python research/playbook_backtest.py --fut NQ --session rth
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "source"))
sys.path.insert(0, str(HERE))

from gex_bias import REGIME_NEGATIVE, REGIME_POSITIVE, compute_bias  # noqa: E402
from gex_scenarios import expectation, load_calibration  # noqa: E402
from pin_study import pin_from_rows  # noqa: E402
from scenario_study import _flip_level  # noqa: E402

DATA = HERE / "data"
CACHE = DATA / "strike_cache"
ET = "America/New_York"

PAIRS = {"NQ": ("QQQ", "yahoo_NQF_60d_5m.json"),
         "ES": ("SPY", "yahoo_ESF_60d_5m.json")}
SESSIONS = {
    "asia": (18.0, 3.0),
    "london": (3.0, 9.5),
    "rth": (9.5, 16.0),
}
# Stop beyond the wall as a fraction of the wall-pin gap (or of price).
WALL_STOP_FRAC = 0.25
MIN_GAP_BP = 5.0  # ignore setups tighter than this


# --------------------------------------------------------------------------
# data
# --------------------------------------------------------------------------
def load_fut_bars(path: Path) -> pd.DataFrame:
    res = json.loads(path.read_text())["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    df = pd.DataFrame({
        "ts": res["timestamp"], "open": q["open"], "high": q["high"],
        "low": q["low"], "close": q["close"],
    }).dropna()
    df["et"] = pd.to_datetime(df["ts"], unit="s", utc=True).dt.tz_convert(ET)
    df["h"] = df["et"].dt.hour + df["et"].dt.minute / 60.0
    df["cal"] = df["et"].dt.date
    return df.sort_values("et").reset_index(drop=True)


def etf_closes(etf: str) -> dict:
    path = DATA / f"{etf.lower()}_candles.json"
    cd = pd.DataFrame(json.loads(path.read_text())["data"])
    cd["end"] = pd.to_datetime(cd["end"], utc=True).dt.tz_convert(ET)
    cd["d"] = cd["end"].dt.date
    closing = cd[cd["end"].dt.strftime("%H:%M") == "16:00"]
    return dict(zip(closing["d"], closing["c"].astype(float)))


def strike_levels(etf: str) -> pd.DataFrame:
    """One row per date: flip, pin, walls, air pocket, regime — ETF scale."""
    spots = etf_closes(etf)
    rows = []
    for f in sorted(CACHE.glob(f"{etf}_*.json")):
        gdate = pd.to_datetime(f.stem.split("_", 1)[1]).date()
        spot = spots.get(gdate)
        try:
            recs = json.loads(f.read_text())
        except Exception:
            continue
        if not spot or not isinstance(recs, list):
            continue
        pos, neg = [], []
        for r in recs:
            ckey = "call_gex" if "call_gex" in r else "call_gamma"
            pkey = "put_gex" if "put_gex" in r else "put_gamma"
            try:
                strike = float(r["strike"])
                net = float(r.get(ckey) or 0.0) + float(r.get(pkey) or 0.0)
            except (TypeError, ValueError, KeyError):
                continue
            entry = {"price": strike, "gex_bn": net / 1e9}
            (pos if net >= 0 else neg).append(entry)
        flip = _flip_level(recs, spot)
        pin, total, pin_raw = pin_from_rows(recs)
        if flip is None or pin is None:
            continue
        bias = compute_bias(
            spot=spot, positives=pos, negatives=neg, flip=flip,
            pin=pin, pin_bn=(pin_raw / 1e9) if pin_raw is not None else None,
            positive_total_bn=sum(e["gex_bn"] for e in pos) or None,
            total_bn=(total / 1e9) if total is not None else None,
            horizon="weekly",
        )
        # Drop weak walls: the live plan already refuses to trade them.
        call_wall = None if bias.call_wall_weak else bias.call_wall
        put_wall = None if bias.put_wall_weak else bias.put_wall
        rows.append({
            "gdate": gdate, "spot": spot, "flip": bias.flip, "pin": bias.pin,
            "call_wall": call_wall, "put_wall": put_wall,
            "air_pocket": bias.air_pocket, "regime": bias.regime,
            "confidence": bias.confidence,
        })
    return pd.DataFrame(rows).sort_values("gdate")


def session_slices(bars: pd.DataFrame) -> pd.DataFrame:
    d = bars.copy()

    def label(h):
        if h >= 18.0 or h < 3.0:
            return "asia"
        if 3.0 <= h < 9.5:
            return "london"
        if 9.5 <= h < 16.0:
            return "rth"
        return None

    d["sess"] = d["h"].map(label)
    d = d[d["sess"].notna()].copy()
    d["date"] = np.where(d["h"] >= 18.0, d["cal"] + pd.Timedelta(days=1), d["cal"])
    return d


# --------------------------------------------------------------------------
# simulation
# --------------------------------------------------------------------------
def _gap_bp(a, b, ref) -> float:
    if a is None or b is None or not ref:
        return 0.0
    return abs(a - b) / ref * 1e4


def simulate_day(day_bars: pd.DataFrame, levels: dict, sess: str,
                 calib: dict, fut: str) -> list:
    """Walk 5m bars; at most one fill per setup."""
    if day_bars.empty:
        return []
    o0 = float(day_bars["open"].iloc[0])
    ratio = o0 / levels["spot"]  # open-anchored conversion for that session

    def px(v):
        return None if v is None else float(v) * ratio

    flip = px(levels["flip"])
    pin = px(levels["pin"])
    call_wall = px(levels["call_wall"])
    put_wall = px(levels["put_wall"])
    air = px(levels["air_pocket"])
    regime = levels["regime"]

    exp = expectation(fut, sess, regime if regime in ("positive", "negative")
                      else "negative", o0, calib)
    target_pts = exp.quiet if exp.calibrated else o0 * 0.0025

    trades = []
    fired = set()

    def take(setup, side, entry, target, stop, i0):
        if setup in fired or entry is None or target is None or stop is None:
            return
        if side == "short" and not (stop > entry > target):
            return
        if side == "long" and not (stop < entry < target):
            return
        if _gap_bp(entry, target, entry) < MIN_GAP_BP:
            return
        # Walk forward from the signal bar.
        for j in range(i0, len(day_bars)):
            row = day_bars.iloc[j]
            hi, lo = float(row["high"]), float(row["low"])
            if side == "short":
                if hi >= stop:
                    trades.append(_trade(setup, side, entry, stop, "stop",
                                         regime, sess, row["et"]))
                    fired.add(setup)
                    return
                if lo <= target:
                    trades.append(_trade(setup, side, entry, target, "target",
                                         regime, sess, row["et"]))
                    fired.add(setup)
                    return
            else:
                if lo <= stop:
                    trades.append(_trade(setup, side, entry, stop, "stop",
                                         regime, sess, row["et"]))
                    fired.add(setup)
                    return
                if hi >= target:
                    trades.append(_trade(setup, side, entry, target, "target",
                                         regime, sess, row["et"]))
                    fired.add(setup)
                    return
        # Session end: mark at last close.
        last = float(day_bars["close"].iloc[-1])
        trades.append(_trade(setup, side, entry, last, "eod",
                             regime, sess, day_bars["et"].iloc[-1]))
        fired.add(setup)

    def _trade(setup, side, entry, exit_px, how, regime, sess, when):
        signed = (exit_px - entry) if side == "long" else (entry - exit_px)
        return {
            "setup": setup, "side": side, "entry": entry, "exit": exit_px,
            "how": how, "pnl_pts": signed, "pnl_bp": signed / entry * 1e4,
            "regime": regime, "sess": sess, "when": when,
        }

    highs = day_bars["high"].to_numpy(float)
    lows = day_bars["low"].to_numpy(float)

    for i in range(len(day_bars)):
        hi, lo = highs[i], lows[i]

        if regime == REGIME_POSITIVE:
            if (call_wall is not None and pin is not None
                    and "FADE_WALL" not in fired and hi >= call_wall):
                stop = call_wall + max(call_wall - pin, o0 * 0.001) * WALL_STOP_FRAC
                take("FADE_WALL", "short", call_wall, pin, stop, i)
            if (put_wall is not None and pin is not None and flip is not None
                    and "BUY_SHELF" not in fired and lo <= put_wall
                    and put_wall > flip):
                take("BUY_SHELF", "long", put_wall, pin, flip, i)

        elif regime == REGIME_NEGATIVE:
            if air is not None and "BREAK_POCKET" not in fired and lo < air:
                stop = air + max(target_pts * 0.35, o0 * 0.0008)
                target = air - target_pts
                take("BREAK_POCKET", "short", air, target, stop, i)
            if flip is not None and "RECLAIM_FLIP" not in fired and hi > flip:
                # Reclaim: need a prior bar that traded below the flip.
                if i > 0 and lows[:i].min() < flip:
                    stop = flip - max(target_pts * 0.35, o0 * 0.0008)
                    target = flip + target_pts
                    take("RECLAIM_FLIP", "long", flip, target, stop, i)

    return trades


def run(fut: str = "NQ", sessions=None) -> pd.DataFrame:
    etf, bar_name = PAIRS[fut]
    bars = session_slices(load_fut_bars(DATA / bar_name))
    levels = strike_levels(etf)
    if levels.empty:
        return pd.DataFrame()

    # Prior close's book governs the next trading day.
    gd = sorted(levels["gdate"])
    nxt = {d: gd[i + 1] for i, d in enumerate(gd[:-1])}
    levels = levels.assign(date=levels["gdate"].map(nxt)).dropna(subset=["date"])

    calib = load_calibration()
    sessions = sessions or list(SESSIONS)
    trades = []
    for sess in sessions:
        for date, day in bars[bars["sess"] == sess].groupby("date"):
            row = levels[levels["date"] == date]
            if row.empty:
                continue
            lv = row.iloc[0].to_dict()
            for t in simulate_day(day.sort_values("et"), lv, sess, calib, fut):
                t["date"] = date
                t["fut"] = fut
                trades.append(t)
    return pd.DataFrame(trades)


def report(trades: pd.DataFrame) -> None:
    if trades.empty:
        print("no trades")
        return
    print(f"trades {len(trades)}   {trades['date'].min()} -> {trades['date'].max()}")
    print(f"futures {sorted(trades['fut'].unique())}")
    print()
    print(f"  {'setup':14} {'sess':7} {'n':>4} {'win%':>6} {'avg bp':>8} "
          f"{'med bp':>8} {'sum bp':>9}  target/stop/eod")
    for (setup, sess), g in trades.groupby(["setup", "sess"]):
        wins = (g["pnl_bp"] > 0).mean() * 100
        how = g["how"].value_counts()
        mix = "/".join(str(int(how.get(k, 0))) for k in ("target", "stop", "eod"))
        print(f"  {setup:14} {sess:7} {len(g):4} {wins:5.1f}% "
              f"{g['pnl_bp'].mean():8.1f} {g['pnl_bp'].median():8.1f} "
              f"{g['pnl_bp'].sum():9.1f}  {mix}")
    print()
    print("BY REGIME (all setups pooled)")
    for regime, g in trades.groupby("regime"):
        print(f"  {regime:10} n={len(g):3}  win={(g['pnl_bp']>0).mean():.1%}  "
              f"avg={g['pnl_bp'].mean():+.1f}bp  sum={g['pnl_bp'].sum():+.0f}bp")
    print()
    # Bootstrap mean pnl
    x = trades["pnl_bp"].to_numpy(float)
    rng = np.random.default_rng(0)
    boots = [rng.choice(x, len(x)).mean() for _ in range(4000)]
    lo, hi = np.percentile(boots, [2.5, 97.5])
    print(f"OVERALL  avg {x.mean():+.1f}bp  [{lo:+.1f}, {hi:+.1f}]  "
          f"win={(x>0).mean():.1%}  n={len(x)}")
    print()
    print("Reading guide:")
    print("  avg bp > 0 with a CI above zero = the rule has edged the sample.")
    print("  High stop share on FADE_WALL = walls are not holding (do not lean).")
    print("  Negative-gamma BREAK_POCKET doing well = follow-through is real;")
    print("  RECLAIM_FLIP doing poorly = flip is not a bounce, only a regime line.")
    print("  If the whole book is flat/negative: use GEX for WIDTH and invalidation,")
    print("  not as a mechanical entry trigger.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fut", choices=["NQ", "ES", "both"], default="both")
    ap.add_argument("--session", choices=["asia", "london", "rth", "all"],
                    default="all")
    args = ap.parse_args()
    futs = ["NQ", "ES"] if args.fut == "both" else [args.fut]
    sessions = list(SESSIONS) if args.session == "all" else [args.session]
    frames = [run(f, sessions) for f in futs]
    trades = pd.concat([f for f in frames if not f.empty], ignore_index=True)
    report(trades)
    out = DATA / "playbook_trades.csv"
    if not trades.empty:
        trades.to_csv(out, index=False)
        print(f"\nwrote {out}")
