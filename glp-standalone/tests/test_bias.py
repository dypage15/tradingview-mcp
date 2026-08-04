"""Tests for the gamma regime classification and the regime-conditional plan."""
import os
import re
import sys

import pytest

SOURCE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "source")
if SOURCE not in sys.path:
    sys.path.insert(0, SOURCE)

from gex_bias import (  # noqa: E402
    REGIME_NEGATIVE,
    REGIME_POSITIVE,
    REGIME_TRANSITION,
    TERM_ALIGNED,
    TERM_FRAGILE,
    TERM_RECOVERING,
    TERM_UNKNOWN,
    classify_term_structure,
    compute_bias,
)
from tv_cdp_draw import GLP_TEXT_PATTERN, build_action_draw_plan  # noqa: E402


def _levels(spot, flip, pos, neg, **extra):
    base = {
        "underlying": "QQQ",
        "label_symbol": "QQQ",
        "tv_symbol": "QQQ",
        "spot": spot,
        "flip": flip,
        "pos": pos,
        "neg": neg,
        "zones": [],
    }
    base.update(extra)
    return base


POS = [
    {"price": 700.0, "gex_bn": 1.40},
    {"price": 705.0, "gex_bn": 0.60},
    {"price": 710.0, "gex_bn": 0.35},
]
NEG = [
    {"price": 690.0, "gex_bn": -0.50},
    {"price": 680.0, "gex_bn": -0.30},
]


class TestRegime:
    def test_spot_well_above_flip_is_positive_gamma(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=680.0)
        assert bias.regime == REGIME_POSITIVE

    def test_spot_well_below_flip_is_negative_gamma(self):
        bias = compute_bias(spot=670.0, positives=POS, negatives=NEG, flip=690.0)
        assert bias.regime == REGIME_NEGATIVE

    def test_spot_on_the_flip_is_transition(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=699.5)
        assert bias.regime == REGIME_TRANSITION
        assert bias.confidence == "low"

    def test_missing_flip_is_transition_not_a_crash(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=None)
        assert bias.regime == REGIME_TRANSITION

    def test_regime_uses_the_flip_directly(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=690.0)
        assert bias.flip == 690.0


class TestTermStructure:
    def test_both_flips_below_spot_is_aligned(self):
        assert classify_term_structure(700.0, 690.0, 685.0, "weekly") == TERM_ALIGNED

    def test_both_flips_above_spot_is_aligned(self):
        assert classify_term_structure(680.0, 690.0, 695.0, "weekly") == TERM_ALIGNED

    def test_above_near_but_below_monthly_is_fragile(self):
        assert classify_term_structure(700.0, 690.0, 710.0, "weekly") == TERM_FRAGILE

    def test_below_near_but_above_monthly_is_recovering(self):
        assert classify_term_structure(700.0, 710.0, 690.0, "weekly") == TERM_RECOVERING

    def test_all_horizon_is_unknown(self):
        # On the all horizon the monthly frame is never built, so the monthly
        # flip is a copy of the near-dated one and agreement is meaningless.
        assert classify_term_structure(700.0, 690.0, 710.0, "all") == TERM_UNKNOWN

    def test_degenerate_monthly_flip_is_unknown(self):
        assert classify_term_structure(700.0, 690.0, 690.0, "weekly") == TERM_UNKNOWN

    def test_missing_monthly_flip_is_unknown(self):
        assert classify_term_structure(700.0, 690.0, None, "weekly") == TERM_UNKNOWN

    def test_fragile_caps_confidence_at_medium(self):
        strong = dict(spot=700.0, positives=POS, negatives=NEG, flip=650.0)
        aligned = compute_bias(**strong, struct_flip=645.0)
        fragile = compute_bias(**strong, struct_flip=720.0)
        assert aligned.term_structure == TERM_ALIGNED
        assert aligned.confidence == "high"
        assert fragile.term_structure == TERM_FRAGILE
        assert fragile.confidence == "medium"

    def test_fragile_state_is_explained_in_the_playbook(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=650.0, struct_flip=720.0)
        assert any("fragile" in step.lower() and "720" in step for step in bias.playbook)

    def test_recovering_state_is_explained_in_the_playbook(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=740.0, struct_flip=650.0)
        assert bias.term_structure == TERM_RECOVERING
        assert any("650" in step for step in bias.playbook)

    def test_all_horizon_stays_silent_about_term_structure(self):
        bias = compute_bias(
            spot=700.0, positives=POS, negatives=NEG, flip=650.0, struct_flip=720.0, horizon="all"
        )
        assert bias.term_structure == TERM_UNKNOWN
        assert not any("fragile" in step.lower() for step in bias.playbook)

    def test_sluggish_pin_caveat_uses_measured_tenor_split(self):
        bias = compute_bias(
            spot=700.0, positives=POS, negatives=NEG, flip=650.0, struct_flip=645.0,
            near_bn=0.40, struct_bn=-3.10,
        )
        assert any("sluggish" in note for note in bias.caveats)

    def test_boilerplate_pin_caveat_when_tenor_split_is_unusable(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=650.0, horizon="all")
        assert any("Pinning needs near-dated gamma" in note for note in bias.caveats)
        assert not any("sluggish" in note for note in bias.caveats)

    def test_rescale_regenerates_the_fragile_warning_in_futures_prices(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=650.0, struct_flip=720.0)
        fut = bias.rescale(41.3, tick=0.25)
        assert fut.term_structure == TERM_FRAGILE
        assert fut.struct_flip == pytest.approx(720.0 * 41.3, abs=0.25)
        fragile = [s for s in fut.playbook if "fragile" in s.lower()]
        assert fragile and "720" not in fragile[0]
        assert f"{fut.struct_flip:,.0f}" in fragile[0]


