"""GLP Discord mention bot — update → draw → screenshot → analysis reply.

Webhooks are outbound-only. To "@tag" something in Discord and get a chart +
analysis back, you need a bot that lives on your PC (TradingView CDP + UW key).

This is NOT Cursor. Tagging this bot runs the GLP pipeline locally and posts
the result into the channel. Cursor stays in the IDE.

Setup
-----
1. Discord Developer Portal → New Application → Bot
   - Enable MESSAGE CONTENT INTENT
   - Copy token → set DISCORD_BOT_TOKEN
2. OAuth2 URL Generator: scopes `bot`, permissions Send Messages + Attach Files
   + Embed Links + Read Message History. Invite to your private server.
3. TradingView Desktop with --remote-debugging-port=9222
4. UW API key configured for GLP (same as desktop app)
5. pip install -r requirements-discord.txt
6. Start-GLP-Discord-Bot.cmd  (or: python source/discord_bot.py)

Usage in Discord
----------------
  @Argos trade NQ
  @Argos trade analysis GC
  !argos trade ES
  @Argos daily NQ
  !argos help

Trade analysis = senior advisor checklist (what to watch) + chart + gamma.
Always framed as education — NOT financial advice.
Daily analysis = refresh gamma → draw → screenshot → map briefing.

Optional allow-lists (comma-separated IDs):
  GLP_DISCORD_GUILD_IDS
  GLP_DISCORD_CHANNEL_IDS
  GLP_DISCORD_ALLOWED_USER_IDS
"""

from __future__ import annotations

import asyncio
import io
import os
import random
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Optional, Set, Tuple

# Allow `python source/discord_bot.py` from repo root or source/
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

try:
    import discord
    from discord.ext import commands
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "discord.py missing. Install with:\n  pip install -r requirements-discord.txt"
    ) from exc

from discord_webhook import build_embed
from glp_pipeline import FUTURES_CONVERSION_MAP, PipelineError, run as pipeline_run
from tv_cdp_draw import capture_chart_png, health_check as tv_health_check
from unusual_whales_gex import load_uw_api_key, user_config_dir

TOKEN_FILENAME = "discord_bot_token"
ALLOWLIST_FILENAME = "discord_bot_allowlist.env"

# Futures / nicknames → UW underlying used by the pipeline
_ALIAS_TO_UNDERLYING = {
    "QQQ": "QQQ",
    "NDX": "NDX",
    "NQ": "QQQ",
    "MNQ": "QQQ",
    "NQ1!": "QQQ",
    "SPY": "SPY",
    "SPX": "SPX",
    "ES": "SPY",
    "MES": "SPY",
    "ES1!": "SPY",
    "GLD": "GLD",
    "GC": "GLD",
    "MGC": "GLD",
    "GC1!": "GLD",
    "DIA": "DIA",
    "YM": "DIA",
    "MYM": "DIA",
    "YM1!": "DIA",
    "IWM": "IWM",
    "RTY": "IWM",
    "M2K": "IWM",
    "RTY1!": "IWM",
}

_SESSIONS = frozenset({"rth", "asia", "london", "globex", "visible"})
_PRIMARY = ("NQ", "ES", "GC")  # daily-analysis first-class instruments

_SYM = r"NQ|MNQ|ES|MES|GC|MGC|QQQ|SPY|GLD|NDX|SPX|YM|MYM|RTY|M2K|IWM|DIA"
# Trade advisor: "trade NQ", "trade analysis GC", "advisor ES"
_TRADE_RE = re.compile(
    rf"\b(?:trade(?:\s+analysis)?|advisor(?:\s+view)?|senior\s+read)\b"
    rf"(?:\s+(?:on|for|of))?"
    rf"\s+(?P<sym>{_SYM})"
    rf"(?:\s+(?P<session>rth|asia|london|globex|visible))?"
    rf"(?:\s+(?P<horizon>weekly|monthly|0dte|1dte|all))?",
    re.I,
)
_TRADE_TAIL_RE = re.compile(
    rf"^(?P<sym>{_SYM})\s+"
    rf"(?:trade(?:\s+analysis)?|advisor)\b"
    rf"(?:\s+(?P<session>rth|asia|london|globex|visible))?",
    re.I,
)
# Daily briefing: "daily NQ", "daily analysis GC", "morning brief ES"
# Symbol class is closed (no catch-all) so "daily analysis" does not eat "analysis" as a ticker.
_DAILY_RE = re.compile(
    rf"\b(?:daily(?:\s+analysis)?|briefing|morning(?:\s+brief)?|day\s*report)\b"
    rf"(?:\s+(?:on|for|of))?"
    rf"\s+(?P<sym>{_SYM})"
    rf"(?:\s+(?P<session>rth|asia|london|globex|visible))?"
    rf"(?:\s+(?P<horizon>weekly|monthly|0dte|1dte|all))?",
    re.I,
)
# Also: "NQ daily" / "GC daily analysis"
_DAILY_TAIL_RE = re.compile(
    rf"^(?P<sym>{_SYM})\s+"
    rf"(?:daily(?:\s+analysis)?|briefing)\b"
    rf"(?:\s+(?P<session>rth|asia|london|globex|visible))?",
    re.I,
)
_CMD_RE = re.compile(
    r"(?:update|analyze|analysis|chart|gex|glp)?\s*"
    r"(?P<sym>[A-Za-z0-9!.^=]+)"
    r"(?:\s+(?P<session>rth|asia|london|globex|visible))?"
    r"(?:\s+(?P<horizon>weekly|monthly|0dte|1dte|all))?",
    re.I,
)

