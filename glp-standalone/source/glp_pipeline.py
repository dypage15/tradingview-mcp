"""Headless GLP pipeline: fetch -> compute -> convert to futures -> draw.

Same sequence the desktop app runs, with no Tk dependency, so it can be driven
from a scheduler, a batch file, or another program.

    python glp_pipeline.py --underlying QQQ --horizon weekly --draw
    python glp_pipeline.py --underlying SPY --target underlying --json-out levels.json
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Optional

import requests

from tv_cdp_draw import (
    build_action_draw_plan,
    draw_converted_levels,
    format_session,
    health_check as tv_health_check,
    resolve_tv_symbol,
    session_window,
)
from discord_webhook import load_webhook_url, post_glp_snapshot
from gex_bias import GammaBias, bias_from_metrics
from gex_scenarios import build_card
from glp_license import check_license
from unusual_whales_gex import fetch_and_compute_uw, load_uw_api_key

FUTURES_CONVERSION_MAP = {
    "SPY": {"futures": "ES", "tick": 0.25},
    "SPX": {"futures": "ES", "tick": 0.25},
    "QQQ": {"futures": "NQ", "tick": 0.25},
    "NDX": {"futures": "NQ", "tick": 0.25},
    "GLD": {"futures": "GC", "tick": 0.1},
    "DIA": {"futures": "YM", "tick": 1.0},
    "IWM": {"futures": "RTY", "tick": 0.1},
}
YAHOO_FUTURES_SYMBOL = {
    "ES": "ES=F",
    "NQ": "NQ=F",
    "GC": "GC=F",
    "YM": "YM=F",
    "RTY": "RTY=F",
}
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
YAHOO_HEADERS = {"User-Agent": "GLP/12.6"}


class PipelineError(RuntimeError):
    pass


def round_to_tick(value: float, tick: float) -> float:
    if tick <= 0:
        return float(value)
    return round(round(float(value) / tick) * tick, 6)


def _yahoo_meta(symbol: str, interval: str, rng: str) -> Dict[str, Any]:
    resp = requests.get(
        YAHOO_CHART_URL.format(symbol=symbol),
        params={"interval": interval, "range": rng},
        timeout=15,
        headers=YAHOO_HEADERS,
    )
    resp.raise_for_status()
    result = ((resp.json().get("chart") or {}).get("result") or [None])[0]
    if not result:
        raise PipelineError(f"Yahoo returned no data for {symbol}")
    return result


def futures_last(fut_code: str) -> Optional[float]:
    """Live futures print, used for the live-anchored conversion ratio."""
    symbol = YAHOO_FUTURES_SYMBOL.get(fut_code.upper())
    if not symbol:
        return None
    try:
        meta = _yahoo_meta(symbol, "1m", "1d").get("meta") or {}
    except Exception:
        return None
    for key in ("regularMarketPrice", "previousClose", "chartPreviousClose"):
        if meta.get(key):
            return float(meta[key])
    return None


def futures_open(fut_code: str) -> Optional[float]:
    """Most recent daily open, used for the session-open anchored ratio."""
    symbol = YAHOO_FUTURES_SYMBOL.get(fut_code.upper())
    if not symbol:
        return None
    try:
        result = _yahoo_meta(symbol, "1d", "5d")
    except Exception:
        return None
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    opens = [o for o in (quote.get("open") or []) if o is not None]
    if opens:
        return float(opens[-1])
    meta = result.get("meta") or {}
    for key in ("regularMarketPrice", "previousClose"):
        if meta.get(key):
            return float(meta[key])
    return None


def _magnets(frame) -> List[Dict[str, float]]:
    out: List[Dict[str, float]] = []
    if frame is None:
        return out
    try:
        rows = list(frame.itertuples())
    except Exception:
        return out
    for row in rows:
        strike = getattr(row, "strike", None)
        if strike is None:
            continue
        item: Dict[str, float] = {"price": float(strike)}
        bn = getattr(row, "gex_bn", None)
        if bn is not None:
            item["gex_bn"] = float(bn)
        out.append(item)
    return out


def _zone_strikes(zones_obj) -> List[float]:
    if zones_obj is None:
        return []
    try:
        if hasattr(zones_obj, "empty"):
            if zones_obj.empty or "strike" not in zones_obj.columns:
                return []
            return [float(x) for x in zones_obj["strike"].dropna().tolist()]
        return [float(x) for x in list(zones_obj)]
    except Exception:
        return []


def build_levels(
    underlying: str,
    horizon: str = "weekly",
    target: str = "futures",
    anchor: str = "live",
    top_n: int = 7,
    api_key: Optional[str] = None,
    max_pages: int = 2,
) -> Dict[str, Any]:
    """Run the full pipeline and return a levels snapshot ready for drawing."""
    underlying = (underlying or "").strip().upper()
    key = api_key or load_uw_api_key()
    if not key:
        raise PipelineError(
            "No Unusual Whales API key. Set UNUSUAL_WHALES_API_KEY or run "
            "Launch-GLP.bat --set-key."
        )

    uw = fetch_and_compute_uw(
        api_key=key,
        underlying=underlying,
        spot=None,
        top_n=top_n,
        expiry_scope=horizon,
        max_pages=max_pages,
    )
    metrics = uw["metrics"]
    pressure = uw.get("pressure") or {}
    spot = float(metrics["spot"])

    und_levels = {
        "underlying": underlying,
        "label_symbol": underlying,
        "tv_symbol": underlying,
        "horizon": horizon,
        "spot": spot,
        "anchor_spot": spot,
        "flip": metrics.get("zero_gamma"),
        "struct_flip": pressure.get("mhp_level"),
        "zones": _zone_strikes(uw.get("liquidity_zones")),
        "pos": _magnets(metrics.get("top_positive")),
        "neg": _magnets(metrics.get("top_negative")),
    }

    # Built once on the underlying, where the full by-strike gamma frame is
    # available, then rescaled for the futures view.
    try:
        bias = bias_from_metrics(
            metrics,
            pressure,
            horizon=horizon,
            degraded=bool(getattr(uw.get("quality"), "degraded", False)),
        )
    except Exception:
        bias = None
    und_levels["bias"] = bias.to_dict() if bias is not None else None

    snapshot: Dict[str, Any] = {
        "underlying": underlying,
        "horizon": horizon,
        "target": target,
        "underlying_levels": und_levels,
        "futures_levels": None,
        "ratio": None,
        "anchor_mode": None,
    }

    if target == "underlying":
        snapshot["levels"] = und_levels
        return snapshot

    mapping = FUTURES_CONVERSION_MAP.get(underlying)
    if not mapping:
        supported = ", ".join(sorted(FUTURES_CONVERSION_MAP))
        raise PipelineError(f"No futures mapping for {underlying}. Supported: {supported}")

    fut_code = mapping["futures"]
    tick = float(mapping["tick"])

    ratio = None
    anchor_mode = anchor
    if anchor == "live":
        last = futures_last(fut_code)
        if last and spot:
            ratio = last / spot
    if ratio is None:
        # Session-open anchoring drifts intraday because the cash open and the
        # Globex open are hours apart; it is the fallback, not the default.
        fopen = futures_open(fut_code)
        if not fopen:
            raise PipelineError(f"Could not fetch a {fut_code} price from Yahoo to anchor the ratio.")
        ratio = fopen / spot
        anchor_mode = "session open"

    def conv(value):
        if value is None:
            return None
        try:
            return round_to_tick(float(value) * ratio, tick)
        except (TypeError, ValueError):
            return None

    fut_levels = {
        "underlying": underlying,
        "futures": fut_code,
        "label_symbol": fut_code,
        "tv_symbol": resolve_tv_symbol(fut_code),
        "horizon": horizon,
        "spot": conv(spot),
        "anchor_spot": conv(spot),
        "flip": conv(und_levels["flip"]),
        "struct_flip": conv(und_levels["struct_flip"]),
        "zones": [z for z in (conv(x) for x in und_levels["zones"]) if z is not None],
        # gex_bn rides along unconverted: it is a dollar gamma size, not a price,
        # so it must not be scaled by the futures ratio. Dropping it here would
        # leave the drawing layer ranking magnets by price instead of by size.
        "pos": [dict(m, price=conv(m["price"])) for m in und_levels["pos"] if conv(m["price"]) is not None],
        "neg": [dict(m, price=conv(m["price"])) for m in und_levels["neg"] if conv(m["price"]) is not None],
        "bias": bias.rescale(ratio, tick).to_dict() if bias is not None else None,
    }

    snapshot["futures"] = fut_code
    snapshot["futures_levels"] = fut_levels
    snapshot["ratio"] = float(ratio)
    snapshot["anchor_mode"] = anchor_mode
    snapshot["levels"] = fut_levels
    return snapshot


def run(
    underlying: str,
    horizon: str = "weekly",
    target: str = "futures",
    anchor: str = "live",
    top_n: int = 7,
    draw: bool = False,
    session: str = "rth",
    switch_symbol: bool = True,
) -> Dict[str, Any]:
    snapshot = build_levels(
        underlying, horizon=horizon, target=target, anchor=anchor, top_n=top_n
    )
    levels = snapshot["levels"]
    plan = build_action_draw_plan(levels, top_n_magnets=top_n, session_mode=session)

    snapshot["plan"] = {
        "text": plan.plan_text,
        "regime": plan.regime,
        "headline": plan.bias_headline,
        "confidence": plan.confidence,
        "long": plan.long_level,
        "short": plan.short_level,
        "flip": plan.flip_level,
        "lines": [{"label": l.label, "price": l.price} for l in plan.lines],
        "zones": [{"label": z.label, "low": z.low, "high": z.high} for z in plan.zones],
    }
    snapshot["bias"] = levels.get("bias")
    if session != "visible":
        start, end = session_window(session)
        snapshot["session"] = {"mode": session, "from": start, "to": end}

    bias_obj = levels.get("bias")
    if bias_obj:
        card = build_card(
            GammaBias(**{k: v for k, v in bias_obj.items()
                         if k in GammaBias.__dataclass_fields__}),
            future=snapshot.get("futures") or underlying,
            price=levels.get("spot"),
        )
        snapshot["scenarios"] = card.to_dict()

    if draw:
        health = tv_health_check()
        if not health.get("ok"):
            raise PipelineError(
                f"TradingView CDP not reachable on :9222 ({health.get('error')}). "
                "Start TradingView Desktop with remote debugging enabled."
            )
        snapshot["draw"] = draw_converted_levels(
            levels,
            switch_symbol=switch_symbol,
            clear_glp=True,
            top_n_magnets=top_n,
            session_mode=session,
        )
    return snapshot


def _print_human(snap: Dict[str, Any]) -> None:
    plan = snap["plan"]
    head = snap.get("futures") or snap["underlying"]
    print(f"{snap['underlying']} -> {head}  horizon={snap['horizon']}")
    if snap.get("ratio"):
        print(f"  ratio {snap['ratio']:.6f} ({snap['anchor_mode']} anchor)")

    bias = snap.get("bias")
    if bias:
        print()
        for line in GammaBias(**{k: v for k, v in bias.items()
                                 if k in GammaBias.__dataclass_fields__}).summary_lines():
            print(f"  {line}")
        print()

    print(f"  {plan['text']}")
    sess = snap.get("session")
    if sess:
        print(f"  session {sess['mode']} {format_session(sess['from'], sess['to'])}")
    for line in plan["lines"]:
        print(f"    line  {line['label']:<28} {line['price']:>12,.2f}")
    for zone in plan["zones"]:
        print(f"    zone  {zone['label']:<28} {zone['low']:>12,.2f} - {zone['high']:,.2f}")

    card = snap.get("scenarios")
    if card:
        print()
        for entry in card["sessions"]:
            if entry["calibrated"]:
                body = (f"typically {entry['typical']:,.0f} pts "
                        f"(quiet {entry['quiet']:,.0f} / wide {entry['wide']:,.0f}, "
                        f"n={entry['n']})")
            else:
                body = f"not calibrated ({entry['reason']})"
            print(f"    {entry['label']:<24} {body}")
        for note in card["notes"]:
            print(f"    ! {note}")
    drew = snap.get("draw")
    if drew:
        print(
            f"  drew {drew.get('drawn_count')} shapes on {drew.get('symbol')} "
            f"(purged {drew.get('purged_count')})"
        )
        for err in drew.get("errors") or []:
            print(f"    warn: {err}")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="glp_pipeline",
        description="Headless GLP: compute gamma levels, convert to futures, draw to TradingView.",
    )
    ap.add_argument("--underlying", "-u", default="QQQ", help="SPY, QQQ, SPX, NDX, GLD, DIA, IWM")
    ap.add_argument("--horizon", choices=["all", "weekly", "monthly"], default="weekly")
    ap.add_argument("--target", choices=["futures", "underlying"], default="futures")
    ap.add_argument(
        "--anchor",
        choices=["live", "open"],
        default="live",
        help="live = ratio from simultaneous prices (default); open = session-open ratio",
    )
    ap.add_argument("--session", choices=["rth", "globex", "asia", "london", "visible"],
                    default="rth")
    ap.add_argument("--top-n", type=int, default=7)
    ap.add_argument("--draw", action="store_true", help="Draw the plan onto TradingView Desktop")
    ap.add_argument("--no-switch-symbol", action="store_true", help="Do not change the chart symbol")
    ap.add_argument("--json-out", metavar="PATH", help="Write the full snapshot as JSON")
    ap.add_argument("--json", action="store_true", help="Print JSON to stdout instead of text")
    ap.add_argument(
        "--discord",
        nargs="?",
        const="env",
        metavar="WEBHOOK_URL",
        help="Post Action Center embed to Discord (URL or env GLP_DISCORD_WEBHOOK)",
    )
    args = ap.parse_args(argv)

    allowed, _lic, reason = check_license()
    if not allowed:
        print(f"ERROR: {reason}.", file=sys.stderr)
        print("Activate GLP by launching the desktop app, or set GLP_LICENSE.", file=sys.stderr)
        return 3

    try:
        snap = run(
            underlying=args.underlying,
            horizon=args.horizon,
            target=args.target,
            anchor="live" if args.anchor == "live" else "open",
            top_n=args.top_n,
            draw=args.draw,
            session=args.session,
            switch_symbol=not args.no_switch_symbol,
        )
    except PipelineError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(snap, fh, indent=2, default=str)
        print(f"wrote {args.json_out}")
    if args.json:
        print(json.dumps(snap, indent=2, default=str))
    else:
        _print_human(snap)

    if args.discord is not None:
        url = load_webhook_url(None if args.discord == "env" else args.discord)
        if not url:
            print("ERROR: no Discord webhook URL (pass --discord URL or set GLP_DISCORD_WEBHOOK).",
                  file=sys.stderr)
            return 4
        posted = post_glp_snapshot(url, snap, session=args.session)
        if posted.get("ok"):
            print("  posted Action Center summary to Discord")
        else:
            print(f"  Discord post failed: {posted.get('error') or posted.get('status')}",
                  file=sys.stderr)
            return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