class TestWallsAndPin:
    def test_pin_is_largest_gamma_not_nearest_strike(self):
        # 705 is nearer to spot, but 700 carries far more gamma.
        bias = compute_bias(spot=704.0, positives=POS, negatives=NEG, flip=680.0)
        assert bias.pin == 700.0

    def test_call_wall_is_largest_positive_gamma_above_spot(self):
        bias = compute_bias(spot=701.0, positives=POS, negatives=NEG, flip=680.0)
        assert bias.call_wall == 705.0

    def test_support_is_positive_gamma_below_spot_not_negative(self):
        # The mechanism that makes a level hold is dealers being LONG gamma there.
        # A negative-gamma strike below spot accelerates a break; calling it
        # support puts you long into the fastest part of a decline.
        pos = POS + [{"price": 695.0, "gex_bn": 0.90}]
        bias = compute_bias(spot=700.0, positives=pos, negatives=NEG, flip=660.0)
        assert bias.put_wall == 695.0
        assert bias.put_wall_bn > 0

    def test_largest_negative_gamma_below_spot_is_an_air_pocket(self):
        pos = POS + [{"price": 695.0, "gex_bn": 0.90}]
        bias = compute_bias(spot=700.0, positives=pos, negatives=NEG, flip=660.0)
        assert bias.air_pocket == 690.0
        assert bias.air_pocket_bn < 0

    def test_air_pocket_is_never_described_as_support(self):
        pos = POS + [{"price": 695.0, "gex_bn": 0.90}]
        bias = compute_bias(spot=700.0, positives=pos, negatives=NEG, flip=660.0)
        pocket_notes = [s for s in bias.playbook if "690" in s]
        assert pocket_notes, "the air pocket should be called out"
        assert any("accelerat" in s for s in pocket_notes)
        assert not any("Buy flushes into" in s and "690" in s for s in bias.playbook)

    def test_thin_wall_is_flagged_weak(self):
        thin_pos = [{"price": 700.0, "gex_bn": 1.40}, {"price": 665.0, "gex_bn": 0.05}]
        bias = compute_bias(spot=690.0, positives=thin_pos, negatives=NEG, flip=660.0)
        assert bias.put_wall_weak is True

    def test_weak_wall_is_excluded_from_containment(self):
        thin_pos = [{"price": 700.0, "gex_bn": 1.40}, {"price": 665.0, "gex_bn": 0.05}]
        bias = compute_bias(spot=690.0, positives=thin_pos, negatives=NEG, flip=660.0)
        # Bounded by the flip below, never by the thin shelf at 665.
        assert bias.containment() == (660.0, 700.0)

    def test_shelf_equal_to_the_pin_does_not_collapse_containment(self):
        # Spot just above the pin makes the pin trivially the largest gamma below
        # it. Using that as the floor would report a band a few ticks wide.
        bias = compute_bias(spot=701.0, positives=POS, negatives=NEG, flip=680.0)
        assert bias.put_wall == 700.0 and bias.pin == 700.0
        assert bias.containment() == (680.0, 705.0)

    def test_real_shelf_becomes_the_containment_floor(self):
        pos = POS + [{"price": 695.0, "gex_bn": 0.90}]
        bias = compute_bias(spot=700.0, positives=pos, negatives=NEG, flip=660.0)
        # A live positive-gamma shelf is a nearer floor than the distant flip.
        assert bias.containment() == (695.0, 705.0)

    def test_containment_only_exists_in_positive_gamma(self):
        bias = compute_bias(spot=670.0, positives=POS, negatives=NEG, flip=690.0)
        assert bias.containment() is None


