"""Shared talk-track / advisor script for Discord Argos and the stream companion.

Educational framing only — what a senior reader would *watch*, never an order.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def _fmt(v: Any) -> str:
    if v is None:
        return "n/a"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if abs(f - round(f)) < 1e-6:
        return f"{f:,.0f}"
    return f"{f:,.2f}"


def build_talk_track(
    bias: Dict[str, Any],
    levels: Dict[str, Any],
    *,
    futures: str = "NQ",
    session: str = "rth",
    scenarios: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Return structured cues for overlays, Discord, and research logging."""
    bias = bias or {}
    levels = levels or {}
    regime = str(bias.get("regime") or "unknown")
    conf = str(bias.get("confidence") or "n/a")
    term = str(bias.get("term_structure") or "unknown")
    spot = _fmt(levels.get("spot") or bias.get("spot"))
    flip = _fmt(levels.get("flip") or bias.get("flip"))
    pin = _fmt(bias.get("pin"))
    cw = _fmt(bias.get("call_wall"))
    pw = _fmt(bias.get("put_wall"))
    air = _fmt(bias.get("air_pocket"))
    struct = _fmt(levels.get("struct_flip") or bias.get("struct_flip"))

    headline = str(bias.get("headline") or f"{futures} · {regime} gamma")
    behavior = str(bias.get("behavior") or "")

    # Short lines for lower-thirds / OBS (≤ ~90 chars when possible).
    lower_thirds: List[str] = [
        f"{futures} · {regime.upper()} gamma · conf {conf}",
        f"Spot {spot} · Flip {flip} · Pin {pin}",
        f"Call wall {cw} · Shelf {pw} · Air {air}",
    ]
    if term not in ("unknown", ""):
        lower_thirds.append(f"Term {term} · monthly {struct}")

    watch: List[str] = []
    if regime == "positive":
        watch.extend(
            [
                f"Magnet: is price damping toward pin {pin}?",
                f"At call wall {cw}: look for failed acceptance — not an auto short.",
                f"At shelf {pw}: bounce conditions only if shelf is not weak.",
                f"Invalidation: acceptance under flip {flip} ends the fade/pin read.",
                f"Air {air}: acceleration if tagged — not support.",
            ]
        )
        opener = (
            f"We're in positive gamma on {futures}. I'm reading for quieter travel — "
            f"pin {pin} as the reference, flip {flip} as the line that kills the pin thesis."
        )
    elif regime == "negative":
        watch.extend(
            [
                f"Below flip {flip}: do not fade blindly — expansion is the base case.",
                f"Air pocket {air}: mark as acceleration trigger on a loss.",
                f"Reclaim/hold of {flip}: condition that questions the unstable read.",
                f"Shelf {pw}: pause candidate only — not a guaranteed floor.",
                "Size down; yesterday's stops are often too tight here.",
            ]
        )
        opener = (
            f"Negative gamma on {futures}. I'm watching for wider travel — "
            f"flip {flip} as the regime line, air {air} as the acceleration pocket."
        )
    else:
        watch.extend(
            [
                f"Pivot: wait for acceptance away from flip {flip}.",
                "Lowest conviction — missing the first push beats inventing a lean.",
                f"Above {flip}: range/pin behavior; below: expansion risk.",
            ]
        )
        opener = (
            f"We're on the flip on {futures} at {flip}. I'm waiting for acceptance "
            "before leaning — this is the lowest-conviction state."
        )

    if term == "fragile":
        watch.append(f"Fragile vs monthly {struct}: pin is a day condition, not overnight faith.")
    elif term == "recovering":
        watch.append(f"Recovering vs monthly {struct}: reclaim of {flip} more believable.")

    if bias.get("call_wall_weak"):
        watch.append(f"Call wall {cw} is weak — do not lean on it as a hard cap.")
    if bias.get("put_wall_weak"):
        watch.append(f"Shelf {pw} is weak — less hedging support on dips.")

    # Teleprompter beats — speak these aloud on stream.
    beats: List[Dict[str, str]] = [
        {"role": "hook", "text": opener},
        {
            "role": "map",
            "text": (
                f"Map check: spot {spot}, flip {flip}, pin {pin}, "
                f"call wall {cw}, shelf {pw}, air {air}. Term structure: {term}."
            ),
        },
    ]
    if behavior:
        beats.append({"role": "behavior", "text": behavior})
    for i, w in enumerate(watch[:6], 1):
        beats.append({"role": f"watch_{i}", "text": w})

    session_note = ""
    if scenarios and scenarios.get("sessions"):
        for s in scenarios["sessions"]:
            if str(s.get("session") or "").lower() == session and s.get("calibrated"):
                session_note = (
                    f"{session.upper()} width: typical {_fmt(s.get('typical'))} pts "
                    f"(quiet {_fmt(s.get('quiet'))} / wide {_fmt(s.get('wide'))}) — "
                    "distance, not direction."
                )
                beats.append({"role": "session", "text": session_note})
                lower_thirds.append(
                    f"{session.upper()} typ {_fmt(s.get('typical'))} / wide {_fmt(s.get('wide'))}"
                )
                break

    beats.append(
        {
            "role": "process",
            "text": (
                "Process: risk first, wait for acceptance at the level, one clear "
                "invalidation, flat if the map changes. GEX is the map — not the trigger."
            ),
        }
    )
    beats.append(
        {
            "role": "disclaimer",
            "text": (
                "Educational only — not financial advice. This is what I would watch, "
                "not a recommendation to buy or sell."
            ),
        }
    )

    playbook = list(bias.get("playbook") or [])[:5]
    invalidation = str(bias.get("invalidation") or "")

    oneliner = (
        f"Regime {regime} | Term {term} | Pin {pin} | Flip {flip} | "
        f"Session {session} | {session_note or 'width n/a'}"
    )

    return {
        "futures": futures,
        "session": session,
        "regime": regime,
        "confidence": conf,
        "term_structure": term,
        "headline": headline,
        "behavior": behavior,
        "levels": {
            "spot": spot,
            "flip": flip,
            "struct_flip": struct,
            "pin": pin,
            "call_wall": cw,
            "put_wall": pw,
            "air_pocket": air,
        },
        "lower_thirds": lower_thirds,
        "watch": watch,
        "beats": beats,
        "playbook": playbook,
        "invalidation": invalidation,
        "session_note": session_note,
        "oneliner": oneliner,
        "disclaimer": (
            "Research & education only. Not financial advice. Not a trade recommendation."
        ),
    }


def beats_as_markdown(track: Dict[str, Any]) -> str:
    lines = [f"**Talk track — {track.get('futures')}**", ""]
    for b in track.get("beats") or []:
        lines.append(f"- ({b.get('role')}) {b.get('text')}")
    lines.append("")
    lines.append(f"_{track.get('disclaimer')}_")
    return "\n".join(lines)
