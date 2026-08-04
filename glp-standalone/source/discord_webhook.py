"""Post GLP Action Center summaries to a Discord webhook.

Designed for a *private* channel you control. The payload is the same bias /
session summary the desktop shows — not a raw Unusual Whales dump.

Licensing note: BYOK means each operator pulls data with their own key. Posting
derived levels into a private Discord for yourself or a closed study group is
the intended path. Publishing live vendor-derived GEX tables as a paid public
feed is a redistribution risk — do not use this as a commercial signal blast
without your own legal read of the UW terms.

Env: GLP_DISCORD_WEBHOOK or DISCORD_WEBHOOK_URL
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional

import requests

ENV_KEYS = ("GLP_DISCORD_WEBHOOK", "DISCORD_WEBHOOK_URL")

# Discord hard-limits embeds; keep fields short.
MAX_FIELD = 1024
MAX_DESC = 4096

REGIME_COLOR = {
    "positive": 0x66FF66,   # green
    "negative": 0xFF5252,   # red
    "transition": 0xD6FF3B, # yellow
}


def load_webhook_url(explicit: Optional[str] = None) -> str:
    if explicit and str(explicit).strip():
        return str(explicit).strip()
    for key in ENV_KEYS:
        val = (os.getenv(key) or "").strip()
        if val:
            return val
    return ""


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


def _clip(text: str, n: int = MAX_FIELD) -> str:
    text = text or ""
    return text if len(text) <= n else text[: n - 1] + "…"


def build_embed(
    *,
    underlying: str,
    futures: Optional[str] = None,
    bias: Optional[Dict[str, Any]] = None,
    levels: Optional[Dict[str, Any]] = None,
    scenarios: Optional[Dict[str, Any]] = None,
    session: Optional[str] = None,
    plan_text: Optional[str] = None,
) -> Dict[str, Any]:
    """Build one Discord embed from a GLP snapshot."""
    bias = bias or {}
    levels = levels or {}
    regime = str(bias.get("regime") or "unknown")
    head = bias.get("headline") or plan_text or "GLP update"
    title = f"{futures or underlying} · {regime.upper()} gamma"
    if session:
        title += f" · {session.upper()}"

    desc_parts = [str(head)]
    if bias.get("behavior"):
        desc_parts.append(str(bias["behavior"]))
    if bias.get("invalidation"):
        desc_parts.append(f"Invalidation: {bias['invalidation']}")

    fields: List[Dict[str, Any]] = []
    fields.append({
        "name": "Levels",
        "value": _clip(
            f"Spot `{_fmt(levels.get('spot') or bias.get('spot'))}`\n"
            f"Flip `{_fmt(levels.get('flip') or bias.get('flip'))}`\n"
            f"Monthly `{_fmt(levels.get('struct_flip') or bias.get('struct_flip'))}`\n"
            f"Pin `{_fmt(bias.get('pin'))}`\n"
            f"Call wall `{_fmt(bias.get('call_wall'))}`\n"
            f"Support `{_fmt(bias.get('put_wall'))}`\n"
            f"Air pocket `{_fmt(bias.get('air_pocket'))}`"
        ),
        "inline": True,
    })
    fields.append({
        "name": "Read",
        "value": _clip(
            f"Confidence `{bias.get('confidence') or 'n/a'}`\n"
            f"Term `{bias.get('term_structure') or 'n/a'}`\n"
            f"Horizon `{bias.get('horizon') or levels.get('horizon') or 'n/a'}`\n"
            f"Direction `{bias.get('direction') or 'n/a'}` "
            f"(vol framework — not a long/short call)"
        ),
        "inline": True,
    })

    play = bias.get("playbook") or []
    if play:
        fields.append({
            "name": "Playbook",
            "value": _clip("\n".join(f"• {p}" for p in play[:6])),
            "inline": False,
        })

    if scenarios and scenarios.get("sessions"):
        lines = []
        for s in scenarios["sessions"]:
            if s.get("calibrated"):
                lines.append(
                    f"**{s.get('label', s.get('session'))}** — "
                    f"typ `{_fmt(s.get('typical'))}` "
                    f"(quiet {_fmt(s.get('quiet'))} / wide {_fmt(s.get('wide'))})"
                )
            else:
                lines.append(
                    f"**{s.get('label', s.get('session'))}** — not calibrated"
                )
        fields.append({
            "name": "Session expectations",
            "value": _clip("\n".join(lines) or "n/a"),
            "inline": False,
        })

    # Magnets (short list) — matches Futures Conversion, not the full chain.
    pos = levels.get("pos") or []
    neg = levels.get("neg") or []
    if pos or neg:
        def mag(items, n=4):
            out = []
            for it in items[:n]:
                if isinstance(it, dict):
                    px = it.get("price", it.get("strike"))
                    bn = it.get("gex_bn")
                    if bn is None:
                        out.append(_fmt(px))
                    else:
                        out.append(f"{_fmt(px)} ({float(bn):+.2f}bn)")
                else:
                    out.append(_fmt(it))
            return ", ".join(out) if out else "n/a"
        fields.append({
            "name": "+GEX / −GEX",
            "value": _clip(f"+ {_clip(mag(pos), 400)}\n− {_clip(mag(neg), 400)}"),
            "inline": False,
        })

    return {
        "title": _clip(title, 256),
        "description": _clip("\n\n".join(desc_parts), MAX_DESC),
        "color": REGIME_COLOR.get(regime, 0x83BE83),
        "fields": fields,
        "footer": {
            "text": "GLP · research only · not trading advice · BYOK data"
        },
    }


def post_webhook(
    webhook_url: str,
    embed: Dict[str, Any],
    *,
    content: Optional[str] = None,
    username: str = "GLP",
    timeout: float = 15.0,
) -> Dict[str, Any]:
    """POST one embed. Returns {ok, status, error?}."""
    url = (webhook_url or "").strip()
    if not url.startswith("https://discord.com/api/webhooks/") and not url.startswith(
        "https://discordapp.com/api/webhooks/"
    ):
        return {"ok": False, "status": 0, "error": "webhook URL does not look like a Discord webhook"}

    payload = {
        "username": username,
        "embeds": [embed],
    }
    if content:
        payload["content"] = _clip(content, 2000)

    try:
        resp = requests.post(url, json=payload, timeout=timeout)
    except requests.RequestException as exc:
        return {"ok": False, "status": 0, "error": str(exc)}

    if resp.status_code in (200, 204):
        return {"ok": True, "status": resp.status_code}
    return {
        "ok": False,
        "status": resp.status_code,
        "error": _clip(resp.text, 300),
    }


def post_glp_snapshot(
    webhook_url: str,
    snapshot: Dict[str, Any],
    *,
    session: Optional[str] = None,
    content: Optional[str] = None,
) -> Dict[str, Any]:
    """Convenience: pipeline / app snapshot → Discord."""
    levels = snapshot.get("levels") or snapshot.get("futures_levels") or snapshot
    bias = snapshot.get("bias") or levels.get("bias") or {}
    if hasattr(bias, "to_dict"):
        bias = bias.to_dict()
    embed = build_embed(
        underlying=str(snapshot.get("underlying") or levels.get("underlying") or "?"),
        futures=snapshot.get("futures") or levels.get("futures"),
        bias=bias if isinstance(bias, dict) else {},
        levels=levels if isinstance(levels, dict) else {},
        scenarios=snapshot.get("scenarios"),
        session=session or (snapshot.get("session") or {}).get("mode"),
        plan_text=(snapshot.get("plan") or {}).get("text"),
    )
    return post_webhook(webhook_url, embed, content=content)


class DiscordPoster:
    """Cooldown-limited poster for the desktop stream loop."""

    def __init__(self, webhook_url: str, cooldown_sec: int = 300):
        self.url = load_webhook_url(webhook_url)
        self.cooldown_sec = max(30, int(cooldown_sec))
        self._last = 0.0

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    def post(self, snapshot: Dict[str, Any], *, force: bool = False,
             session: Optional[str] = None) -> Dict[str, Any]:
        if not self.enabled:
            return {"ok": False, "status": 0, "error": "no webhook URL"}
        now = time.time()
        if not force and now - self._last < self.cooldown_sec:
            return {
                "ok": False,
                "status": 0,
                "error": f"cooldown {int(self.cooldown_sec - (now - self._last))}s",
                "skipped": True,
            }
        result = post_glp_snapshot(self.url, snapshot, session=session)
        if result.get("ok"):
            self._last = now
        return result