class TestDirection:
    def test_below_pin_in_positive_gamma_tilts_up(self):
        bias = compute_bias(spot=695.0, positives=POS, negatives=NEG, flip=680.0)
        assert bias.direction == "up"

    def test_above_pin_in_positive_gamma_tilts_down(self):
        bias = compute_bias(spot=708.0, positives=POS, negatives=NEG, flip=680.0)
        assert bias.direction == "down"

    def test_negative_gamma_makes_no_directional_claim(self):
        bias = compute_bias(spot=670.0, positives=POS, negatives=NEG, flip=690.0)
        assert bias.direction == "unknown"


class TestRescale:
    def test_levels_convert_and_narrative_follows(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=680.0)
        # 41.3 rather than 41.0: the latter maps 700 to 28,700, so the assertion
        # that the underlying price is gone would pass on a substring accident.
        fut = bias.rescale(41.3, tick=0.25)

        assert fut.pin == pytest.approx(700.0 * 41.3, abs=0.25)
        assert fut.regime == bias.regime
        # The prose must quote futures levels, never the underlying ones.
        assert "700" not in fut.headline
        assert all("680" not in step for step in fut.playbook)
        assert f"{fut.flip:,.0f}" in fut.invalidation

    def test_rescale_leaves_gamma_sizes_alone(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=680.0)
        fut = bias.rescale(41.3, tick=0.25)
        # gex_bn is a dollar gamma, not a price; scaling it would be meaningless.
        assert fut.pin_bn == bias.pin_bn


