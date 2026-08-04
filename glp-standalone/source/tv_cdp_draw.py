"""TradingView Desktop draw bridge via CDP (port 9222).

Renders the GLP action plan: the gamma flip as the regime line, the pin, the
call and put walls, gamma magnets, containment boxes, and the plan text. Which
levels are triggers and which are targets depends on the gamma regime, so the
plan is built from a GammaBias rather than from price proximity alone.
"""

from __future__ import annotations

import base64
import json
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, time as dtime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None  # type: ignore

import requests
import websocket

from gex_scenarios import expectation
from gex_bias import (
    GammaBias,
    REGIME_NEGATIVE,
    REGIME_POSITIVE,
    TERM_FRAGILE,
    TERM_RECOVERING,
    TERM_UNKNOWN,
    compute_bias,
    same_level,
)

DEFAULT_CDP_HOST = "127.0.0.1"
DEFAULT_CDP_PORT = 9222
CHART_API = "window.TradingViewApi._activeChartWidgetWV.value()"

FUTURES_TV_SYMBOL = {
    "ES": "ES1!",
    "NQ": "NQ1!",
    "GC": "GC1!",
    "YM": "YM1!",
    "RTY": "RTY1!",
}

# Match the QQQ action-plan palette from the reference chart.
COLOR_LONG = "#00E676"
COLOR_SHORT = "#FF5252"
COLOR_HP = "#B388FF"
COLOR_STRUCT_FLIP = "#7E57C2"
COLOR_PIN = "#FFD54F"
COLOR_POS = "#69F0AE"
COLOR_NEG = "#FFB74D"
COLOR_NEG_STRONG = "#FF8A65"
COLOR_ZONE_POS = "rgba(0, 230, 118, 0.18)"
COLOR_ZONE_MID = "rgba(255, 183, 77, 0.10)"
COLOR_ZONE_NEG = "rgba(239, 83, 80, 0.18)"
COLOR_ZONE_POS_BORDER = "#00E676"
COLOR_ZONE_MID_BORDER = "#FFB74D"
COLOR_ZONE_NEG_BORDER = "#EF5350"
COLOR_TEXT = "#FFFFFF"

# Only plot levels within this fraction of spot; keeps far OTM magnets off the chart.
PLAN_BAND_PCT = 0.06

MARKET_TZ = ZoneInfo("America/New_York") if ZoneInfo is not None else None
RTH_OPEN = dtime(9, 30)
RTH_CLOSE = dtime(16, 0)
GLOBEX_OPEN = dtime(18, 0)
GLOBEX_CLOSE = dtime(17, 0)
# The overnight halves of the Globex session. US options are closed through both,
# so the gamma book is frozen, but dealers still hedge it in futures.
ASIA_OPEN = dtime(18, 0)
ASIA_CLOSE = dtime(3, 0)
LONDON_OPEN = dtime(3, 0)
LONDON_CLOSE = dtime(9, 30)

SESSION_MODES = ("rth", "globex", "asia", "london")


def _market_now(now: Optional[datetime] = None) -> datetime:
    if now is not None:
        return now
    if MARKET_TZ is not None:
        return datetime.now(MARKET_TZ)
    return datetime.now()


def _next_weekday(day):
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


def _at(day, clock: dtime) -> datetime:
    stamp = datetime.combine(day, clock)
    if MARKET_TZ is not None:
        stamp = stamp.replace(tzinfo=MARKET_TZ)
    return stamp


def session_window(mode: str = "rth", now: Optional[datetime] = None) -> Tuple[int, int]:
    """Unix bounds of the trading session that levels should span.

    Before the open we target today's session so pre-market prep draws onto the
    session about to start; once the close passes we roll to the next weekday.
    """
    ref = _market_now(now)
    today = ref.date()
    mode = (mode or "rth").strip().lower()

    if mode == "globex":
        # Past the 17:00 close we point at the session that reopens at 18:00.
        start_day = today if ref.time() >= GLOBEX_CLOSE else today - timedelta(days=1)
        # Globex opens Sunday through Thursday evenings; Friday and Saturday are dark.
        while start_day.weekday() in (4, 5):
            start_day += timedelta(days=1)
        open_dt = _at(start_day, GLOBEX_OPEN)
        close_dt = _at(start_day + timedelta(days=1), GLOBEX_CLOSE)
        return int(open_dt.timestamp()), int(close_dt.timestamp())

    if mode == "asia":
        # Before 03:00 the evening session is still running, so stay on the one
        # that opened last night rather than jumping a day ahead.
        if ref.time() < ASIA_CLOSE:
            start_day = today - timedelta(days=1)
            if start_day.weekday() not in (4, 5):
                return (int(_at(start_day, ASIA_OPEN).timestamp()),
                        int(_at(today, ASIA_CLOSE).timestamp()))
        start_day = today
        while start_day.weekday() in (4, 5):
            start_day += timedelta(days=1)
        return (int(_at(start_day, ASIA_OPEN).timestamp()),
                int(_at(start_day + timedelta(days=1), ASIA_CLOSE).timestamp()))

    if mode == "london":
        day = _next_weekday(today)
        if day == today and ref.time() >= LONDON_CLOSE:
            day = _next_weekday(today + timedelta(days=1))
        return (int(_at(day, LONDON_OPEN).timestamp()),
                int(_at(day, LONDON_CLOSE).timestamp()))

    day = _next_weekday(today)
    if day == today and ref.time() >= RTH_CLOSE:
        day = _next_weekday(today + timedelta(days=1))
    return int(_at(day, RTH_OPEN).timestamp()), int(_at(day, RTH_CLOSE).timestamp())


