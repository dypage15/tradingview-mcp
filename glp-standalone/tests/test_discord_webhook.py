"""Discord webhook embed builder — no network calls."""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "source"))

from discord_webhook import (  # noqa: E402
    build_embed,
    load_webhook_url,
    post_webhook,
)


def test_load_webhook_from_env(monkeypatch):
    monkeypatch.setenv("GLP_DISCORD_WEBHOOK", "https://discord.com/api/webhooks/1/abc")
    assert "webhooks/1/abc" in load_webhook_url()


def test_embed_uses_regime_color_and_key_levels():
    embed = build_embed(
        underlying="QQQ",
        futures="NQ",
        session="rth",
        bias={
            "regime": "positive",
            "headline": "Pinned at 28,915, expect chop",
            "confidence": "medium",
            "term_structure": "fragile",
            "direction": "neutral",
            "pin": 28914.75,
            "flip": 28388.0,
            "struct_flip": 28954.5,
            "call_wall": 28956.0,
            "put_wall": 28914.75,
            "air_pocket": 27262.5,
            "playbook": ["Do not chase breakouts", "Fade extensions into the call wall"],
            "invalidation": "Acceptance below the flip",
            "behavior": "Volatility suppressed.",
            "horizon": "weekly",
        },
        levels={
            "spot": 28929.25,
            "flip": 28388.0,
            "struct_flip": 28954.5,
            "pos": [{"price": 28914.75, "gex_bn": 2.7}],
            "neg": [{"price": 27262.5, "gex_bn": -0.6}],
            "horizon": "weekly",
        },
        scenarios={
            "sessions": [
                {"label": "Asia 18:00-03:00 ET", "calibrated": True,
                 "typical": 171, "quiet": 115, "wide": 257},
                {"label": "RTH 09:30-16:00 ET", "calibrated": False,
                 "reason": "n/a"},
            ]
        },
    )
    assert "NQ" in embed["title"]
    assert "POSITIVE" in embed["title"]
    assert embed["color"] == 0x66FF66
    blob = json_fields(embed)
    assert "28,914" in blob
    assert "fragile" in blob
    assert "Session expectations" in blob
    assert "not trading advice" in embed["footer"]["text"].lower()


def json_fields(embed):
    parts = [embed.get("title", ""), embed.get("description", "")]
    for f in embed.get("fields") or []:
        parts.append(f.get("name", ""))
        parts.append(f.get("value", ""))
    return "\n".join(parts)


def test_reject_non_discord_url():
    result = post_webhook("https://example.com/hook", {"title": "x", "description": "y"})
    assert not result["ok"]
    assert "Discord" in result["error"]


def test_negative_regime_is_red():
    embed = build_embed(
        underlying="SPY", futures="ES",
        bias={"regime": "negative", "headline": "Unstable"},
        levels={"spot": 5000},
    )
    assert embed["color"] == 0xFF5252


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
