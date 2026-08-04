"""Daily gamma bias.

What this module claims, and what it deliberately does not:

GEX supports a strong inference about *how* a market will behave and a weak one
about *which way* it will go. The regime call - whether spot sits above or below
the gamma flip - is the load-bearing signal:

  Above the flip, dealers are net long gamma. Hedging that position means selling
  strength and buying weakness, which damps realized volatility. Ranges hold,
  breakouts tend to fail, and price is drawn toward the strike carrying the most
  positive gamma.

  Below the flip, dealers are net short gamma. Hedging then means selling
  weakness and buying strength, which amplifies moves. Ranges expand, breaks run,
  and the same headline produces a larger move than it would have a day earlier.

Note the asymmetry in what that buys you. "Positive gamma" is not bullish and
"negative gamma" is not bearish; they are statements about volatility, not
direction. The only honest directional content here is positional: in a pinning
regime price tends to converge on the pin, so being below it is a mild upward
tilt and above it a mild downward one. In a negative-gamma regime this module
returns no directional call at all, because the mechanism does not provide one -
it says the move will be fast and leaves the direction to price.

One distinction runs through everything below and is easy to get backwards. What
makes a strike act as support or resistance is the SIGN of dealer gamma there,
not which side of spot it sits on. A strike with large positive gamma resists
price from both directions, because dealers sell into it from below and buy into
it from above; those are the walls. A strike with large negative gamma does the
reverse and speeds price up as it passes through, which makes it an air pocket.
Reading a negative-gamma strike below spot as a floor - the conventional "put
wall" reading - inverts the mechanism and puts you on the wrong side of the
fastest part of a decline.

Every level is an estimate. Dealer positioning is inferred from a convention
(long calls, short puts) that is regularly wrong, and open interest is stale
intraday. Treat output as a description of the terrain, not a forecast.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

# Spot within this fraction of the flip counts as sitting on it, where the
# regime label is unreliable and can invert on a small move.
FLIP_NOISE_BAND = 0.0025

# Above this, the regime is far enough from the flip to be treated as settled.
FLIP_STRONG_BAND = 0.010

# Share of total positive gamma sitting on one strike for it to be a real pin.
PIN_CONCENTRATION_STRONG = 0.25
PIN_CONCENTRATION_WEAK = 0.12

# A wall must carry at least this share of the pin's gamma to be treated as one.
WALL_SIGNIFICANCE = 0.20

REGIME_POSITIVE = "positive"
REGIME_NEGATIVE = "negative"
REGIME_TRANSITION = "transition"

# Agreement between the near-dated flip and the monthly one. The near-dated flip
# governs today's hedging, but a regime it does not share with the structural
# book is a day-trade condition rather than a durable state.
TERM_ALIGNED = "aligned"
TERM_FRAGILE = "fragile"
TERM_RECOVERING = "recovering"
TERM_UNKNOWN = "unknown"


@dataclass
class GammaBias:
    regime: str
    headline: str
    direction: str  # "up" | "down" | "neutral" | "unknown"
    confidence: str  # "high" | "medium" | "low"
    spot: Optional[float] = None
    flip: Optional[float] = None
    # Monthly-bucket flip. Compared against the near-dated flip to judge whether
    # the regime is confirmed across tenors.
    struct_flip: Optional[float] = None
    term_structure: str = TERM_UNKNOWN
    near_bn: Optional[float] = None
    struct_bn: Optional[float] = None
    pin: Optional[float] = None
    pin_bn: Optional[float] = None
    pin_concentration: Optional[float] = None
    call_wall: Optional[float] = None
    call_wall_bn: Optional[float] = None
    call_wall_weak: bool = False
    put_wall: Optional[float] = None
    put_wall_bn: Optional[float] = None
    put_wall_weak: bool = False
    # Largest negative-gamma strike below spot: where a break speeds up, not slows.
    air_pocket: Optional[float] = None
    air_pocket_bn: Optional[float] = None
    total_bn: Optional[float] = None
    flip_distance_pct: Optional[float] = None
    behavior: str = ""
    playbook: List[str] = field(default_factory=list)
    invalidation: str = ""
    # Split so rescale() can regenerate the price-bearing notes in futures terms
    # while carrying the price-free ones across unchanged.
    structural_caveats: List[str] = field(default_factory=list)
    static_caveats: List[str] = field(default_factory=list)
    call_wall_ratio: Optional[float] = None
    put_wall_ratio: Optional[float] = None
    horizon: str = "weekly"

    @property
    def caveats(self) -> List[str]:
        return list(self.structural_caveats) + list(self.static_caveats)

    @property
    def is_pinning(self) -> bool:
        return self.regime == REGIME_POSITIVE

    def containment(self) -> Optional[tuple]:
        """Band the regime is likely to hold price inside.

        Only meaningful while gamma is positive, and bounded below by the flip
        rather than the put wall: the flip is where the regime itself breaks,
        whereas the put wall usually sits far below and marks where negative
        gamma concentrates once it has already broken.
        """
        if self.regime != REGIME_POSITIVE:
            return None
        if self.flip is None or self.call_wall is None or self.call_wall_weak:
            return None
        # A real positive-gamma shelf is a nearer and more active floor than the
        # flip, so prefer it when one exists above the flip. The pin is excluded:
        # when spot sits just above the pin the pin is trivially the largest
        # gamma below, and using it would collapse the band to a few ticks.
        low = self.flip
        if (
            self.put_wall is not None
            and not self.put_wall_weak
            and self.put_wall > self.flip
            and not same_level(self.put_wall, self.pin)
        ):
            low = self.put_wall
        lo, hi = sorted((low, self.call_wall))
        return (lo, hi)

    def rescale(self, ratio: float, tick: float = 0.0) -> "GammaBias":
        """The same read expressed in futures prices.

        The narrative is regenerated rather than copied. Every playbook line
        quotes levels, so carrying the strings across a scale change would leave
        the tool telling you to fade 703 on a chart trading at 28,900.
        """

        def conv(value):
            if value is None:
                return None
            out = float(value) * float(ratio)
            if tick and tick > 0:
                out = round(round(out / tick) * tick, 6)
            return out

        spot, flip = conv(self.spot), conv(self.flip)
        pin, call_wall, put_wall = conv(self.pin), conv(self.call_wall), conv(self.put_wall)
        air_pocket = conv(self.air_pocket)
        struct_flip = conv(self.struct_flip)

        headline, direction, behavior, playbook, invalidation, structural = _narrate(
            regime=self.regime,
            spot=spot,
            flip=flip,
            pin=pin,
            call_wall=call_wall,
            call_wall_weak=self.call_wall_weak,
            call_wall_ratio=self.call_wall_ratio,
            put_wall=put_wall,
            put_wall_weak=self.put_wall_weak,
            put_wall_ratio=self.put_wall_ratio,
            air_pocket=air_pocket,
            term_structure=self.term_structure,
            struct_flip=struct_flip,
        )

        return GammaBias(
            regime=self.regime,
            headline=headline,
            direction=direction,
            confidence=self.confidence,
            spot=spot,
            flip=flip,
            struct_flip=struct_flip,
            term_structure=self.term_structure,
            near_bn=self.near_bn,
            struct_bn=self.struct_bn,
            pin=pin,
            pin_bn=self.pin_bn,
            pin_concentration=self.pin_concentration,
            call_wall=call_wall,
            call_wall_bn=self.call_wall_bn,
            call_wall_weak=self.call_wall_weak,
            call_wall_ratio=self.call_wall_ratio,
            put_wall=put_wall,
            put_wall_bn=self.put_wall_bn,
            put_wall_weak=self.put_wall_weak,
            put_wall_ratio=self.put_wall_ratio,
            air_pocket=air_pocket,
            air_pocket_bn=self.air_pocket_bn,
            total_bn=self.total_bn,
            flip_distance_pct=self.flip_distance_pct,
            behavior=behavior,
            playbook=playbook,
            invalidation=invalidation,
            structural_caveats=structural,
            static_caveats=list(self.static_caveats),
            horizon=self.horizon,
        )

    def to_dict(self) -> Dict[str, Any]:
        data = {
            "regime": self.regime,
            "headline": self.headline,
            "direction": self.direction,
            "confidence": self.confidence,
            "spot": self.spot,
            "flip": self.flip,
            "struct_flip": self.struct_flip,
            "term_structure": self.term_structure,
            "near_bn": self.near_bn,
            "struct_bn": self.struct_bn,
            "pin": self.pin,
            "pin_bn": self.pin_bn,
            "pin_concentration": self.pin_concentration,
            "call_wall": self.call_wall,
            "call_wall_bn": self.call_wall_bn,
            "call_wall_weak": self.call_wall_weak,
            "put_wall": self.put_wall,
            "put_wall_bn": self.put_wall_bn,
            "put_wall_weak": self.put_wall_weak,
            "air_pocket": self.air_pocket,
            "air_pocket_bn": self.air_pocket_bn,
            "total_bn": self.total_bn,
            "flip_distance_pct": self.flip_distance_pct,
            "behavior": self.behavior,
            "playbook": list(self.playbook),
            "invalidation": self.invalidation,
            "caveats": list(self.caveats),
            "structural_caveats": list(self.structural_caveats),
            "static_caveats": list(self.static_caveats),
            "call_wall_ratio": self.call_wall_ratio,
            "put_wall_ratio": self.put_wall_ratio,
            "horizon": self.horizon,
        }
        band = self.containment()
        if band:
            data["containment_low"], data["containment_high"] = band
        return data

    def summary_lines(self) -> List[str]:
        def px(v):
            return "n/a" if v is None else (f"{v:,.0f}" if abs(v - round(v)) < 1e-6 else f"{v:,.2f}")

        out = [f"BIAS: {self.headline}  [confidence: {self.confidence}]"]
        dist = "" if self.flip_distance_pct is None else f" ({self.flip_distance_pct:+.2%} from flip)"
        out.append(f"  Regime      {self.regime} gamma{dist}")
        if self.term_structure != TERM_UNKNOWN:
            tenor = f"  Term        {self.term_structure} (monthly flip {px(self.struct_flip)})"
            if self.near_bn is not None and self.struct_bn is not None:
                tenor += f"   near {self.near_bn:+.2f}bn / monthly {self.struct_bn:+.2f}bn"
            out.append(tenor)
        out.append(f"  Spot {px(self.spot)}   Flip {px(self.flip)}   Pin {px(self.pin)}")
        cw = px(self.call_wall) + (" (weak)" if self.call_wall_weak else "")
        pw = px(self.put_wall) + (" (weak)" if self.put_wall_weak else "")
        out.append(f"  Call wall {cw} (+GEX ceiling)   Support shelf {pw} (+GEX floor)")
        if self.air_pocket is not None:
            out.append(f"  Air pocket {px(self.air_pocket)} (-GEX: breaks accelerate here)")
        band = self.containment()
        if band:
            out.append(f"  Containment {px(band[0])} - {px(band[1])}")
        out.append(f"  Behavior    {self.behavior}")
        for step in self.playbook:
            out.append(f"    - {step}")
        if self.invalidation:
            out.append(f"  Invalidation {self.invalidation}")
        for note in self.caveats:
            out.append(f"  ! {note}")
        return out


def _pairs(items: Sequence[Any]) -> List[tuple]:
    """Normalize magnet lists into (price, gex_bn) pairs, tolerating missing size."""
    out = []
    for item in items or []:
        if isinstance(item, dict):
            price = item.get("price", item.get("strike"))
            bn = item.get("gex_bn")
        else:
            price, bn = item, None
        try:
            if price is None:
                continue
            out.append((float(price), None if bn is None else float(bn)))
        except (TypeError, ValueError):
            continue
    return out


def _fmt(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"{value:,.0f}" if abs(value - round(value)) < 1e-6 else f"{value:,.2f}"


def same_level(a: Optional[float], b: Optional[float]) -> bool:
    if a is None or b is None:
        return False
    return abs(a - b) <= max(1e-9, abs(b) * 1e-6)


def classify_term_structure(
    spot: Optional[float],
    flip: Optional[float],
    struct_flip: Optional[float],
    horizon: str = "weekly",
) -> str:
    """Compare the near-dated regime against the monthly one.

    Returns TERM_UNKNOWN rather than guessing whenever the comparison would be
    meaningless. On the 'all' horizon the monthly frame is never built, so the
    monthly flip silently falls back to the same value as the near-dated one;
    reading agreement off two copies of one number would manufacture confidence
    out of nothing.
    """
    if (horizon or "").strip().lower() == "all":
        return TERM_UNKNOWN
    if spot is None or flip is None or struct_flip is None:
        return TERM_UNKNOWN
    if same_level(struct_flip, flip):
        return TERM_UNKNOWN

    near_above = spot > flip
    struct_above = spot > struct_flip
    if near_above == struct_above:
        return TERM_ALIGNED
    return TERM_FRAGILE if near_above else TERM_RECOVERING


def _narrate(
    regime: str,
    spot: Optional[float],
    flip: Optional[float],
    pin: Optional[float],
    call_wall: Optional[float],
    call_wall_weak: bool,
    call_wall_ratio: Optional[float],
    put_wall: Optional[float],
    put_wall_weak: bool,
    put_wall_ratio: Optional[float],
    air_pocket: Optional[float] = None,
    term_structure: str = TERM_UNKNOWN,
    struct_flip: Optional[float] = None,
):
    """Turn a regime plus a set of levels into the human-facing read.

    Kept separate from compute_bias so the same wording can be regenerated at a
    different price scale without recomputing the underlying gamma.
    """
    playbook: List[str] = []
    caveats: List[str] = []

    if call_wall_weak and call_wall is not None:
        pct = f"{call_wall_ratio:.0%} of" if call_wall_ratio is not None else "very little of"
        caveats.append(
            f"Upside gamma is thin: the best call wall {_fmt(call_wall)} holds only {pct} "
            "the pin's gamma, so it is unlikely to cap price."
        )
    if put_wall_weak and put_wall is not None:
        pct = f"{put_wall_ratio:.0%} of" if put_wall_ratio is not None else "very little of"
        caveats.append(
            f"Downside support is thin: the best positive-gamma shelf {_fmt(put_wall)} holds only "
            f"{pct} the pin's gamma, so there is little dealer buying beneath the market."
        )

    if regime == REGIME_POSITIVE:
        behavior = "Volatility suppressed. Ranges hold, breakouts tend to fail, price gravitates to the pin."
        gap = None if (pin is None or not spot) else (pin - spot) / spot
        if gap is not None and abs(gap) >= 0.001:
            direction = "up" if gap > 0 else "down"
            headline = f"Pinned, drift {'up' if gap > 0 else 'down'} toward {_fmt(pin)}"
            playbook.append(
                f"Pin at {_fmt(pin)} is the magnet; spot is {abs(gap):.2%} "
                f"{'below' if gap > 0 else 'above'} it."
            )
        else:
            direction = "neutral"
            headline = f"Pinned at {_fmt(pin)}, expect chop"
            playbook.append(f"Spot is sitting on the pin at {_fmt(pin)}: expect two-sided chop, not trend.")

        if call_wall is not None and not call_wall_weak:
            if same_level(call_wall, pin):
                # The pin is also the heaviest strike above spot, so it is both the
                # magnet and the cap. "Fade it back to itself" would be nonsense.
                playbook.append(
                    f"The pin {_fmt(pin)} is also the largest gamma above spot: expect it to cap "
                    "rallies rather than give way."
                )
            else:
                playbook.append(f"Fade extensions into the call wall {_fmt(call_wall)} back toward the pin.")
        if put_wall is not None and not put_wall_weak:
            if same_level(put_wall, pin):
                playbook.append(
                    f"Dips into the pin {_fmt(pin)} are supported: it is also the largest positive "
                    "gamma below spot, so dealers buy weakness into it."
                )
            else:
                playbook.append(
                    f"Buy flushes into the positive-gamma shelf {_fmt(put_wall)} back toward the pin: "
                    "dealers buy weakness there."
                )
        else:
            playbook.append(
                f"No positive-gamma shelf below spot, so there is nothing cushioning a flush until "
                f"the flip {_fmt(flip)}. Buying dips has no hedging support behind it today."
            )
        if air_pocket is not None:
            playbook.append(
                f"{_fmt(air_pocket)} is an air pocket, not support: dealer gamma is negative there, "
                "so a break through it accelerates rather than stalls."
            )
        playbook.append("Do not chase breakouts: in this regime dealer hedging sells strength and buys weakness.")
        invalidation = f"Acceptance below the flip {_fmt(flip)} ends the pinning regime; stop fading and reassess."

    elif regime == REGIME_NEGATIVE:
        behavior = "Volatility amplified. Moves extend, ranges expand, and the same news travels further."
        direction = "unknown"
        headline = "Unstable below flip, follow the break"
        playbook.append(
            f"Do not fade. Below the flip {_fmt(flip)} dealer hedging adds to the move rather than damping it."
        )
        if air_pocket is not None:
            playbook.append(
                f"Loss of {_fmt(air_pocket)} is the acceleration trigger: negative dealer gamma there "
                "means hedging sells into the break."
            )
        if put_wall is not None and not put_wall_weak:
            playbook.append(
                f"{_fmt(put_wall)} is the one shelf with positive gamma below spot and the most "
                "likely place for a decline to pause."
            )
        playbook.append(f"Reclaiming and holding {_fmt(flip)} is the signal that the regime has flipped back.")
        playbook.append("Size down: stops that were adequate yesterday are too tight in this regime.")
        invalidation = f"Sustained trade back above the flip {_fmt(flip)} invalidates the unstable read."
        caveats.append(
            "Negative gamma is a volatility call, not a direction call. This tool is not telling you to be short."
        )

    else:
        behavior = "Sitting on the flip. Hedging flow is near neutral and the regime can invert on a small move."
        direction = "neutral"
        headline = f"Fragile at the flip {_fmt(flip)}"
        playbook.append(f"Treat {_fmt(flip)} as the pivot: above it behaves like a range, below it like a trend.")
        playbook.append("Lowest-conviction state. Wait for acceptance on one side before committing.")
        invalidation = "Any decisive acceptance away from the flip resolves this state."

    # The two tenors disagreeing is worth saying out loud: it is the difference
    # between a regime you can lean on and one that only holds for the session.
    if term_structure == TERM_FRAGILE:
        playbook.append(
            f"Structurally fragile: spot is below the monthly flip {_fmt(struct_flip)} even though "
            "near-dated gamma is pinning. Treat the pin as a day-trade condition, not a floor to hold "
            "overnight."
        )
    elif term_structure == TERM_RECOVERING:
        playbook.append(
            f"Near-dated stress in a structurally calm book: spot is under the near-dated flip but "
            f"still above the monthly flip {_fmt(struct_flip)}. A reclaim of {_fmt(flip)} is more "
            "likely to stick than it would be with both tenors negative."
        )

    return headline, direction, behavior, playbook, invalidation, caveats


def compute_bias(
    spot: Optional[float],
    positives: Sequence[Any],
    negatives: Sequence[Any],
    flip: Optional[float] = None,
    struct_flip: Optional[float] = None,
    total_bn: Optional[float] = None,
    pin: Optional[float] = None,
    pin_bn: Optional[float] = None,
    positive_total_bn: Optional[float] = None,
    near_bn: Optional[float] = None,
    struct_bn: Optional[float] = None,
    horizon: str = "weekly",
    degraded: bool = False,
) -> GammaBias:
    """Classify the gamma regime and derive a daily bias.

    positives/negatives are magnet lists; each entry may carry gex_bn, which is
    what makes "biggest wall" meaningful rather than merely "nearest strike".
    """
    caveats: List[str] = []
    spot_f = None if spot is None else float(spot)
    flip_f = None if flip is None else float(flip)
    struct_flip_f = None if struct_flip is None else float(struct_flip)

    pos = sorted(_pairs(positives), key=lambda t: t[0])
    neg = sorted(_pairs(negatives), key=lambda t: t[0])

    def biggest(pairs, sign):
        sized = [p for p in pairs if p[1] is not None]
        if sized:
            return max(sized, key=lambda t: sign * t[1])
        return None

    # Pin: the single strike holding the most positive gamma.
    if pin is None:
        top = biggest(pos, +1)
        if top:
            pin, pin_bn = top[0], top[1]
        elif pos:
            # No sizes available; the nearest strike to spot is the best guess.
            pin = min(pos, key=lambda t: abs(t[0] - spot_f))[0] if spot_f else pos[0][0]
            caveats.append("Pin inferred from strike proximity: gamma sizes were not supplied.")

    concentration = None
    if pin_bn is not None and positive_total_bn:
        try:
            concentration = abs(float(pin_bn)) / abs(float(positive_total_bn))
        except ZeroDivisionError:
            concentration = None

    # Walls damp, air pockets accelerate, and the difference is the sign of the
    # gamma - not which side of spot the strike sits on.
    #
    # A strike carrying large POSITIVE gamma is one where dealers are long gamma:
    # they sell into it from below and buy into it from above, so it resists price
    # in both directions. Those are the walls.
    #
    # A strike carrying large NEGATIVE gamma is the opposite: dealers are short
    # gamma there and hedge with the move, so trading through it speeds price up.
    # That is an air pocket, and treating it as support is the most expensive
    # mistake available in this framework.
    call_wall = call_wall_bn = put_wall = put_wall_bn = None
    air_pocket = air_pocket_bn = None
    call_wall_weak = put_wall_weak = False
    if spot_f is not None:
        pos_above = [p for p in pos if p[0] > spot_f]
        pos_below = [p for p in pos if p[0] < spot_f]
        neg_below = [p for p in neg if p[0] < spot_f]

        top_above = biggest(pos_above, +1) or (pos_above[0] if pos_above else None)
        top_below = biggest(pos_below, +1) or (pos_below[-1] if pos_below else None)
        top_pocket = biggest(neg_below, -1) or (neg_below[-1] if neg_below else None)

        if top_above:
            call_wall, call_wall_bn = top_above
        if top_below:
            put_wall, put_wall_bn = top_below
        if top_pocket:
            air_pocket, air_pocket_bn = top_pocket

    # A wall only deserves the name if it carries real size next to the pin.
    # Without this the "largest strike on that side" of a thin book gets promoted
    # to a wall and produces an absurdly wide containment band.
    call_wall_ratio = put_wall_ratio = None
    ref = abs(float(pin_bn)) if pin_bn else None
    if ref:
        if call_wall_bn is not None:
            call_wall_ratio = abs(call_wall_bn) / ref
            call_wall_weak = call_wall_ratio < WALL_SIGNIFICANCE
        if put_wall_bn is not None:
            put_wall_ratio = abs(put_wall_bn) / ref
            put_wall_weak = put_wall_ratio < WALL_SIGNIFICANCE

    # --- Regime -----------------------------------------------------------
    dist = None
    if spot_f and flip_f:
        dist = (spot_f - flip_f) / spot_f

    if dist is None:
        regime = REGIME_TRANSITION
        caveats.append("No gamma flip level available; regime is unknown.")
    elif dist > FLIP_NOISE_BAND:
        regime = REGIME_POSITIVE
    elif dist < -FLIP_NOISE_BAND:
        regime = REGIME_NEGATIVE
    else:
        regime = REGIME_TRANSITION

    term = classify_term_structure(spot_f, flip_f, struct_flip_f, horizon)

    # --- Direction, behavior, playbook ------------------------------------
    headline, direction, behavior, playbook, invalidation, structural = _narrate(
        regime=regime,
        spot=spot_f,
        flip=flip_f,
        pin=pin,
        call_wall=call_wall,
        call_wall_weak=call_wall_weak,
        call_wall_ratio=call_wall_ratio,
        put_wall=put_wall,
        put_wall_weak=put_wall_weak,
        put_wall_ratio=put_wall_ratio,
        air_pocket=air_pocket,
        term_structure=term,
        struct_flip=struct_flip_f,
    )

    # --- Confidence -------------------------------------------------------
    score = 0
    if dist is not None:
        if abs(dist) >= FLIP_STRONG_BAND:
            score += 2
        elif abs(dist) > FLIP_NOISE_BAND:
            score += 1
    if concentration is not None:
        if concentration >= PIN_CONCENTRATION_STRONG:
            score += 1
        elif concentration < PIN_CONCENTRATION_WEAK:
            score -= 1
            caveats.append(
                f"Gamma is spread thin across strikes (pin holds {concentration:.0%} of positive gamma); "
                "the pin is weak."
            )
    if call_wall is not None and not call_wall_weak and put_wall is not None and not put_wall_weak:
        score += 1
    if term == TERM_ALIGNED:
        score += 1
    if degraded:
        score -= 2
        caveats.append("Data quality is degraded; treat every level as provisional.")

    confidence = "high" if score >= 3 else ("medium" if score >= 1 else "low")

    # Distance from the flip caps everything else. A tidy pin and clean walls do
    # not make a regime call trustworthy when a third of a percent of drift would
    # invert it, so a market still inside the strong band cannot grade "high".
    if dist is not None and abs(dist) < FLIP_STRONG_BAND and confidence == "high":
        confidence = "medium"
    # A regime the monthly book does not share is a condition for today, not a
    # state to lean on, however clean the near-dated picture looks.
    if term in (TERM_FRAGILE, TERM_RECOVERING) and confidence == "high":
        confidence = "medium"
    if regime == REGIME_TRANSITION:
        confidence = "low"

    if horizon == "all":
        caveats.append(
            "Horizon is 'all': levels blend near-dated and far-dated gamma and are less sharp intraday. "
            "Use the weekly horizon for a day trade."
        )

    caveats.append(
        "Dealer positioning is inferred from the long-calls/short-puts convention, not observed. "
        "If that assumption is wrong for this name, the regime call inverts."
    )
    caveats.append(
        "Open interest settles overnight, so this describes yesterday's book. Same-day expiry "
        "activity that never reaches the OI feed is invisible here."
    )
    caveats.append(
        "Gamma is measured on ETF options only. The index option pool is larger and has a "
        "different customer mix, so this is a minority of the true gamma."
    )
    if pin is not None:
        # Prefer a measured statement over the boilerplate when the tenor split is
        # trustworthy: hedging intensity per unit of gamma falls off with maturity,
        # so a book dominated by monthly gamma pins weakly.
        tenor_known = (
            term != TERM_UNKNOWN and near_bn is not None and struct_bn is not None
        )
        if tenor_known and abs(struct_bn) > abs(near_bn):
            caveats.append(
                f"Monthly gamma ({struct_bn:+.2f}bn) outweighs near-dated ({near_bn:+.2f}bn), so the "
                "pin is sluggish: it is a range reference today rather than an active magnet."
            )
        else:
            caveats.append(
                "Pinning needs near-dated gamma, spot within about one intraday sigma of the pin, and "
                "the last hours of the session. Away from those conditions the pin is a range "
                "reference rather than a magnet."
            )

    return GammaBias(
        regime=regime,
        headline=headline,
        direction=direction,
        confidence=confidence,
        spot=spot_f,
        flip=flip_f,
        struct_flip=struct_flip_f,
        term_structure=term,
        near_bn=None if near_bn is None else float(near_bn),
        struct_bn=None if struct_bn is None else float(struct_bn),
        pin=None if pin is None else float(pin),
        pin_bn=None if pin_bn is None else float(pin_bn),
        pin_concentration=concentration,
        call_wall=call_wall,
        call_wall_bn=call_wall_bn,
        call_wall_weak=call_wall_weak,
        put_wall=put_wall,
        put_wall_bn=put_wall_bn,
        put_wall_weak=put_wall_weak,
        air_pocket=air_pocket,
        air_pocket_bn=air_pocket_bn,
        total_bn=None if total_bn is None else float(total_bn),
        flip_distance_pct=dist,
        behavior=behavior,
        playbook=playbook,
        invalidation=invalidation,
        structural_caveats=structural,
        static_caveats=caveats,
        call_wall_ratio=call_wall_ratio,
        put_wall_ratio=put_wall_ratio,
        horizon=horizon,
    )


def bias_from_metrics(metrics: Dict[str, Any], pressure: Optional[Dict[str, Any]] = None,
                      horizon: str = "weekly", degraded: bool = False) -> GammaBias:
    """Build a bias straight from a compute_gex/UW metrics dict.

    Uses the full by_strike frame when present, so walls are chosen by gamma
    size across every strike rather than from a truncated top-N list.
    """
    pressure = pressure or {}
    spot = metrics.get("spot")

    positives: List[Dict[str, float]] = []
    negatives: List[Dict[str, float]] = []
    positive_total = None

    frame = metrics.get("by_strike")
    if frame is not None and getattr(frame, "empty", True) is False:
        try:
            for row in frame.itertuples():
                bn = float(getattr(row, "gex_bn"))
                entry = {"price": float(row.strike), "gex_bn": bn}
                (positives if bn >= 0 else negatives).append(entry)
            positive_total = sum(e["gex_bn"] for e in positives)
        except Exception:
            positives, negatives, positive_total = [], [], None

    if not positives and not negatives:
        def frame_to_items(f):
            out = []
            if f is None:
                return out
            try:
                for row in f.itertuples():
                    out.append({"price": float(row.strike), "gex_bn": float(getattr(row, "gex_bn", 0.0))})
            except Exception:
                return []
            return out

        positives = frame_to_items(metrics.get("top_positive"))
        negatives = frame_to_items(metrics.get("top_negative"))

    return compute_bias(
        spot=spot,
        positives=positives,
        negatives=negatives,
        flip=metrics.get("zero_gamma"),
        struct_flip=pressure.get("mhp_level"),
        total_bn=metrics.get("total_bn"),
        pin=metrics.get("max_strike"),
        pin_bn=metrics.get("max_bn"),
        positive_total_bn=positive_total,
        near_bn=pressure.get("daily_bn"),
        struct_bn=pressure.get("monthly_bn"),
        horizon=horizon,
        degraded=degraded,
    )
