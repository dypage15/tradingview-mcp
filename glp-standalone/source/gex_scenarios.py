"""Session expectations, measured rather than assumed.

gex_bias.py says what the gamma book looks like. This module says what actually
happened the last time it looked like that, using the table built by
research/scenario_study.py from a year of sessions across five futures.

Three findings shape everything here, and two of them are negative:

  Which side of the flip spot sits on predicts how WIDE a session runs. On ES,
  NQ and YM the negative-gamma median range is 1.3x to 1.6x the positive-gamma
  one, and it holds in Asia and London as well as RTH - overnight, arguably more
  cleanly, since the options book is frozen while dealers still hedge it in
  futures. On GC it does not hold at all, and on RTY the sample is too lopsided
  to tell.

  It does NOT predict which way. Comparing P(up) between regimes across fifteen
  future-session pairs turned up one flag, which is what fifteen coin flips at
  95% confidence produce on their own. There is no bullish or bearish read here
  and the module refuses to invent one.

  The flip is not a level price respects. When price touched the flip it closed
  back on the near side 44-53% of the time, statistically identical to a placebo
  level mirrored through the session open. It marks which regime you are in, not
  where price will turn.

So a scenario card gives you a width, not an arrow.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

CALIBRATION_FILE = "gex_calibration.json"

SESSIONS = ("asia", "london", "rth")
SESSION_LABEL = {
    "asia": "Asia 18:00-03:00 ET",
    "london": "London 03:00-09:30 ET",
    "rth": "RTH 09:30-16:00 ET",
}

# ETF whose options carry the gamma -> the future its levels are drawn on.
ETF_TO_FUTURE = {"SPY": "ES", "QQQ": "NQ", "IWM": "RTY", "DIA": "YM", "GLD": "GC"}

_CACHE: Optional[Dict[str, Any]] = None


def calibration_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), CALIBRATION_FILE)


def load_calibration(path: Optional[str] = None, refresh: bool = False) -> Dict[str, Any]:
    """Read the measured table. A missing file degrades to 'uncalibrated'."""
    global _CACHE
    if _CACHE is not None and not refresh and path is None:
        return _CACHE
    target = path or calibration_path()
    try:
        with open(target, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = {"sample": {}, "sessions": {}, "term": {}, "flip_reaction": {}}
    if path is None:
        _CACHE = data
    return data


def future_root(symbol: Optional[str]) -> Optional[str]:
    """Normalise 'NQ1!', 'nq=f', 'QQQ' or 'NQ' to the calibration's root."""
    if not symbol:
        return None
    s = str(symbol).strip().upper()
    if s in ETF_TO_FUTURE:
        return ETF_TO_FUTURE[s]
    for ch in ("1!", "=F", "!"):
        s = s.replace(ch, "")
    s = s.rstrip("0123456789")
    return s or None


@dataclass
class SessionExpectation:
    """How wide one session tends to run given the regime on the prior close."""

    session: str
    regime: str
    future: Optional[str]
    calibrated: bool = False
    n: int = 0
    quiet: Optional[float] = None       # p25, in price points
    typical: Optional[float] = None     # p50
    wide: Optional[float] = None        # p75
    widen_ratio: Optional[float] = None
    widen_established: bool = False
    # Median position of the session open inside the eventual high-low. Lets a
    # band be hung around spot the way the sample actually sat, instead of
    # assuming the open splits the range evenly.
    open_pos: Optional[float] = None
    reason: str = ""

    def band(self, anchor: float, span: Optional[float] = None):
        """(low, high) for a range hung around `anchor`. Defaults to typical."""
        width = self.typical if span is None else span
        if not self.calibrated or not width or anchor is None:
            return None
        pos = 0.5 if self.open_pos is None else min(max(self.open_pos, 0.15), 0.85)
        return (anchor - width * pos, anchor + width * (1.0 - pos))

    @property
    def label(self) -> str:
        return SESSION_LABEL.get(self.session, self.session)

    def line(self) -> str:
        if not self.calibrated:
            return f"{self.label}: not calibrated ({self.reason})"
        body = (f"{self.label}: typically {self.typical:,.0f} pts "
                f"(quiet {self.quiet:,.0f} / wide {self.wide:,.0f})")
        if self.widen_established and self.widen_ratio:
            body += f", {self.widen_ratio:.2f}x the other regime"
        return body

    def to_dict(self) -> Dict[str, Any]:
        return {
            "session": self.session, "label": self.label, "regime": self.regime,
            "future": self.future, "calibrated": self.calibrated, "n": self.n,
            "quiet": self.quiet, "typical": self.typical, "wide": self.wide,
            "widen_ratio": self.widen_ratio, "open_pos": self.open_pos,
            "widen_established": self.widen_established, "reason": self.reason,
        }