# Cooldown to avoid hammering UW / CDP
_COOLDOWN_SEC = float(os.getenv("GLP_DISCORD_COOLDOWN", "45"))
_last_run: Dict[int, float] = {}

# ---------------------------------------------------------------------------
# Personality — Argos: hundred-eyed watchman. Dry, vigilant, never a cheerleader.
# Speaks in short observations. Markets are terrain; he reports the map.
# ---------------------------------------------------------------------------
PERSONA_NAME = "Argos"
PERSONA_TAGLINE = "hundred eyes on the tape"
PERSONA_ACTIVITY = "trade analysis · not advice"
PERSONA_FOOTER = "Argos · research / education only · NOT financial advice · BYOK"
PERSONA_TRADE_FOOTER = (
    "Argos · senior trade read · hypothetical what-I-would-watch · NOT financial advice · not a recommendation"
)

_SCAN_LINES = (
    "One eye on the chain. Drawing the rest.",
    "Scanning the book. Hold still.",
    "Eyes open. Pulling levels.",
    "The watch turns. Fetching the map.",
)
_DAILY_SCAN_LINES = (
    "Daily watch. Chart and gamma incoming.",
    "Opening the day book. Screenshot next.",
    "Daily briefing — pulling {sym} levels.",
    "Eyes on {sym}. Building today's map.",
)
_DONE_LINES = (
    "Mapped.",
    "Eyes agree. Here is the terrain.",
    "Book read. Chart attached.",
    "Surveillance complete.",
)
_DAILY_DONE_LINES = (
    "Daily briefing ready. Chart attached.",
    "Day map for {sym} — gamma and tape.",
    "Briefing complete. Read the terrain.",
)
_TRADE_SCAN_LINES = (
    "Trade read on {sym}. Chart and gamma — then what I would watch.",
    "Senior pass on {sym}. Pulling the book.",
    "Advisor lens on {sym}. Not a call — a checklist.",
)
_TRADE_DONE_LINES = (
    "Trade analysis ready for {sym}. Education only.",
    "Here is what I would watch on {sym} — not advice.",
    "Trade read complete. You decide; I only map.",
)
_FAIL_LINES = (
    "The watch failed:",
    "Blind spot:",
    "Could not finish the scan:",
)
_COOLDOWN_LINES = (
    "Too soon. The eyes need {wait}s to refocus.",
    "Still settling from the last scan — {wait}s.",
    "Patience. {wait}s before another pass.",
)
_DENY_LINES = (
    "Those eyes are not cleared for this channel.",
    "Unauthorized. I do not watch here.",
)
_PARSE_LINES = (
    "That order was unclear.",
    "I heard noise, not a symbol.",
)


def _pick(lines: tuple) -> str:
    return random.choice(lines)


def _parse_id_set(env_key: str) -> Set[int]:
    raw = (os.getenv(env_key) or "").strip()
    if not raw:
        return set()
    out: Set[int] = set()
    for part in raw.replace(" ", "").split(","):
        if part.isdigit():
            out.add(int(part))
    return out


def _resolve_symbol(raw: str) -> Optional[str]:
    sym = (raw or "").upper().replace("=F", "").strip()
    underlying = _ALIAS_TO_UNDERLYING.get(sym, sym)
    if underlying not in FUTURES_CONVERSION_MAP:
        return None
    return underlying