def format_session(start: int, end: int) -> str:
    """Render a session window in market time, not the machine's local zone."""
    if MARKET_TZ is not None:
        a = datetime.fromtimestamp(start, MARKET_TZ)
        b = datetime.fromtimestamp(end, MARKET_TZ)
        suffix = " ET"
    else:
        a = datetime.fromtimestamp(start)
        b = datetime.fromtimestamp(end)
        suffix = ""
    same_day = a.date() == b.date()
    right = b.strftime("%H:%M") if same_day else b.strftime("%a %m-%d %H:%M")
    return f"{a.strftime('%a %m-%d %H:%M')} -> {right}{suffix}"


def session_key(mode: str = "rth", now: Optional[datetime] = None) -> str:
    """Stable id for the session a draw belongs to, so redraws roll over cleanly."""
    start, _ = session_window(mode, now)
    stamp = datetime.fromtimestamp(start, MARKET_TZ) if MARKET_TZ else datetime.fromtimestamp(start)
    return f"{(mode or 'rth').lower()}:{stamp.date().isoformat()}"


def drawable_span(mode: str = "rth", now: Optional[datetime] = None) -> Tuple[int, int]:
    """Session bounds adjusted so prep drawings stay readable on the live chart.

    Levels still belong to one session, but if that session has not opened yet the
    left edge is pulled back to 'now' so Flip/Pin/range sit over the candles the
    trader is looking at instead of only in empty future space on the right.
    """
    start, end = session_window(mode, now)
    if (mode or "rth").strip().lower() == "visible":
        return start, end
    ref = _market_now(now)
    now_ts = int(ref.timestamp())
    if start > now_ts:
        # Upcoming session: show levels from now through the session close.
        return now_ts, end
    if end < now_ts:
        # Should not happen for a rolled window, but keep a readable stub.
        return start, end
    return start, end


@dataclass
class DrawLevel:
    price: float
    label: str
    color: str = "#00E5FF"
    width: int = 1
    style: int = 0  # 0 solid, 1 dotted, 2 dashed


@dataclass
class DrawZone:
    high: float
    low: float
    label: str
    fill: str
    border: str


@dataclass
class ActionDrawPlan:
    symbol: str
    long_level: float | None
    short_level: float | None
    flip_level: float | None
    plan_text: str
    lines: List[DrawLevel] = field(default_factory=list)
    zones: List[DrawZone] = field(default_factory=list)
    regime: str = "unknown"
    bias_headline: str = ""
    confidence: str = "low"


class CdpSession:
    def __init__(self, host: str = DEFAULT_CDP_HOST, port: int = DEFAULT_CDP_PORT, timeout: float = 12.0):
        self.host = host
        self.port = int(port)
        self.timeout = timeout
        self._ws: Optional[websocket.WebSocket] = None
        self._msg_id = 0
        self._lock = threading.Lock()

    def connect(self) -> dict:
        targets = requests.get(f"http://{self.host}:{self.port}/json/list", timeout=5).json()
        target = next(
            (t for t in targets if t.get("type") == "page" and "tradingview.com/chart" in (t.get("url") or "").lower()),
            None,
        )
        if target is None:
            target = next(
                (t for t in targets if t.get("type") == "page" and "tradingview" in (t.get("url") or "").lower()),
                None,
            )
        if target is None:
            raise RuntimeError(
                f"No TradingView chart tab found on {self.host}:{self.port}. "
                "Open TradingView Desktop with --remote-debugging-port=9222."
            )
        ws_url = target.get("webSocketDebuggerUrl")
        if not ws_url:
            raise RuntimeError("Chart target has no webSocketDebuggerUrl")
        self._ws = websocket.create_connection(ws_url, timeout=self.timeout, suppress_origin=True)
        self._call("Runtime.enable")
        self._call("Page.enable")
        return {"id": target.get("id"), "title": target.get("title"), "url": target.get("url")}

    def close(self):
        if self._ws is not None:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False

    def _call(self, method: str, params: dict | None = None) -> Any:
        if self._ws is None:
            raise RuntimeError("CDP session not connected")
        with self._lock:
            self._msg_id += 1
            msg_id = self._msg_id
            payload = {"id": msg_id, "method": method}
            if params:
                payload["params"] = params
            self._ws.send(json.dumps(payload))
            deadline = time.time() + self.timeout
            while time.time() < deadline:
                raw = self._ws.recv()
                data = json.loads(raw)
                if data.get("id") != msg_id:
                    continue
                if "error" in data:
                    raise RuntimeError(f"CDP {method} error: {data['error']}")
                return data.get("result")
            raise TimeoutError(f"CDP timeout waiting for {method}")

    def evaluate(self, expression: str, await_promise: bool = False) -> Any:
        result = self._call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
            },
        )
        if result and result.get("exceptionDetails"):
            details = result["exceptionDetails"]
            exc = details.get("exception") or {}
            msg = exc.get("description") or details.get("text") or "JS evaluation error"
            raise RuntimeError(msg)
        return (result or {}).get("result", {}).get("value")

    def capture_png(self, *, format: str = "png", quality: int | None = None) -> bytes:
        """Capture the TradingView page via CDP Page.captureScreenshot."""
        params: dict = {"format": format}
        if quality is not None and format == "jpeg":
            params["quality"] = int(quality)
        result = self._call("Page.captureScreenshot", params)
        data = (result or {}).get("data")
        if not data:
            raise RuntimeError("CDP Page.captureScreenshot returned no data")
        return base64.b64decode(data)