def expectation(
    future: Optional[str],
    session: str,
    regime: str,
    price: Optional[float],
    calib: Optional[Dict[str, Any]] = None,
) -> SessionExpectation:
    """Expected range for one session, in points at the given price."""
    root = future_root(future)
    exp = SessionExpectation(session=session, regime=regime, future=root)
    data = calib if calib is not None else load_calibration()

    if not price or price <= 0:
        exp.reason = "no reference price"
        return exp
    if root is None:
        exp.reason = "unknown symbol"
        return exp
    if session not in SESSIONS:
        # globex spans all three and 'visible' is whatever the chart shows, so
        # neither has a measured width to quote.
        exp.reason = f"{session} is not one of the measured sessions"
        return exp

    node = (data.get("sessions", {}).get(root, {}) or {}).get(session, {}) or {}
    cell = node.get(regime)
    if not cell:
        # Distinguish "we have no data for this market" from "this market was
        # measured and the regime did not matter there".
        if root not in data.get("sessions", {}):
            exp.reason = f"{root} is not in the calibration sample"
        else:
            exp.reason = f"too few {regime}-gamma sessions on {root}"
        return exp

    widen = node.get("widen_ratio") or {}
    if not widen.get("established"):
        exp.n = int(cell.get("n", 0))
        exp.widen_ratio = widen.get("est")
        # "We measured it and it was flat" and "we could not measure it" are
        # different answers. An interval sitting tight around 1.0 is the first.
        # A large point estimate whose interval still reaches 1.0 is the second,
        # and calling that no effect would overstate what the sample showed.
        est = widen.get("est")
        if est is not None and est >= 1.25:
            exp.reason = f"too few sessions on {root} to settle the regime effect"
        else:
            exp.reason = f"the regime did not change {root} range in the sample"
        return exp

    band = cell.get("range_bp", {})
    scale = float(price) / 1e4
    exp.calibrated = True
    exp.n = int(cell.get("n", 0))
    exp.quiet = float(band.get("p25", 0.0)) * scale
    exp.typical = float(band.get("p50", 0.0)) * scale
    exp.wide = float(band.get("p75", 0.0)) * scale
    exp.widen_ratio = widen.get("est")
    exp.widen_established = True
    exp.open_pos = cell.get("open_pos")
    return exp


@dataclass
class ScenarioCard:
    """The full 'what to expect' read for one symbol on one day."""

    future: Optional[str]
    regime: str
    price: Optional[float]
    flip: Optional[float] = None
    struct_flip: Optional[float] = None
    sessions: List[SessionExpectation] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    sample: Dict[str, Any] = field(default_factory=dict)

    @property
    def calibrated(self) -> bool:
        return any(s.calibrated for s in self.sessions)

    def lines(self) -> List[str]:
        out = [f"SESSION EXPECTATIONS ({self.future or 'unknown'}, "
               f"{self.regime} gamma)"]
        for s in self.sessions:
            out.append(f"  {s.line()}")
        for note in self.notes:
            out.append(f"  ! {note}")
        return out

    def to_dict(self) -> Dict[str, Any]:
        return {
            "future": self.future, "regime": self.regime, "price": self.price,
            "flip": self.flip, "struct_flip": self.struct_flip,
            "calibrated": self.calibrated,
            "sessions": [s.to_dict() for s in self.sessions],
            "notes": list(self.notes), "sample": dict(self.sample),
        }


def _flip_note(calib: Dict[str, Any]) -> Optional[str]:
    """State what the flip did as a level, in the sample's own numbers."""
    fr = calib.get("flip_reaction") or {}
    edges, holds = [], []
    for rec in fr.values():
        f, m = rec.get("flip_fut") or {}, rec.get("mirror_fut") or {}
        if f.get("hold_rate") is None or m.get("hold_rate") is None:
            continue
        holds.append(f["hold_rate"])
        edges.append(f["hold_rate"] - m["hold_rate"])
    if not edges:
        return None
    if max(abs(e) for e in edges) < 0.10:
        lo, hi = min(holds), max(holds)
        return (f"The flip is a regime boundary, not a support line. When price "
                f"reached it, it closed back on the near side {lo:.0%}-{hi:.0%} of "
                f"the time, no better than a placebo level the same distance away. "
                f"Trade the width it implies, not a bounce off it.")
    return None


def _term_note(calib: Dict[str, Any]) -> Optional[str]:
    """Whether the monthly flip earned its place, measured with near-dated fixed."""
    term = calib.get("term") or {}
    seen = 0
    for sess in SESSIONS:
        cells = term.get(sess) or {}
        if "++" in cells and "+-" in cells:
            seen += 1
    if seen < 2:
        return None
    return ("The monthly flip did not change the expected range once the "
            "near-dated sign was fixed, so treat it as context on how durable "
            "the regime is, not as an input to session width.")


def build_card(
    bias: Any,
    future: Optional[str] = None,
    price: Optional[float] = None,
    calib: Optional[Dict[str, Any]] = None,
) -> ScenarioCard:
    """Assemble the session outlook from a GammaBias.

    `bias` only needs .regime, .spot, .flip and .struct_flip, so this works
    equally on an underlying-scale bias or a futures-rescaled one.
    """
    data = calib if calib is not None else load_calibration()
    regime = getattr(bias, "regime", "transition")
    ref = price if price else getattr(bias, "spot", None)
    root = future_root(future)

    card = ScenarioCard(
        future=root, regime=regime, price=ref,
        flip=getattr(bias, "flip", None),
        struct_flip=getattr(bias, "struct_flip", None),
        sample=dict(data.get("sample", {})),
    )

    # Transition sits inside the noise band around the flip, where the regime
    # label is unstable. The calibration only has two buckets, so rather than
    # guess a side, quote both and say the read is unresolved.
    lookup = regime if regime in ("positive", "negative") else None
    for sess in SESSIONS:
        if lookup:
            card.sessions.append(expectation(root, sess, lookup, ref, data))
        else:
            wide = expectation(root, sess, "negative", ref, data)
            wide.reason = ("spot is on the flip; range could match either regime, "
                           "the wider of which is shown")
            wide.regime = "transition"
            card.sessions.append(wide)

    card.notes.append(
        "Gamma predicts how far a session travels, not which way. Across the "
        "sample the regime gave no directional edge, so nothing here is a "
        "bullish or bearish call.")
    note = _flip_note(data)
    if note:
        card.notes.append(note)
    note = _term_note(data)
    if note:
        card.notes.append(note)
    if not card.calibrated:
        reasons = sorted({s.reason for s in card.sessions if s.reason})
        why = reasons[0] if len(reasons) == 1 else "; ".join(reasons)
        card.notes.append(f"No session width is quoted here: {why}.")
    return card