def resolve_request(text: str) -> Optional[Dict[str, str]]:
    """Parse a command into {underlying, session, horizon, mode}.

    mode:
      trade — senior trade advisor read (what to watch; not financial advice)
      daily — full daily analysis (screenshot + gamma briefing)
      update — same pipeline, lighter framing
    """
    text = (text or "").strip()
    if not text or text.lower() in {"help", "?", "h"}:
        return None

    mode = "update"
    m = _TRADE_RE.search(text) or _TRADE_TAIL_RE.search(text)
    if m is not None:
        mode = "trade"
    else:
        m = _DAILY_RE.search(text) or _DAILY_TAIL_RE.search(text)
        if m is not None:
            mode = "daily"
        else:
            m = _CMD_RE.search(text)
            if m is None:
                return None
            # Bare "analysis NQ" counts as daily — unless it is a trade/advisor ask.
            if re.search(r"\b(trade|advisor)\b", text, re.I):
                mode = "trade"
            elif re.search(r"\b(analysis|analyze|brief)\b", text, re.I):
                mode = "daily"

    underlying = _resolve_symbol(m.group("sym"))
    if not underlying:
        return None

    session = (m.groupdict().get("session") or "").lower()
    if not session:
        # Trade/daily briefings default to RTH; other commands honor env default.
        session = (
            "rth"
            if mode in {"daily", "trade"}
            else (os.getenv("GLP_DEFAULT_SESSION", "rth"))
        )
    if session not in _SESSIONS:
        session = "rth"

    horizon = (m.groupdict().get("horizon") or "").lower()
    if not horizon:
        horizon = "weekly"  # near-dated book for the day
    if horizon == "all":
        horizon = "weekly"

    futures = {
        "QQQ": "NQ", "NDX": "NQ",
        "SPY": "ES", "SPX": "ES",
        "GLD": "GC",
        "DIA": "YM",
        "IWM": "RTY",
    }.get(underlying, underlying)

    return {
        "underlying": underlying,
        "futures": futures,
        "session": session,
        "horizon": horizon,
        "mode": mode,
    }


def _allowed(message: discord.Message) -> bool:
    guilds = _parse_id_set("GLP_DISCORD_GUILD_IDS")
    channels = _parse_id_set("GLP_DISCORD_CHANNEL_IDS")
    users = _parse_id_set("GLP_DISCORD_ALLOWED_USER_IDS")
    if guilds and (message.guild is None or message.guild.id not in guilds):
        return False
    if channels and message.channel.id not in channels:
        return False
    if users and message.author.id not in users:
        return False
    return True


def _fmt_level(v: Any) -> str:
    if v is None:
        return "n/a"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if abs(f - round(f)) < 1e-6:
        return f"{f:,.0f}"
    return f"{f:,.2f}"


def _daily_analysis_text(bias: Dict[str, Any], levels: Dict[str, Any], futures: str) -> str:
    """Compact Argos daily briefing paragraph for the embed description."""
    regime = str(bias.get("regime") or "unknown")
    head = bias.get("headline") or "Gamma map ready"
    bits = [
        f"**Daily analysis — {futures}**",
        str(head),
        f"Regime: **{regime}** gamma · confidence `{bias.get('confidence') or 'n/a'}`",
    ]
    if bias.get("behavior"):
        bits.append(str(bias["behavior"]))
    bits.append(
        f"Spot `{_fmt_level(levels.get('spot') or bias.get('spot'))}` · "
        f"Flip `{_fmt_level(levels.get('flip') or bias.get('flip'))}` · "
        f"Pin `{_fmt_level(bias.get('pin'))}` · "
        f"Call wall `{_fmt_level(bias.get('call_wall'))}` · "
        f"Shelf `{_fmt_level(bias.get('put_wall'))}` · "
        f"Air pocket `{_fmt_level(bias.get('air_pocket'))}`"
    )
    play = bias.get("playbook") or []
    if play:
        bits.append("**Playbook**\n" + "\n".join(f"• {p}" for p in play[:5]))
    if bias.get("invalidation"):
        bits.append(f"Invalidation: {bias['invalidation']}")
    gloss = {
        "positive": "_Dealers long gamma. The tape wants to pin; fades are the terrain._",
        "negative": "_Dealers short gamma. Breaks run. Do not fade the air._",
        "transition": "_Sitting on the flip. Wait for acceptance before leaning._",
    }.get(regime)
    if gloss:
        bits.append(gloss)
    bits.append("_Terrain report — not a trade call._")
    text = "\n\n".join(bits)
    return text if len(text) <= 4000 else text[:3997] + "…"


