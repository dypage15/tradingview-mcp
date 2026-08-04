"""The expectation map: how far each session tends to travel from here.

This is the picture that goes with gex_scenarios.build_card. Three cones, one
per session, each sized from what actually happened on comparable days rather
than from a rule of thumb.

Two deliberate choices about what it does NOT draw. The cones are not tilted up
or down, because the regime showed no directional edge and a tilted cone would
imply one. And the flip is drawn as the boundary between two behaviours, shaded
rather than lined, because price respected it no better than a placebo level -
it tells you which regime you are in, not where to expect a bounce.

Cone geometry follows the measured position of the open inside the eventual
high-low, so a session whose open historically sat below mid-range gets more
room above than below.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from matplotlib.figure import Figure
from matplotlib.patches import Rectangle

try:
    from theme import THEME
except ImportError:  # standalone use outside the app package
    THEME = {
        "bg_panel": "#081008", "bg_surface": "#0b160b", "grid": "#132013",
        "text_primary": "#d8ffd8", "text_secondary": "#83be83",
        "text_muted": "#4f7a4f", "text_bright": "#ecffec",
        "green": "#66ff66", "red": "#ff2255", "yellow": "#d6ff3b",
        "purple": "#8dff70", "cyan": "#39ff14", "border": "#1d2b1d",
    }

CONE_WIDTH = 0.62
# Keep the cones legible when a level sits far away: levels beyond this many
# multiples of the widest cone are named in the margin instead of plotted.
VIEW_SLACK = 1.35

# Mirrors the palette in tv_cdp_draw so a level is the same colour here as it is
# on the chart. Defined locally rather than imported to keep this module free of
# the CDP client's dependencies.
LEVEL_COLOR = {
    "flip": "#B388FF",
    "monthly flip": "#7E57C2",
    "pin": "#FFD54F",
    "call wall": "#69F0AE",
    "support shelf": "#00E676",
    "air pocket": "#FF8A65",
}


def _regime_color(regime: str, theme: Dict[str, str]) -> str:
    if regime == "positive":
        return theme["green"]
    if regime == "negative":
        return theme["red"]
    return theme["yellow"]


def _cone_bounds(anchor: float, span: float, open_pos: Optional[float]):
    """Split a range around the anchor using where the open historically sat."""
    pos = 0.5 if open_pos is None else min(max(float(open_pos), 0.15), 0.85)
    return anchor - span * pos, anchor + span * (1.0 - pos)


def _declutter(values: List[float], gap: float) -> List[float]:
    """Nudge label positions apart while keeping their order.

    Two levels a few points apart would otherwise print on top of each other,
    which is common: the pin is frequently also the call wall.
    """
    order = sorted(range(len(values)), key=lambda i: values[i])
    out = list(values)
    prev = None
    for i in order:
        if prev is not None and out[i] - prev < gap:
            out[i] = prev + gap
        prev = out[i]
    return out


def render_scenario_map(
    card: Any,
    bias: Any = None,
    calibration: Optional[Dict[str, Any]] = None,
    fig: Optional[Figure] = None,
    theme: Optional[Dict[str, str]] = None,
    title: Optional[str] = None,
) -> Figure:
    """Draw the session expectation map onto a Figure and return it."""
    th = theme or THEME
    fig = fig or Figure(figsize=(11.0, 6.4), dpi=110)
    fig.clear()
    fig.patch.set_facecolor(th["bg_panel"])
    ax = fig.add_subplot(111)
    ax.set_facecolor(th["bg_surface"])
    for spine in ax.spines.values():
        spine.set_color(th["border"])

    data = card.to_dict() if hasattr(card, "to_dict") else dict(card)
    entries: List[Dict[str, Any]] = data.get("sessions", [])
    anchor = data.get("price")
    regime = data.get("regime", "transition")
    accent = _regime_color(regime, th)

    head = title or (f"{data.get('future') or 'symbol'}  -  {regime} gamma  -  "
                     f"what each session usually covers from {anchor:,.0f}"
                     if anchor else "session expectations")
    ax.set_title(head, color=th["text_bright"], fontsize=12, pad=14, loc="left")

    live = [e for e in entries if e.get("calibrated")]
    if not anchor or not live:
        ax.text(0.5, 0.55, "No measured expectation for this symbol",
                ha="center", va="center", color=th["text_primary"], fontsize=13,
                transform=ax.transAxes)
        why = next((e.get("reason") for e in entries if e.get("reason")), "")
        ax.text(0.5, 0.42, why, ha="center", va="center",
                color=th["text_muted"], fontsize=10, transform=ax.transAxes)
        ax.set_xticks([])
        ax.set_yticks([])
        return fig

    widest = max(e["wide"] for e in live)

    # --- cones -----------------------------------------------------------
    for i, entry in enumerate(entries):
        x = i
        if not entry.get("calibrated"):
            ax.text(x, anchor, entry.get("reason", "not calibrated"),
                    ha="center", va="center", color=th["text_muted"],
                    fontsize=8, rotation=90)
            continue
        op = entry.get("open_pos")
        for span, alpha, label in ((entry["wide"], 0.13, None),
                                   (entry["typical"], 0.30, None),
                                   (entry["quiet"], 0.42, None)):
            lo, hi = _cone_bounds(anchor, span, op)
            ax.add_patch(Rectangle(
                (x - CONE_WIDTH / 2, lo), CONE_WIDTH, hi - lo,
                facecolor=accent, alpha=alpha, edgecolor="none", zorder=2))
        lo, hi = _cone_bounds(anchor, entry["typical"], op)
        wlo, whi = _cone_bounds(anchor, entry["wide"], op)
        ax.add_patch(Rectangle(
            (x - CONE_WIDTH / 2, lo), CONE_WIDTH, hi - lo,
            facecolor="none", edgecolor=accent, linewidth=1.3, zorder=3))
        # Prices of the typical band go just inside the wide band, so they read
        # against the faint fill instead of the saturated one.
        ax.text(x, hi + (whi - hi) * 0.12, f"{hi:,.0f}", ha="center", va="bottom",
                color=th["text_primary"], fontsize=8.5, zorder=5)
        ax.text(x, lo - (lo - wlo) * 0.12, f"{lo:,.0f}", ha="center", va="top",
                color=th["text_primary"], fontsize=8.5, zorder=5)
        ax.text(x, whi + widest * 0.06, f"{entry['typical']:,.0f} pts typical",
                ha="center", va="bottom", color=th["text_bright"], fontsize=9.5)
        ax.text(x, wlo - widest * 0.06, f"n={entry['n']}",
                ha="center", va="top", color=th["text_muted"], fontsize=8)

    # --- anchor and levels ------------------------------------------------
    ax.axhline(anchor, color=th["text_bright"], linewidth=1.2, zorder=4)
    ax.text(-0.62, anchor, f"now {anchor:,.0f}", ha="left", va="bottom",
            color=th["text_bright"], fontsize=9)

    top = anchor + widest * VIEW_SLACK
    bottom = anchor - widest * VIEW_SLACK

    wanted = [("flip", data.get("flip"), (0, (6, 3)), 1.5)]
    if data.get("struct_flip") is not None:
        wanted.append(("monthly flip", data["struct_flip"], (0, (2, 4)), 1.0))
    if bias is not None:
        wanted += [
            ("pin", getattr(bias, "pin", None), (0, (5, 3)), 1.2),
            ("call wall", getattr(bias, "call_wall", None), "solid", 1.2),
            ("air pocket", getattr(bias, "air_pocket", None), (0, (1, 3)), 1.2),
        ]

    onscreen, offscreen = [], []
    for label, value, style, width in wanted:
        if value is None:
            continue
        if bottom < value < top:
            onscreen.append((label, float(value), style, width))
        else:
            offscreen.append(f"{label} {value:,.0f} ({value - anchor:+,.0f})")

    flip = data.get("flip")
    if flip is not None and bottom < flip < top:
        # Shade the far side of the flip rather than drawing it as support: it
        # separates two behaviours, it does not turn price.
        if flip < anchor:
            ax.axhspan(bottom, flip, color=LEVEL_COLOR["flip"], alpha=0.06, zorder=1)
            side = "negative gamma below"
        else:
            ax.axhspan(flip, top, color=LEVEL_COLOR["flip"], alpha=0.06, zorder=1)
            side = "positive gamma above"
        ax.text(-0.72, flip, side, ha="left", va="bottom",
                color=LEVEL_COLOR["flip"], fontsize=8.5)

    for label, value, style, width in onscreen:
        ax.axhline(value, color=LEVEL_COLOR.get(label, th["text_secondary"]),
                   linewidth=width, linestyle=style, alpha=0.85, zorder=4)

    gutter_x = len(entries) - 0.32
    placed = _declutter([v for _, v, _, _ in onscreen], (top - bottom) * 0.052)
    for (label, value, _s, _w), y in zip(onscreen, placed):
        color = LEVEL_COLOR.get(label, th["text_secondary"])
        ax.annotate(f"{label} {value:,.0f}", xy=(gutter_x, value),
                    xytext=(gutter_x + 0.10, y), color=color, fontsize=8.5,
                    va="center", ha="left", annotation_clip=False,
                    arrowprops=dict(arrowstyle="-", color=color, alpha=0.45,
                                    linewidth=0.7, shrinkA=0, shrinkB=2))

    if offscreen:
        ax.text(0.995, 0.015, "beyond a typical session:  " + "   ".join(offscreen),
                transform=ax.transAxes, ha="right", va="bottom",
                color=th["text_muted"], fontsize=8)

    # --- frame ------------------------------------------------------------
    ax.set_xlim(-0.75, len(entries) - 0.25)
    ax.set_ylim(bottom, top)
    ax.set_xticks(range(len(entries)))
    ax.set_xticklabels([e["label"].split(" ")[0] for e in entries],
                       color=th["text_primary"], fontsize=10)
    ax.tick_params(axis="y", colors=th["text_secondary"], labelsize=8)
    ax.grid(axis="y", color=th["grid"], linewidth=0.6, alpha=0.6)
    ax.set_axisbelow(True)

    sub = ("shaded bands: inner = quiet quarter, middle = typical, outer = wide "
           "quarter   |   cones are symmetric on purpose: no directional edge "
           "was measured")
    fig.text(0.012, 0.015, sub, color=th["text_muted"], fontsize=8)
    fig.subplots_adjust(left=0.075, right=0.87, top=0.90, bottom=0.11)
    return fig


def save_scenario_map(card: Any, path: str, bias: Any = None,
                      calibration: Optional[Dict[str, Any]] = None,
                      **kwargs) -> str:
    fig = render_scenario_map(card, bias=bias, calibration=calibration, **kwargs)
    directory = os.path.dirname(os.path.abspath(path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    fig.savefig(path, facecolor=fig.get_facecolor(), dpi=fig.get_dpi())
    return path