class TestPlanIsRegimeConditional:
    def test_positive_gamma_plan_fades_toward_the_pin(self):
        levels = _levels(700.0, 680.0, POS, NEG)
        plan = build_action_draw_plan(levels)
        assert plan.regime == REGIME_POSITIVE
        assert "POSITIVE GAMMA" in plan.plan_text
        assert "fade" in plan.plan_text
        labels = " ".join(l.label for l in plan.lines)
        assert "PIN" in labels and "FLIP" in labels

    def test_negative_gamma_plan_follows_the_break(self):
        levels = _levels(670.0, 690.0, POS, NEG)
        plan = build_action_draw_plan(levels)
        assert plan.regime == REGIME_NEGATIVE
        assert "NEGATIVE GAMMA" in plan.plan_text
        assert "do not fade" in plan.plan_text.lower()
        # The flip is the long trigger in this regime, not the invalidation.
        assert plan.long_level == 690.0
        # The short trigger is the negative-gamma air pocket, where hedging sells
        # into the break, not the nearest strike below.
        assert plan.short_level == 680.0

    def test_same_levels_opposite_sides_of_flip_give_opposite_plans(self):
        above = build_action_draw_plan(_levels(700.0, 680.0, POS, NEG))
        below = build_action_draw_plan(_levels(670.0, 690.0, POS, NEG))
        assert above.regime != below.regime
        assert above.plan_text != below.plan_text

    def test_flip_line_is_always_drawn(self):
        for spot, flip in ((700.0, 680.0), (670.0, 690.0), (700.0, 699.5)):
            plan = build_action_draw_plan(_levels(spot, flip, POS, NEG))
            assert any("FLIP" in l.label for l in plan.lines), f"no flip line at spot={spot}"

    def test_plan_consumes_a_supplied_bias(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=680.0)
        levels = _levels(700.0, 680.0, POS, NEG, bias=bias.to_dict())
        plan = build_action_draw_plan(levels)
        assert plan.regime == bias.regime
        assert plan.bias_headline == bias.headline

    def test_pin_that_is_also_the_call_wall_is_not_faded_into_itself(self):
        # Spot below the heaviest strike: it is both magnet and cap, so the plan
        # must not read "fade 705 -> 705".
        pos = [{"price": 705.0, "gex_bn": 1.40}, {"price": 715.0, "gex_bn": 0.20}]
        plan = build_action_draw_plan(_levels(700.0, 680.0, pos, NEG))
        assert "705 -> 705" not in plan.plan_text
        assert "cap" in plan.plan_text
        pin_lines = [l.label for l in plan.lines if "PIN" in l.label]
        assert pin_lines and "cap" in pin_lines[0]

    def test_struct_flip_line_is_drawn_when_the_tenors_are_comparable(self):
        levels = _levels(700.0, 690.0, POS, NEG, struct_flip=685.0, horizon="weekly")
        plan = build_action_draw_plan(levels)
        assert any("Struct flip" in l.label for l in plan.lines)

    def test_struct_flip_line_is_omitted_on_the_all_horizon(self):
        levels = _levels(700.0, 690.0, POS, NEG, struct_flip=685.0, horizon="all")
        plan = build_action_draw_plan(levels)
        assert not any("Struct flip" in l.label for l in plan.lines)

    def test_fragile_state_is_marked_on_the_plan_text(self):
        levels = _levels(700.0, 690.0, POS, NEG, struct_flip=712.0, horizon="weekly")
        plan = build_action_draw_plan(levels)
        assert "STRUCTURALLY FRAGILE" in plan.plan_text

    def test_plan_exposes_the_flip_under_its_own_name(self):
        plan = build_action_draw_plan(_levels(700.0, 680.0, POS, NEG))
        assert plan.flip_level == 680.0

    def test_purge_pattern_covers_every_label(self):
        # A label the purge regex misses is invisible on redraw and silently
        # stacks a duplicate on the chart every run, so check all three regimes.
        pattern = re.compile(GLP_TEXT_PATTERN.replace("\\\\", "\\"))
        cases = [
            _levels(700.0, 650.0, POS, NEG, struct_flip=720.0, horizon="weekly"),
            _levels(670.0, 700.0, POS, NEG, struct_flip=660.0, horizon="weekly"),
            _levels(700.0, 700.0, POS, NEG, horizon="weekly"),
        ]
        for levels in cases:
            plan = build_action_draw_plan(levels)
            texts = (
                [l.label for l in plan.lines]
                + [z.label for z in plan.zones]
                + [plan.plan_text]
            )
            for text in texts:
                assert pattern.match(text), f"purge regex misses {text!r}"

    def test_plan_survives_magnets_without_gamma_sizes(self):
        plan = build_action_draw_plan(_levels(700.0, 680.0, [{"price": 705.0}], [{"price": 690.0}]))
        assert plan.plan_text

    def test_magnets_that_duplicate_key_levels_are_not_drawn(self):
        # A +GEX sitting on the monthly flip used to print as a second line and
        # made Struct flip unreadable. Key levels win; twin magnets are dropped.
        pos = [
            {"price": 720.0, "gex_bn": 1.5},  # coincides with struct flip
            {"price": 710.0, "gex_bn": 1.2},
            {"price": 730.0, "gex_bn": 0.9},
            {"price": 690.0, "gex_bn": 0.6},
        ]
        plan = build_action_draw_plan(
            _levels(700.0, 680.0, pos, NEG, struct_flip=720.0, horizon="weekly"),
            top_n_magnets=5,
        )
        labels = [l.label for l in plan.lines]
        assert any(l.startswith("Struct flip") for l in labels)
        assert "+GEX 720" not in labels
        assert any(l.startswith("+GEX 710") for l in labels)
        assert any(l.startswith("+GEX 730") for l in labels)

    def test_identical_near_and_monthly_flip_is_labeled_once(self):
        plan = build_action_draw_plan(
            _levels(700.0, 680.0, POS, NEG, struct_flip=680.0, horizon="all")
        )
        labels = [l.label for l in plan.lines]
        assert any("near=monthly" in l for l in labels)
        assert not any(l.startswith("Struct flip") for l in labels)

    def test_conversion_magnets_are_drawn_even_outside_the_plan_band(self):
        # Futures Conversion lists top magnets regardless of distance; the chart
        # must mirror that list (including far OTM strikes) with bn on the label.
        pos = [
            {"price": 705.0, "gex_bn": 1.0},
            {"price": 720.0, "gex_bn": 0.5},
            {"price": 780.0, "gex_bn": 0.4},  # ~11% away — still a conversion magnet
        ]
        neg = [
            {"price": 690.0, "gex_bn": -0.5},
            {"price": 660.0, "gex_bn": -0.3},
        ]
        plan = build_action_draw_plan(
            _levels(700.0, 680.0, pos, neg, zones=[690.0, 705.0]),
            top_n_magnets=5,
        )
        labels = [l.label for l in plan.lines]
        assert any("+GEX 720" in l for l in labels)
        assert any("+GEX 780" in l and "+0.40bn" in l for l in labels)
        # 690 is the air pocket / key level, so it is labeled as such rather than
        # a duplicate -GEX magnet.
        assert any("690" in l for l in labels)

    def test_weak_walls_still_draw(self):
        bias = compute_bias(spot=700.0, positives=POS, negatives=NEG, flip=680.0)
        payload = bias.to_dict()
        payload["call_wall_weak"] = True
        payload["put_wall_weak"] = True
        plan = build_action_draw_plan(
            _levels(700.0, 680.0, POS, NEG, bias=payload)
        )
        labels = " ".join(l.label for l in plan.lines)
        assert "Call wall" in labels and "(weak)" in labels