def _trade_analysis_text(
    bias: Dict[str, Any],
    levels: Dict[str, Any],
    futures: str,
    *,
    session: str,
    scenarios: Optional[Dict[str, Any]] = None,
) -> str:
    """Senior trade-advisor framing: what Argos would watch — not a recommendation."""
    regime = str(bias.get("regime") or "unknown")
    conf = str(bias.get("confidence") or "n/a")
    spot = _fmt_level(levels.get("spot") or bias.get("spot"))
    flip = _fmt_level(levels.get("flip") or bias.get("flip"))
    pin = _fmt_level(bias.get("pin"))
    cw = _fmt_level(bias.get("call_wall"))
    pw = _fmt_level(bias.get("put_wall"))
    air = _fmt_level(bias.get("air_pocket"))
    struct = _fmt_level(levels.get("struct_flip") or bias.get("struct_flip"))
    term = bias.get("term_structure") or "unknown"

    bits = [
        f"**Trade analysis — {futures}** · senior read",
        (
            "This is a **hypothetical checklist** of what I would watch on this "
            "gamma map. It is **not financial advice**, not a recommendation to "
            "buy or sell, and not a substitute for your own plan and risk limits."
        ),
        f"**Map:** regime **{regime}** · confidence `{conf}` · term `{term}` · session `{session}`",
        (
            f"Spot `{spot}` · Flip `{flip}` · Monthly `{struct}` · "
            f"Pin `{pin}` · Call wall `{cw}` · Shelf `{pw}` · Air `{air}`"
        ),
    ]
    if bias.get("behavior"):
        bits.append(f"**Behavior frame:** {bias['behavior']}")

    watch: List[str] = []
    if regime == "positive":
        watch.extend(
            [
                f"I would treat `{pin}` as the magnet and ask whether price is being damped toward it.",
                f"Extensions into `{cw}` are where I would look for *failed* breakout / fade *conditions* — only if acceptance fails, not because a bot said short.",
                f"Dips into `{pw}` are where I would look for dealer-supported bounce *conditions* — thin shelves (`weak`) get less weight.",
                f"A sustained break and hold under Flip `{flip}` is where I would stop fading and reassess the regime.",
                f"Air pocket `{air}` is acceleration terrain if tagged — I would not treat it as support.",
            ]
        )
    elif regime == "negative":
        watch.extend(
            [
                f"I would not fade blindly below Flip `{flip}` — hedging flow can extend moves.",
                f"Loss of `{air}` is the acceleration trigger I would mark on the chart.",
                f"Reclaim and hold of `{flip}` is the condition that would make me question the unstable read.",
                f"`{pw}` is the rare positive-gamma shelf below — a pause candidate, not a guaranteed floor.",
                "Size and stop distance matter more in this regime; yesterday’s ranges are often too tight.",
            ]
        )
    else:
        watch.extend(
            [
                f"I would treat Flip `{flip}` as the pivot and wait for acceptance on one side.",
                "Lowest-conviction state — I would rather miss the first push than invent a lean.",
                f"Above `{flip}` I watch for range/pin behavior; below it I watch for expansion.",
            ]
        )

    if term == "fragile":
        watch.append(
            f"Term structure is fragile vs monthly `{struct}` — I would treat pins as intraday conditions, not overnight floors."
        )
    elif term == "recovering":
        watch.append(
            f"Near-dated stress with monthly still constructive (`{struct}`) — reclaim of `{flip}` may stick better than a fully negative book."
        )

    if bias.get("call_wall_weak"):
        watch.append(f"Call wall `{cw}` is weak — I would not lean hard on it as a hard cap.")
    if bias.get("put_wall_weak"):
        watch.append(f"Shelf `{pw}` is weak — dip-buys have less hedging support behind them.")

    bits.append("**What I would watch**\n" + "\n".join(f"• {w}" for w in watch[:7]))

    play = bias.get("playbook") or []
    if play:
        bits.append(
            "**From the gamma playbook (context, not orders)**\n"
            + "\n".join(f"• {p}" for p in play[:4])
        )

    if bias.get("invalidation"):
        bits.append(f"**Invalidation I would respect:** {bias['invalidation']}")

    # Session width context if calibrated — distance, not direction.
    if scenarios and scenarios.get("sessions"):
        for s in scenarios["sessions"]:
            if str(s.get("session") or "").lower() == session and s.get("calibrated"):
                bits.append(
                    f"**{session.upper()} width context:** typical `{_fmt_level(s.get('typical'))}` pts "
                    f"(quiet {_fmt_level(s.get('quiet'))} / wide {_fmt_level(s.get('wide'))}) — "
                    "range expectation, not a long/short call."
                )
                break

    bits.append(
        "**Process I would use:** define risk first → wait for acceptance at the level → "
        "one clear invalidation → flat if the map changes. No chase."
    )
    bits.append(
        "_Educational trade read only. Not financial advice. Past dealer-gamma patterns "
        "do not predict future results. You are solely responsible for any decisions._"
    )
    text = "\n\n".join(bits)
    return text if len(text) <= 4000 else text[:3997] + "…"