def capture_chart_png(
    host: str = DEFAULT_CDP_HOST,
    port: int = DEFAULT_CDP_PORT,
    *,
    out_path: str | None = None,
) -> bytes:
    """Connect, screenshot chart tab, optionally write to disk. Returns PNG bytes."""
    with CdpSession(host, port) as cdp:
        png = cdp.capture_png()
    if out_path:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_bytes(png)
    return png


def health_check(host: str = DEFAULT_CDP_HOST, port: int = DEFAULT_CDP_PORT) -> dict:
    try:
        ver = requests.get(f"http://{host}:{port}/json/version", timeout=3).json()
        with CdpSession(host, port) as cdp:
            symbol = cdp.evaluate(
                f"(function(){{ try {{ return {CHART_API}.symbolInterval().symbol; }} catch(e) {{ return null; }} }})()"
            )
            return {"ok": True, "browser": ver.get("Browser"), "symbol": symbol}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def set_symbol(cdp: CdpSession, symbol: str) -> None:
    sym = symbol.replace("'", "\\'")
    cdp.evaluate(
        f"(function(){{ var chart = {CHART_API}; chart.setSymbol('{sym}', {{}}); return true; }})()",
        await_promise=False,
    )
    time.sleep(0.8)


def clear_all_shapes(cdp: CdpSession) -> None:
    cdp.evaluate(f"{CHART_API}.removeAllShapes()")


def remove_shapes(cdp: CdpSession, entity_ids: Sequence[str]) -> int:
    removed = 0
    for eid in entity_ids:
        if not eid:
            continue
        ok = cdp.evaluate(
            f"""
            (function() {{
              var api = {CHART_API};
              var eid = {json.dumps(eid)};
              var before = api.getAllShapes();
              var found = false;
              for (var i = 0; i < before.length; i++) {{ if (before[i].id === eid) {{ found = true; break; }} }}
              if (!found) return false;
              api.removeEntity(eid);
              return true;
            }})()
            """
        )
        if ok:
            removed += 1
    return removed


def _shape_ids(cdp: CdpSession) -> List[str]:
    return cdp.evaluate(f"{CHART_API}.getAllShapes().map(function(s){{ return s.id; }})") or []


# Any shape whose text matches these belongs to GLP and is safe to purge on redraw.
# This must cover every label build_action_draw_plan can emit or repeated draws
# stack duplicates; test_purge_pattern_covers_every_label guards that.
# The trailing legacy alternatives clean up shapes left by earlier versions.
GLP_TEXT_PATTERN = (
    r"^(FLIP |Struct flip |PIN |Pin |Call wall |Air pocket |Gamma containment "
    r"|\\+GEX|-GEX|LZ "
    r"|Asia (typical )?range |London (typical )?range |RTH (typical )?range "
    r"|.+ (POSITIVE|NEGATIVE) GAMMA|.+ AT THE FLIP"
    r"|Long reclaim |Short reject |HP/MHP |.+ plan: )"
)


def clear_glp_shapes(cdp: CdpSession) -> int:
    """Remove only GLP-authored shapes so repeated draws never stack duplicates."""
    removed = cdp.evaluate(
        f"""
        (function() {{
          var api = {CHART_API};
          var re = new RegExp("{GLP_TEXT_PATTERN}");
          var all = api.getAllShapes();
          var killed = 0;
          for (var i = 0; i < all.length; i++) {{
            var id = all[i].id;
            var txt = '';
            try {{
              var sh = api.getShapeById(id);
              var props = sh && sh.getProperties ? sh.getProperties() : null;
              if (props) txt = props.text || props.title || '';
            }} catch (e) {{}}
            if (txt && re.test(String(txt))) {{
              try {{ api.removeEntity(id); killed++; }} catch (e) {{}}
            }}
          }}
          return killed;
        }})()
        """
    )
    return int(removed or 0)


def _new_shape_id(cdp: CdpSession, before: Sequence[str]) -> Optional[str]:
    time.sleep(0.12)
    after = _shape_ids(cdp)
    new_ids = [i for i in after if i not in before]
    return new_ids[0] if new_ids else None


def draw_horizontal(cdp: CdpSession, level: DrawLevel, time_unix: int | None = None) -> Optional[str]:
    t = int(time_unix if time_unix is not None else time.time())
    overrides = {
        "linecolor": level.color,
        "linewidth": int(level.width),
        "linestyle": int(level.style),
        "showLabel": True,
        "textcolor": level.color,
        "text": level.label,
        "horzLabelsAlign": "right",
        "vertLabelsAlign": "middle",
    }
    before = _shape_ids(cdp)
    cdp.evaluate(
        f"""
        {CHART_API}.createShape(
          {{ time: {t}, price: {float(level.price)} }},
          {{ shape: 'horizontal_line', overrides: {json.dumps(overrides)}, text: {json.dumps(level.label)} }}
        )
        """
    )
    return _new_shape_id(cdp, before)


