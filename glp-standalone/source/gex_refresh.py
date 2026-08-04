"""How often GLP levels should update intraday.

The options book and the chart do not move on the same clock:

  Open interest (what pin/walls are built from) settles overnight. Refetching
  every minute mostly re-prices the same strikes at a new spot; the magnets
  barely move until the next OI print.

  Spot versus the flip DOES change continuously. Crossing the flip is a regime
  change even if every strike's gamma is unchanged.

  The futures conversion ratio drifts as cash and futures diverge. That is a
  chart-alignment problem, not a gamma problem, and wants a faster loop.

So the right answer is three clocks, not one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

# Full Unusual Whales pull: rebuild pin, walls, flip from the chain.
# Faster than this mostly burns rate limit on a frozen OI book.
CHAIN_REFRESH_MIN = 15
CHAIN_REFRESH_MAX = 30

# Re-check spot vs flip / redraw conversion. Cheap; no new chain needed.
REGIME_CHECK_SEC = 60

# Live futures ratio so drawn NQ/ES levels stay on the print.
RATIO_REFRESH_SEC = 30

# Force a chain refresh around these session landmarks (ET, 24h clock).
SESSION_ANCHORS_ET = (
    (9, 25),   # just before RTH: lock the day book
    (12, 0),   # midday: catch any notable OI/spot drift
    (15, 0),   # into the last hour: 0DTE mass matters most here
)


@dataclass
class RefreshPlan:
    chain_minutes: int = 20
    regime_seconds: int = REGIME_CHECK_SEC
    ratio_seconds: int = RATIO_REFRESH_SEC
    redraw_on_regime_flip: bool = True
    redraw_on_session_roll: bool = True

    def summary_lines(self) -> list[str]:
        return [
            "LEVEL REFRESH POLICY",
            f"  Chain / pin / walls: every {self.chain_minutes} min "
            f"(OI is overnight; faster adds little)",
            f"  Spot vs flip (regime): every {self.regime_seconds}s — redraw if it crosses",
            f"  Futures conversion ratio: every {self.ratio_seconds}s while live-anchored",
            "  Session anchors (ET): 09:25, 12:00, 15:00 — force a full chain pull",
            "  Do not treat intraday refetches as a new book; treat them as re-pricing "
            "yesterday's OI at today's spot.",
        ]


DEFAULT_PLAN = RefreshPlan()


def should_force_chain_pull(hour: int, minute: int,
                            last_anchor: Optional[tuple] = None) -> bool:
    """True when we just crossed a session anchor and have not fired it yet."""
    for ah, am in SESSION_ANCHORS_ET:
        if (hour, minute) >= (ah, am):
            tag = (ah, am)
            if last_anchor != tag and (hour, minute) < (ah, am + 5):
                return True
    return False