def _run_job(
    underlying: str,
    session: str,
    horizon: str,
    *,
    mode: str = "update",
    futures_label: str = "",
) -> Dict[str, Any]:
    """Blocking work: pipeline draw + screenshot + analysis embed."""
    snap = pipeline_run(
        underlying,
        horizon=horizon,
        target="futures",
        draw=True,
        session=session,
        switch_symbol=True,
        top_n=7,
    )
    # Let TradingView finish painting before the capture.
    time.sleep(1.5)

    health = tv_health_check()
    png: Optional[bytes] = None
    shot_err: Optional[str] = None
    if health.get("ok"):
        try:
            png = capture_chart_png()
        except Exception as exc:  # noqa: BLE001
            shot_err = str(exc)
    else:
        shot_err = str(health.get("error") or "TradingView CDP not reachable")

    levels = snap.get("levels") or {}
    bias = snap.get("bias") or levels.get("bias") or {}
    fut = futures_label or snap.get("futures") or levels.get("futures") or underlying

    embed = build_embed(
        underlying=underlying,
        futures=fut,
        bias=bias,
        levels=levels,
        scenarios=snap.get("scenarios"),
        session=session,
        plan_text=(snap.get("plan") or {}).get("text"),
    )
    regime = str((bias or {}).get("regime") or "unknown")
    if mode == "daily":
        embed["title"] = f"Daily analysis · {fut} · {regime.upper()} gamma"
        embed["description"] = _daily_analysis_text(bias, levels, str(fut))
        embed["footer"] = {"text": PERSONA_FOOTER}
    elif mode == "trade":
        embed["title"] = f"Trade analysis · {fut} · {regime.upper()} gamma · not advice"
        embed["description"] = _trade_analysis_text(
            bias,
            levels,
            str(fut),
            session=session,
            scenarios=snap.get("scenarios"),
        )
        # Advisor fields stay for levels/session; playbook already woven into description.
        embed["footer"] = {"text": PERSONA_TRADE_FOOTER}
        embed["color"] = 0xD4A017  # amber — caution / advisor, not a green "go"
    else:
        gloss = {
            "positive": "Dealers long gamma. The tape wants to pin; fades are the terrain.",
            "negative": "Dealers short gamma. Breaks run. Do not fade the air.",
            "transition": "Sitting on the flip. One eye open — wait for acceptance.",
        }.get(regime)
        if gloss:
            desc = embed.get("description") or ""
            embed["description"] = (desc + "\n\n*" + gloss + "*").strip()
        embed["footer"] = {"text": PERSONA_FOOTER}

    if png:
        embed["image"] = {"url": "attachment://glp_chart.png"}
    embed["author"] = {
        "name": (
            f"{PERSONA_NAME} — senior trade read (not advice)"
            if mode == "trade"
            else f"{PERSONA_NAME} — {PERSONA_TAGLINE}"
        ),
    }

    return {
        "embed": embed,
        "png": png,
        "shot_err": shot_err,
        "tv_symbol": levels.get("tv_symbol"),
        "futures": fut,
        "regime": regime,
        "mode": mode,
    }


def _strip_mentions(
    content: str,
    bot_user: discord.ClientUser,
    role_ids: Optional[Set[int]] = None,
) -> str:
    text = content
    for mention in (f"<@{bot_user.id}>", f"<@!{bot_user.id}>"):
        text = text.replace(mention, " ")
    for rid in role_ids or set():
        text = text.replace(f"<@&{rid}>", " ")
    # Also strip leading bang commands
    text = re.sub(r"^!(?:glp|argos)\s*", "", text.strip(), flags=re.I)
    return text.strip()


def _argos_invoked(message: discord.Message) -> tuple[bool, Set[int]]:
    """True if the user @Argos (user or role) or used !argos / !glp.

    Discord role pings look like <@&id> and do NOT appear in message.mentions,
    so a dedicated Argos role must be checked via role_mentions.
    """
    if bot.user is None:
        return False, set()
    role_ids: Set[int] = set()
    hit = bot.user in message.mentions
    if message.guild and message.guild.me:
        my_roles = {r.id for r in message.guild.me.roles}
        for role in message.role_mentions:
            if role.id in my_roles or role.name.lower() in {"argos", "glp"}:
                hit = True
                role_ids.add(role.id)
    if _is_command(message.content or ""):
        hit = True
    return hit, role_ids