def draw_session_line(cdp: CdpSession, level: DrawLevel, t_open: int, t_close: int) -> Optional[str]:
    """Flat trend_line bounded to one session, instead of an infinite horizontal_line."""
    overrides = {
        "linecolor": level.color,
        "linewidth": int(level.width),
        "linestyle": int(level.style),
        "extendLeft": False,
        "extendRight": False,
        "leftEnd": 0,
        "rightEnd": 0,
        "showLabel": True,
        "textcolor": level.color,
        "text": level.label,
        "horzLabelsAlign": "right",
        "vertLabelsAlign": "top",
        "fontsize": 11,
        "bold": False,
    }
    before = _shape_ids(cdp)
    cdp.evaluate(
        f"""
        {CHART_API}.createMultipointShape(
          [
            {{ time: {int(t_open)}, price: {float(level.price)} }},
            {{ time: {int(t_close)}, price: {float(level.price)} }}
          ],
          {{ shape: 'trend_line', overrides: {json.dumps(overrides)}, text: {json.dumps(level.label)} }}
        )
        """
    )
    return _new_shape_id(cdp, before)


def draw_rectangle(
    cdp: CdpSession,
    zone: DrawZone,
    t1: int,
    t2: int,
) -> Optional[str]:
    overrides = {
        "color": zone.border,
        "backgroundColor": zone.fill,
        "fillBackground": True,
        "linewidth": 1,
        "transparency": 70,
        "showLabel": True,
        "text": zone.label,
        "textColor": zone.border,
    }
    before = _shape_ids(cdp)
    cdp.evaluate(
        f"""
        {CHART_API}.createMultipointShape(
          [
            {{ time: {int(t1)}, price: {float(zone.high)} }},
            {{ time: {int(t2)}, price: {float(zone.low)} }}
          ],
          {{ shape: 'rectangle', overrides: {json.dumps(overrides)}, text: {json.dumps(zone.label)} }}
        )
        """
    )
    return _new_shape_id(cdp, before)


def draw_text(cdp: CdpSession, text: str, price: float, time_unix: int, color: str = COLOR_TEXT) -> Optional[str]:
    overrides = {
        "color": color,
        "fontsize": 14,
        "bold": True,
        "drawBorder": False,
    }
    before = _shape_ids(cdp)
    cdp.evaluate(
        f"""
        {CHART_API}.createShape(
          {{ time: {int(time_unix)}, price: {float(price)} }},
          {{ shape: 'text', overrides: {json.dumps(overrides)}, text: {json.dumps(text)} }}
        )
        """
    )
    return _new_shape_id(cdp, before)


def get_visible_range(cdp: CdpSession) -> Tuple[int, int]:
    rng = cdp.evaluate(
        f"""
        (function() {{
          try {{
            var r = {CHART_API}.getVisibleRange();
            if (r && r.from && r.to) return {{from: r.from, to: r.to}};
          }} catch (e) {{}}
          return null;
        }})()
        """
    )
    now = int(time.time())
    if rng and rng.get("from") and rng.get("to"):
        return int(rng["from"]), int(rng["to"])
    return now - 3 * 86400, now + 86400


def resolve_tv_symbol(futures_code: str) -> str:
    code = (futures_code or "").strip().upper()
    return FUTURES_TV_SYMBOL.get(code, f"{code}1!" if code and not code.endswith("1!") else code)


def _prices_from_items(items: Sequence[Any]) -> List[float]:
    out = []
    for item in items or []:
        if isinstance(item, dict):
            val = item.get("price", item.get("strike"))
        else:
            val = item
        try:
            if val is not None:
                out.append(float(val))
        except Exception:
            continue
    return out


def _magnet_pairs(items: Sequence[Any]) -> List[Tuple[float, Optional[float]]]:
    """Preserve (price, gex_bn) from Futures Conversion so chart labels match the panel."""
    out: List[Tuple[float, Optional[float]]] = []
    seen = set()
    for item in items or []:
        if isinstance(item, dict):
            price = item.get("price", item.get("strike"))
            bn = item.get("gex_bn")
        else:
            price, bn = item, None
        try:
            if price is None:
                continue
            px = float(price)
        except (TypeError, ValueError):
            continue
        key = round(px, 4)
        if key in seen:
            continue
        seen.add(key)
        try:
            bn_f = None if bn is None else float(bn)
        except (TypeError, ValueError):
            bn_f = None
        out.append((px, bn_f))
    return out


def _fmt_px(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    if abs(value - round(value)) < 1e-6:
        return f"{value:.0f}"
    return f"{value:.2f}"


def _fmt_bn(bn: Optional[float]) -> str:
    if bn is None:
        return ""
    return f" ({bn:+.2f}bn)"


def _chart_banner(plan: ActionDrawPlan) -> str:
    """Compact on-chart headline. Full playbook stays in Action Center."""
    bits = [plan.plan_text.split(" | ")[0]] if plan.plan_text else []
    if plan.bias_headline:
        bits.append(plan.bias_headline)
    if plan.flip_level is not None:
        bits.append(f"invalid <{_fmt_px(plan.flip_level)}")
    if "FRAGILE" in (plan.plan_text or ""):
        bits.append("FRAGILE")
    elif "structure still constructive" in (plan.plan_text or ""):
        bits.append("recovering")
    # Keep it short enough that TradingView does not clip it into the legend.
    out = " | ".join(bits)
    return out if len(out) <= 90 else out[:87] + "..."


def _as_float(value: Any) -> Optional[float]:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _bias_for_levels(levels: Dict[str, Any], spot_f: Optional[float]):
    """Return the GammaBias for this snapshot, recomputing it if it was not supplied.

    The compute layer attaches a bias built from the full by-strike gamma frame.
    When a caller hands us a bare levels dict we fall back to the truncated
    magnet lists, which is less precise but keeps the plan regime-aware.
    """
    payload = levels.get("bias")
    if isinstance(payload, dict) and payload.get("regime"):
        return GammaBias(**{k: v for k, v in payload.items()
                            if k in GammaBias.__dataclass_fields__})
    return compute_bias(
        spot=spot_f,
        positives=levels.get("pos") or [],
        negatives=levels.get("neg") or [],
        flip=levels.get("flip"),
        struct_flip=levels.get("struct_flip"),
        horizon=str(levels.get("horizon") or "weekly"),
    )


def build_action_draw_plan(levels: Dict[str, Any], top_n_magnets: int = 5,
                           session_mode: str = "rth") -> ActionDrawPlan:
    """Build a regime-conditional action plan from a GLP levels snapshot.

    The gamma regime decides the shape of the plan, because the same level means
    opposite things on either side of the flip. Above it, dealer hedging damps
    moves, so edges are faded back toward the pin. Below it, hedging amplifies
    moves, so the same edge is a breakout trigger and fading it is the losing
    side of the trade. A plan that reads "long above / short below" regardless of
    regime is not reading the data; it is just restating the current price.
    """
    underlying = str(levels.get("underlying") or levels.get("symbol") or "SYM").upper()
    label_sym = str(levels.get("label_symbol") or underlying).upper()
    spot = levels.get("spot")
    if spot is None:
        spot = levels.get("anchor_spot")
    spot_f = float(spot) if spot is not None else None

    bias = _bias_for_levels(levels, spot_f)

    def in_band(p: Optional[float]) -> bool:
        if p is None:
            return False
        if spot_f is None:
            return True
        return abs(p - spot_f) <= spot_f * PLAN_BAND_PCT

    # Conversion magnets/zones are already top-N curated in the desktop panel —
    # draw them all so the chart matches Futures Conversion (band only trims
    # speculative containment boxes, not the listed levels).
    pos_pairs = _magnet_pairs(levels.get("pos") or [])
    neg_pairs = _magnet_pairs(levels.get("neg") or [])
    pos_pairs.sort(key=lambda t: (t[1] is None, -(t[1] or 0.0), -t[0]))
    neg_pairs.sort(key=lambda t: (t[1] is None, (t[1] or 0.0), t[0]))
    pos = [p for p, _ in pos_pairs]
    neg = [p for p, _ in neg_pairs]
    bn_by_price = {round(p, 4): bn for p, bn in pos_pairs + neg_pairs}
    zones = sorted({p for p in _prices_from_items(levels.get("zones") or [])})

    flip_f = bias.flip if bias.flip is not None else _as_float(levels.get("flip"))
    pin = bias.pin
    # Weak walls still belong on the chart (Action Center lists them); they just
    # must not drive long/short triggers in the plan text.
    call_wall = bias.call_wall
    put_wall = bias.put_wall
    call_wall_trigger = None if bias.call_wall_weak else bias.call_wall
    put_wall_trigger = None if bias.put_wall_weak else bias.put_wall

    # --- Regime decides which levels are triggers and which are targets ----
    if bias.regime == REGIME_POSITIVE:
        # Fade the edges, target the pin. The flip is the invalidation, not a trigger.
        long_level = put_wall_trigger if put_wall_trigger is not None else flip_f
        short_level = call_wall_trigger
        plan_bits = [f"{label_sym} POSITIVE GAMMA"]
        if pin is not None:
            plan_bits.append(f"pin {_fmt_px(pin)}")
        if short_level is not None and pin is not None:
            if same_level(short_level, pin):
                plan_bits.append(f"expect {_fmt_px(pin)} to cap")
            else:
                plan_bits.append(f"fade {_fmt_px(short_level)} -> {_fmt_px(pin)}")
        if put_wall_trigger is not None and pin is not None and not same_level(put_wall_trigger, pin):
            plan_bits.append(f"buy {_fmt_px(put_wall_trigger)} -> {_fmt_px(pin)}")
        if bias.air_pocket is not None:
            plan_bits.append(f"{_fmt_px(bias.air_pocket)} accelerates (not support)")
        if flip_f is not None:
            plan_bits.append(f"invalid <{_fmt_px(flip_f)}")
        plan_text = " | ".join(plan_bits)

    elif bias.regime == REGIME_NEGATIVE:
        # Follow the break. Reclaiming the flip is the long trigger; losing the
        # air pocket is the short trigger, because that is where negative dealer
        # gamma turns a decline into an acceleration.
        long_level = flip_f
        short_level = bias.air_pocket if bias.air_pocket is not None else (min(neg) if neg else None)
        plan_bits = [f"{label_sym} NEGATIVE GAMMA"]
        if long_level is not None:
            plan_bits.append(f"long on reclaim >{_fmt_px(long_level)}")
        if short_level is not None:
            plan_bits.append(f"short on loss <{_fmt_px(short_level)}")
        plan_bits.append("expansion expected - size down, do not fade")
        plan_text = " | ".join(plan_bits)

    else:
        long_level = flip_f
        short_level = flip_f
        plan_bits = [f"{label_sym} AT THE FLIP"]
        if flip_f is not None:
            plan_bits.append(f"pivot {_fmt_px(flip_f)}")
        plan_bits.append("range above / trend below - wait for acceptance")
        plan_text = " | ".join(plan_bits)

    # A regime the monthly book does not confirm is worth one word on the chart,
    # because it changes how long the plan is good for, not what the plan is.
    if bias.term_structure == TERM_FRAGILE:
        plan_text += " | STRUCTURALLY FRAGILE"
    elif bias.term_structure == TERM_RECOVERING:
        plan_text += " | structure still constructive"

    # --- Zones ------------------------------------------------------------
    raw_zones: List[DrawZone] = []
    band = bias.containment()
    if band and in_band(band[0]) and in_band(band[1]):
        raw_zones.append(
            DrawZone(
                band[1],
                band[0],
                f"Gamma containment {_fmt_px(band[0])}-{_fmt_px(band[1])}",
                COLOR_ZONE_POS,
                COLOR_ZONE_POS_BORDER,
            )
        )

    # Negative-gamma band below: where a break speeds up rather than stalls.
    # Keep it near spot. A pocket 500+ points away just paints a red slab at the
    # bottom of the pane and makes the near-price plan unreadable.
    deep = sorted({p for p in neg if spot_f is None or p < spot_f})
    if len(deep) >= 2 and spot_f is not None:
        lo, hi = deep[0], deep[1]
        near = abs(spot_f - hi) / max(spot_f, 1.0) <= 0.015
        tight = hi > lo and (hi - lo) / max(spot_f, 1.0) <= 0.03
        if near and tight:
            raw_zones.append(
                DrawZone(
                    hi,
                    lo,
                    f"Air pocket {_fmt_px(lo)}-{_fmt_px(hi)} (accelerates)",
                    COLOR_ZONE_NEG,
                    COLOR_ZONE_NEG_BORDER,
                )
            )

    draw_zones: List[DrawZone] = []
    for zone in sorted(raw_zones, key=lambda z: z.high - z.low):
        if any(zone.low < kept.high and zone.high > kept.low for kept in draw_zones):
            continue
        draw_zones.append(zone)
    draw_zones.sort(key=lambda z: z.high, reverse=True)

    # --- Lines ------------------------------------------------------------
    lines: List[DrawLevel] = []
    used = set()

    def add_line(price: Optional[float], label: str, color: str, width: int, style: int,
                 *, force: bool = False):
        if price is None:
            return
        if not force and not in_band(price):
            return
        key = round(float(price), 4)
        if key in used:
            # Same strike, second role (e.g. pin == put wall): merge into the
            # existing label instead of silently dropping Call/Put/GEX.
            for line in lines:
                if round(line.price, 4) != key:
                    continue
                role = (label.split() or [""])[0]
                if label not in line.label and role and role not in line.label:
                    merged = f"{line.label} · {label}"
                    line.label = merged if len(merged) <= 120 else (merged[:117] + "...")
                if width > line.width:
                    line.width = width
                    line.color = color
                    line.style = style
                return
            return
        used.add(key)
        lines.append(DrawLevel(float(price), label, color, width, style))

    # The flip is drawn first and always (even if far from spot): it is the level
    # that decides what every other level on the chart means. When monthly equals
    # near, say so on the label — otherwise traders hunt for a second line that
    # was never going to be drawn.
    if (
        bias.struct_flip is not None
        and flip_f is not None
        and same_level(bias.struct_flip, flip_f)
    ):
        add_line(flip_f, f"FLIP {_fmt_px(flip_f)} (near=monthly)", COLOR_HP, 3, 2,
                 force=True)
    else:
        add_line(flip_f, f"FLIP {_fmt_px(flip_f)} (regime line)", COLOR_HP, 3, 2,
                 force=True)

    # The monthly flip only goes on the chart when the two tenors were actually
    # comparable; on the 'all' horizon it is a copy of the line above.
    if bias.term_structure != TERM_UNKNOWN:
        add_line(
            bias.struct_flip,
            f"Struct flip {_fmt_px(bias.struct_flip)} (monthly)",
            COLOR_STRUCT_FLIP,
            1,
            2,
            force=True,
        )

    def _wall_tag(weak: bool) -> str:
        return " (weak)" if weak else ""

    def _bn_tag(attr: str) -> str:
        return _fmt_bn(getattr(bias, attr, None))

    if bias.regime == REGIME_POSITIVE:
        # Pin often IS the put-wall / call-wall strike. Spell every role on the
        # label so Futures Conversion walls are visible even when prices coincide.
        pin_roles = []
        if same_level(pin, call_wall_trigger or call_wall):
            pin_roles.append("call wall/cap")
        if same_level(pin, put_wall):
            pin_roles.append("+GEX shelf")
        if not pin_roles:
            pin_roles.append("target")
        add_line(
            pin,
            f"PIN {_fmt_px(pin)}{_bn_tag('pin_bn')} ({', '.join(pin_roles)})",
            COLOR_PIN,
            3,
            0,
            force=True,
        )
        add_line(
            call_wall,
            f"Call wall {_fmt_px(call_wall)}{_bn_tag('call_wall_bn')}"
            f"{_wall_tag(bias.call_wall_weak)} (fade short)",
            COLOR_SHORT,
            2,
            0 if not bias.call_wall_weak else 1,
            force=True,
        )
        add_line(
            put_wall,
            f"+GEX shelf {_fmt_px(put_wall)}{_bn_tag('put_wall_bn')}"
            f"{_wall_tag(bias.put_wall_weak)} (buy dip)",
            COLOR_LONG,
            2,
            0 if not bias.put_wall_weak else 1,
            force=True,
        )
        add_line(
            bias.air_pocket,
            f"Air pocket {_fmt_px(bias.air_pocket)}{_bn_tag('air_pocket_bn')} (not support)",
            COLOR_NEG_STRONG,
            2,
            1,
            force=True,
        )
    elif bias.regime == REGIME_NEGATIVE:
        add_line(
            bias.air_pocket,
            f"Air pocket {_fmt_px(bias.air_pocket)}{_bn_tag('air_pocket_bn')} (break = accelerate)",
            COLOR_SHORT,
            2,
            0,
            force=True,
        )
        add_line(
            call_wall,
            f"Call wall {_fmt_px(call_wall)}{_bn_tag('call_wall_bn')}"
            f"{_wall_tag(bias.call_wall_weak)} (reclaim = squeeze)",
            COLOR_LONG,
            1 if bias.call_wall_weak else 2,
            1 if bias.call_wall_weak else 0,
            force=True,
        )
        add_line(
            put_wall,
            f"+GEX shelf {_fmt_px(put_wall)}{_bn_tag('put_wall_bn')}"
            f"{_wall_tag(bias.put_wall_weak)} (only real support)",
            COLOR_POS,
            1 if bias.put_wall_weak else 2,
            1,
            force=True,
        )
        add_line(
            pin,
            f"Pin {_fmt_px(pin)}{_bn_tag('pin_bn')}",
            COLOR_PIN,
            2,
            1,
            force=True,
        )
    else:
        add_line(pin, f"Pin {_fmt_px(pin)}{_bn_tag('pin_bn')}", COLOR_PIN, 2, 1, force=True)
        add_line(
            call_wall,
            f"Call wall {_fmt_px(call_wall)}{_bn_tag('call_wall_bn')}{_wall_tag(bias.call_wall_weak)}",
            COLOR_SHORT,
            1,
            1,
            force=True,
        )
        add_line(
            put_wall,
            f"+GEX shelf {_fmt_px(put_wall)}{_bn_tag('put_wall_bn')}{_wall_tag(bias.put_wall_weak)}",
            COLOR_LONG,
            1,
            1,
            force=True,
        )

    # How far this session usually travels, from the measured table. Drawn as a
    # band around spot rather than a level: it is a distance, not a price the
    # market is aiming at, and nothing about it is directional.
    expect = expectation(
        levels.get("futures") or levels.get("underlying") or levels.get("symbol"),
        session_mode, bias.regime, spot_f,
    )
    band = expect.band(spot_f) if spot_f else None
    if band:
        low, high = band
        # Short label: the long "typical range 248 pts (n=89)" fought Flip/Pin
        # for the same right-edge slot and made every level unreadable.
        draw_zones.append(DrawZone(
            high=high, low=low,
            label=f"{expect.label.split(' ')[0]} range ~{expect.typical:,.0f}pts",
            fill=COLOR_ZONE_MID, border=COLOR_ZONE_MID_BORDER,
        ))
        draw_zones.sort(key=lambda z: z.high, reverse=True)

    zone_edges = {round(v, 4) for zone in draw_zones for v in (zone.high, zone.low)}

    # Magnets from Futures Conversion. Skip only prices already claimed by
    # Flip/Pin/walls (exact used[] keys) — fuzzy near_key was swallowing the
    # call-wall magnet next to Struct flip and looking like "no GEX on chart".
    magnet_cap = max(1, int(top_n_magnets))
    for p in pos[:magnet_cap]:
        if round(p, 4) in used or round(p, 4) in zone_edges:
            continue
        add_line(
            p,
            f"+GEX {_fmt_px(p)}{_fmt_bn(bn_by_price.get(round(p, 4)))}",
            COLOR_POS,
            2,
            0,
            force=True,
        )

    for p in neg[:magnet_cap]:
        if round(p, 4) in used or round(p, 4) in zone_edges:
            continue
        strong = any(abs(p - float(z)) <= max(0.5, abs(float(z)) * 0.00025)
                     for z in zones)
        add_line(
            p,
            f"{'-GEX / LZ' if strong else '-GEX'} {_fmt_px(p)}"
            f"{_fmt_bn(bn_by_price.get(round(p, 4)))}",
            COLOR_NEG_STRONG if strong else COLOR_NEG,
            2,
            0,
            force=True,
        )

    # Liquidity zones only when they are not already a magnet/key line.
    for z in zones:
        try:
            zp = float(z)
        except (TypeError, ValueError):
            continue
        if round(zp, 4) in used or round(zp, 4) in zone_edges:
            continue
        add_line(zp, f"LZ {_fmt_px(zp)}", COLOR_NEG, 1, 1, force=True)

    return ActionDrawPlan(
        symbol=str(levels.get("tv_symbol") or underlying),
        long_level=long_level,
        short_level=short_level,
        flip_level=flip_f,
        plan_text=plan_text,
        lines=lines,
        zones=draw_zones,
        regime=bias.regime,
        bias_headline=bias.headline,
        confidence=bias.confidence,
    )


def draw_converted_levels(
    levels: Dict[str, Any],
    *,
    host: str = DEFAULT_CDP_HOST,
    port: int = DEFAULT_CDP_PORT,
    switch_symbol: bool = True,
    clear_previous_ids: Sequence[str] | None = None,
    clear_all: bool = False,
    clear_glp: bool = True,
    top_n_magnets: int = 5,
    session_mode: str = "rth",
) -> dict:
    """Draw GLP levels in the QQQ action-plan visual style."""
    drawn: List[str] = []
    errors: List[str] = []
    purged = 0
    plan = build_action_draw_plan(levels, top_n_magnets=top_n_magnets,
                                  session_mode=session_mode)
    target_symbol = str(levels.get("tv_symbol") or plan.symbol)

    with CdpSession(host, port) as cdp:
        if switch_symbol and target_symbol:
            try:
                set_symbol(cdp, target_symbol)
            except Exception as exc:
                errors.append(f"set_symbol failed: {exc}")

        if clear_all:
            try:
                clear_all_shapes(cdp)
            except Exception as exc:
                errors.append(f"clear_all failed: {exc}")
        else:
            if clear_previous_ids:
                try:
                    remove_shapes(cdp, clear_previous_ids)
                except Exception as exc:
                    errors.append(f"clear_previous failed: {exc}")
            if clear_glp:
                try:
                    purged = clear_glp_shapes(cdp)
                except Exception as exc:
                    errors.append(f"clear_glp failed: {exc}")

        mode = (session_mode or "rth").strip().lower()
        if mode == "visible":
            box_left, box_right = get_visible_range(cdp)
            sess_key = "visible"
        else:
            # Use the prep-visible span so an upcoming Asia/London/RTH session still
            # paints over the live candles instead of only in empty future space.
            box_left, box_right = drawable_span(mode)
            sess_key = session_key(mode)

        # Zones first so lines/labels sit on top visually.
        for zone in plan.zones:
            try:
                eid = draw_rectangle(cdp, zone, box_left, box_right)
                if eid:
                    drawn.append(eid)
            except Exception as exc:
                errors.append(f"zone {zone.label}: {exc}")

        for lvl in plan.lines:
            try:
                # Horizontals for every level so Futures Conversion magnets keep
                # a price-axis label. Session rectangles still bound the range.
                eid = draw_horizontal(cdp, lvl, time_unix=box_right)
                if eid:
                    drawn.append(eid)
            except Exception as exc:
                errors.append(f"{lvl.label}: {exc}")

        # Short chart banner. The full playbook lives in Action Center; a long
        # string here collides with the OHLC legend and gets clipped.
        anchor = levels.get("spot") or plan.long_level or plan.flip_level
        text_price = None
        range_zones = [z for z in plan.zones if "range" in (z.label or "").lower()
                       and "air" not in (z.label or "").lower()]
        if range_zones:
            # Clear of the PIN and the range ceiling so the banner is not glued
            # onto the yellow target line.
            pad = max(30.0, (range_zones[0].high - range_zones[0].low) * 0.12)
            text_price = float(range_zones[0].high) + pad
        elif anchor is not None:
            text_price = float(anchor) * 1.0015
        banner = _chart_banner(plan)
        if text_price is not None and banner:
            try:
                text_time = box_left + max(60, (box_right - box_left) // 8)
                eid = draw_text(cdp, banner, text_price, text_time)
                if eid:
                    drawn.append(eid)
            except Exception as exc:
                errors.append(f"plan text: {exc}")

        symbol_now = None
        try:
            symbol_now = cdp.evaluate(
                f"(function(){{ try {{ return {CHART_API}.symbolInterval().symbol; }} catch(e) {{ return null; }} }})()"
            )
        except Exception:
            pass

    return {
        "success": len(drawn) > 0,
        "drawn_count": len(drawn),
        "purged_count": purged,
        "entity_ids": drawn,
        "symbol": symbol_now or target_symbol,
        "errors": errors,
        "session_mode": mode,
        "session_key": sess_key,
        "session_from": box_left,
        "session_to": box_right,
        "levels_attempted": len(plan.lines) + len(plan.zones) + 1,
        "labels": [l.label for l in plan.lines] + [z.label for z in plan.zones],
        "plan_text": plan.plan_text,
        "long_level": plan.long_level,
        "short_level": plan.short_level,
        "flip_level": plan.flip_level,
    }