def _help_text() -> str:
    return (
        f"**{PERSONA_NAME}** — {PERSONA_TAGLINE}.\n\n"
        "**Trade analysis** (senior advisor lens — *not* financial advice)\n"
        "• `@Argos trade NQ`\n"
        "• `@Argos trade analysis GC`\n"
        "• `!argos trade ES`\n"
        "• `@Argos NQ trade`\n\n"
        "**Daily analysis** (map + screenshot)\n"
        "• `@Argos daily NQ` · `!argos daily ES`\n\n"
        "Primary: **NQ · ES · GC**\n"
        "Also: `@Argos update NQ asia`\n\n"
        "_I describe what I would watch. I do not tell you to buy or sell._\n"
        "Needs TradingView on CDP 9222 + your UW key."
    )


def _is_command(content: str) -> bool:
    low = (content or "").lower().strip()
    return low.startswith("!glp") or low.startswith("!argos")


intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True
intents.messages = True

bot = commands.Bot(
    command_prefix=("!glp ", "!glp", "!argos ", "!argos"),
    intents=intents,
    help_command=None,
)


@bot.event
async def on_ready():
    print(f"[GLP Discord] logged in as {bot.user} (id={bot.user.id})")
    print(f"[GLP Discord] {PERSONA_NAME} online — mention or !argos / !glp")
    try:
        await bot.change_presence(
            activity=discord.Activity(
                type=discord.ActivityType.watching,
                name=PERSONA_ACTIVITY,
            )
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[GLP Discord] presence skip: {exc}")


async def _safe_reply(message: discord.Message, content: str, **kwargs) -> Optional[discord.Message]:
    """Reply, or fall back to channel.send. Surfaces missing channel perms clearly."""
    try:
        return await message.reply(content, mention_author=False, **kwargs)
    except discord.Forbidden:
        try:
            return await message.channel.send(
                f"{message.author.mention} {content}",
                **kwargs,
            )
        except discord.Forbidden:
            print(
                f"[GLP Discord] FORBIDDEN in #{getattr(message.channel, 'name', '?')} "
                f"({message.channel.id}) — grant Send Messages + Embed Links + Attach Files"
            )
            try:
                await message.author.send(
                    f"I can see `#{getattr(message.channel, 'name', 'that-channel')}` but I cannot "
                    f"post there. Ask an admin to give **{PERSONA_NAME}** these permissions in that "
                    "channel: View Channel, Send Messages, Embed Links, Attach Files, Read Message History."
                )
            except Exception:
                pass
            return None
    except discord.HTTPException as exc:
        print(f"[GLP Discord] HTTP error on reply: {exc}")
        return None


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
    if bot.user is None:
        return

    content = message.content or ""
    invoked, role_ids = _argos_invoked(message)
    if not invoked:
        return
    if not _allowed(message):
        await _safe_reply(message, _pick(_DENY_LINES))
        return

    # Fail fast with a clear message if Argos can read but not speak here.
    me = message.guild.me if message.guild else None
    if me is not None:
        perms = message.channel.permissions_for(me)
        if not (perms.send_messages and perms.embed_links and perms.attach_files):
            missing = []
            if not perms.send_messages:
                missing.append("Send Messages")
            if not perms.embed_links:
                missing.append("Embed Links")
            if not perms.attach_files:
                missing.append("Attach Files")
            tip = (
                f"I am watching, but muted in `#{getattr(message.channel, 'name', 'this-channel')}`. "
                f"Missing: {', '.join(missing)}. "
                "Give Argos those perms (or use `#analysis` / `#general-chat`)."
            )
            print(f"[GLP Discord] muted in #{getattr(message.channel, 'name', '?')}: {missing}")
            await _safe_reply(message, tip)
            return

    body = _strip_mentions(content, bot.user, role_ids=role_ids)
    # Soft greetings get personality without a full scan.
    if body.lower() in {"hi", "hello", "hey", "yo", "sup", "who are you", "who are you?"}:
        await _safe_reply(
            message,
            f"I am **{PERSONA_NAME}**. {PERSONA_TAGLINE.capitalize()}.\n"
            "Trade read (not advice): `@Argos trade NQ` · "
            "Daily map: `@Argos daily ES`",
        )
        return
    if not body or body.lower() in {"help", "?", "h", "commands", "daily", "trade"}:
        await _safe_reply(message, _help_text())
        return

    parsed = resolve_request(body)
    if not parsed:
        await _safe_reply(
            message,
            f"{_pick(_PARSE_LINES)} `{body}`\n\n{_help_text()}",
        )
        return

    underlying = parsed["underlying"]
    session = parsed["session"]
    horizon = parsed["horizon"]
    mode = parsed["mode"]
    fut = parsed["futures"]

    ch_id = message.channel.id
    now = time.time()
    last = _last_run.get(ch_id, 0)
    if now - last < _COOLDOWN_SEC:
        wait = int(_COOLDOWN_SEC - (now - last))
        await _safe_reply(message, _pick(_COOLDOWN_LINES).format(wait=wait))
        return
    _last_run[ch_id] = now

    if mode == "trade":
        status_msg = _pick(_TRADE_SCAN_LINES).format(sym=fut)
    elif mode == "daily":
        status_msg = _pick(_DAILY_SCAN_LINES).format(sym=fut)
    else:
        status_msg = f"{_pick(_SCAN_LINES)} **{fut}** · {session}/{horizon}"
    status = await _safe_reply(message, status_msg)
    if status is None:
        return

    try:
        result = await asyncio.to_thread(
            _run_job,
            underlying,
            session,
            horizon,
            mode=mode,
            futures_label=fut,
        )
    except PipelineError as exc:
        print(f"[GLP Discord] PipelineError: {exc}")
        try:
            await status.edit(content=f"{_pick(_FAIL_LINES)} {exc}")
        except Exception:
            await _safe_reply(message, f"{_pick(_FAIL_LINES)} {exc}")
        return
    except Exception as exc:  # noqa: BLE001
        print(f"[GLP Discord] job error: {exc}")
        try:
            await status.edit(content=f"{_pick(_FAIL_LINES)} {exc}")
        except Exception:
            await _safe_reply(message, f"{_pick(_FAIL_LINES)} {exc}")
        return

    try:
        embed = discord.Embed.from_dict(result["embed"])
    except Exception as exc:  # noqa: BLE001
        print(f"[GLP Discord] embed build failed: {exc}")
        await status.edit(content=f"{_pick(_FAIL_LINES)} embed build failed: {exc}")
        return

    files = []
    if result.get("png"):
        files.append(
            discord.File(io.BytesIO(result["png"]), filename="glp_chart.png")
        )
    note = ""
    if result.get("shot_err") and not result.get("png"):
        note = f"\n_One eye closed — no chart: {result['shot_err']}_"

    sym = result.get("tv_symbol") or fut
    if mode == "trade":
        done = _pick(_TRADE_DONE_LINES).format(sym=fut)
        ping = (
            f"{message.author.mention} — **Trade analysis** `{fut}` "
            "(what I would watch — **not** financial advice)."
        )
    elif mode == "daily":
        done = _pick(_DAILY_DONE_LINES).format(sym=fut)
        ping = f"{message.author.mention} — **Daily analysis** `{fut}` ready."
    else:
        done = f"{_pick(_DONE_LINES)} `{sym}`"
        ping = f"{message.author.mention} — {PERSONA_NAME} has eyes on **{sym}**."

    try:
        await status.edit(content=f"{done}{note}")
    except Exception as exc:  # noqa: BLE001
        print(f"[GLP Discord] status edit failed: {exc}")

    try:
        await message.channel.send(
            content=ping,
            embed=embed,
            files=files or None,
        )
    except discord.Forbidden:
        print(f"[GLP Discord] cannot send briefing in #{getattr(message.channel, 'name', '?')}")
        await status.edit(
            content=(
                f"{done}{note}\n"
                "_Could not attach the briefing here — missing Send/Embed/Attach permissions._"
            )
        )
    except discord.HTTPException as exc:
        print(f"[GLP Discord] send failed: {exc}")
        await status.edit(content=f"{_pick(_FAIL_LINES)} Discord rejected the post: {exc}")


def token_path() -> Path:
    return Path(user_config_dir()) / TOKEN_FILENAME


def allowlist_path() -> Path:
    return Path(user_config_dir()) / ALLOWLIST_FILENAME


def save_bot_token(token: str) -> Path:
    path = token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text((token or "").strip(), encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def load_bot_token(explicit: Optional[str] = None) -> str:
    if explicit and str(explicit).strip():
        return str(explicit).strip()
    for key in ("DISCORD_BOT_TOKEN", "GLP_DISCORD_BOT_TOKEN"):
        val = (os.getenv(key) or "").strip()
        if val:
            return val
    path = token_path()
    if path.is_file():
        try:
            val = path.read_text(encoding="utf-8").strip()
        except OSError:
            val = ""
        if val:
            return val
    return ""


def load_allowlist_env() -> None:
    """Optional %APPDATA%\\GLP\\discord_bot_allowlist.env KEY=value lines."""
    path = allowlist_path()
    if not path.is_file():
        return
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val
    except OSError:
        pass


def preflight() -> Dict[str, Any]:
    """Check token, UW key, TradingView CDP, discord.py — print a report."""
    load_allowlist_env()
    token = load_bot_token()
    uw = load_uw_api_key()
    tv = tv_health_check()
    report = {
        "discord_token": bool(token),
        "token_path": str(token_path()),
        "uw_key": bool(uw),
        "tv_ok": bool(tv.get("ok")),
        "tv_symbol": tv.get("symbol"),
        "tv_error": tv.get("error"),
        "discord_py": getattr(discord, "__version__", "?"),
    }
    print("[GLP Discord] preflight")
    print(f"  discord.py     {report['discord_py']}")
    print(
        f"  bot token      {'OK (' + report['token_path'] + ')' if token else 'MISSING - run Setup-GLP-Discord-Bot.cmd'}"
    )
    print(f"  UW API key     {'OK' if uw else 'MISSING - Launch-GLP.bat --set-key'}")
    if tv.get("ok"):
        sym = tv.get("symbol") or "(no chart symbol yet)"
        print(f"  TradingView    OK symbol={sym}")
    else:
        print(f"  TradingView    FAIL: {tv.get('error')}")
    # Token + UW are required to run updates; CDP can be up without a symbol yet.
    ok = bool(token and uw and tv.get("ok"))
    report["ok"] = ok
    print(f"  ready          {'YES' if ok else 'NO'}")
    return report


def interactive_setup() -> None:
    """Prompt for bot token (+ optional allow-lists) and save under %APPDATA%\\GLP."""
    print("GLP Discord bot setup")
    print("-" * 40)
    print("Paste the bot token from Discord Developer Portal → Bot.")
    print("(Input is hidden from scrollback only if your console supports it.)")
    token = input("DISCORD_BOT_TOKEN: ").strip()
    if not token or token.lower() in {"q", "quit", "exit"}:
        raise SystemExit("Setup cancelled — no token saved.")
    path = save_bot_token(token)
    print(f"Saved token → {path}")

    print()
    print("Optional allow-lists (comma-separated snowflake IDs, Enter to skip):")
    guilds = input("GLP_DISCORD_GUILD_IDS: ").strip()
    channels = input("GLP_DISCORD_CHANNEL_IDS: ").strip()
    users = input("GLP_DISCORD_ALLOWED_USER_IDS: ").strip()
    lines = [
        "# Optional GLP Discord bot allow-lists",
        f"GLP_DISCORD_GUILD_IDS={guilds}",
        f"GLP_DISCORD_CHANNEL_IDS={channels}",
        f"GLP_DISCORD_ALLOWED_USER_IDS={users}",
    ]
    ap = allowlist_path()
    ap.parent.mkdir(parents=True, exist_ok=True)
    ap.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Saved allow-list → {ap}")
    print()
    preflight()
    print()
    print("Next: Start-GLP-Discord-Bot.cmd")
    print("In Discord: @GLP update NQ   or   !glp QQQ asia")


def main(argv: Optional[list] = None) -> None:
    args = list(argv if argv is not None else sys.argv[1:])
    if "--setup" in args or "setup" in args:
        interactive_setup()
        return
    if "--preflight" in args or "preflight" in args:
        report = preflight()
        raise SystemExit(0 if report.get("ok") else 2)

    load_allowlist_env()
    token = load_bot_token()
    if not token:
        raise SystemExit(
            "No Discord bot token.\n"
            "  Run Setup-GLP-Discord-Bot.cmd\n"
            "  or set DISCORD_BOT_TOKEN / save to %APPDATA%\\GLP\\discord_bot_token"
        )

    report = preflight()
    if not report.get("uw_key"):
        print("[GLP Discord] WARNING: no UW key — update commands will fail until set.")
    if not report.get("tv_ok"):
        print("[GLP Discord] WARNING: TradingView CDP not ready — screenshots/draws will fail.")

    tmp = Path(tempfile.gettempdir()) / "glp_discord"
    tmp.mkdir(parents=True, exist_ok=True)
    print(f"[GLP Discord] temp dir {tmp}")
    print("[GLP Discord] starting…  (Ctrl+C to stop)")
    bot.run(token)


if __name__ == "__main__":
    main()
