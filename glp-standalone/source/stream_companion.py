"""GLP Stream Companion — secondary program for YouTube / OBS play-by-play.

Serves an overlay + director desk that turns the live gamma map into a spoken
talk track (what to look for / how to read it). Educational framing only.

Usage
-----
  python source/stream_companion.py
  python source/stream_companion.py --port 8765 --symbol NQ --session rth

OBS Browser Source (transparent overlay):
  http://127.0.0.1:8765/?mode=overlay
  http://127.0.0.1:8765/?mode=lower

Director / teleprompter (on a second monitor):
  http://127.0.0.1:8765/?mode=desk

Optional: desktop app writes %APPDATA%\\GLP\\stream_state.json on convert;
this server will prefer that file when fresh, else pull UW via glp_pipeline.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from gex_talk_track import build_talk_track  # noqa: E402
from unusual_whales_gex import load_uw_api_key, user_config_dir  # noqa: E402

OVERLAY_HTML = (_HERE / "stream_overlay.html").read_text(encoding="utf-8")
STATE_PATH = Path(user_config_dir()) / "stream_state.json"
JOURNAL_PATH = Path(user_config_dir()) / "stream_journal.jsonl"

_ALIAS = {
    "NQ": "QQQ", "MNQ": "QQQ", "QQQ": "QQQ", "NDX": "NDX",
    "ES": "SPY", "MES": "SPY", "SPY": "SPY", "SPX": "SPX",
    "GC": "GLD", "MGC": "GLD", "GLD": "GLD",
}

_lock = threading.Lock()
_state: Dict[str, Any] = {
    "updated_at": None,
    "source": "boot",
    "symbol": "NQ",
    "session": "rth",
    "track": None,
    "bias": None,
    "levels": None,
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def _futures_of(underlying: str) -> str:
    return {
        "QQQ": "NQ", "NDX": "NQ",
        "SPY": "ES", "SPX": "ES",
        "GLD": "GC",
        "DIA": "YM",
        "IWM": "RTY",
    }.get(underlying, underlying)


def load_desktop_state(max_age_sec: float = 180.0) -> Optional[Dict[str, Any]]:
    if not STATE_PATH.is_file():
        return None
    try:
        age = time.time() - STATE_PATH.stat().st_mtime
        if age > max_age_sec:
            return None
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        data["source"] = f"desktop file ({int(age)}s old)"
        return data
    except Exception:
        return None


def write_state(payload: Dict[str, Any]) -> Path:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return STATE_PATH


def append_journal(payload: Dict[str, Any]) -> None:
    """Append a stream snapshot for later advisor research."""
    JOURNAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "symbol": payload.get("symbol"),
        "session": payload.get("session"),
        "regime": (payload.get("track") or {}).get("regime"),
        "term": (payload.get("track") or {}).get("term_structure"),
        "oneliner": (payload.get("track") or {}).get("oneliner"),
        "levels": (payload.get("track") or {}).get("levels"),
    }
    with JOURNAL_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")


def refresh_from_pipeline(symbol: str = "NQ", session: str = "rth") -> Dict[str, Any]:
    from glp_pipeline import run as pipeline_run

    raw = (symbol or "NQ").upper().replace("=F", "")
    underlying = _ALIAS.get(raw, raw)
    fut = _futures_of(underlying)
    snap = pipeline_run(
        underlying,
        horizon="weekly",
        target="futures",
        draw=False,
        session=session,
        switch_symbol=False,
        top_n=7,
    )
    levels = snap.get("levels") or {}
    bias = snap.get("bias") or levels.get("bias") or {}
    track = build_talk_track(
        bias,
        levels,
        futures=fut,
        session=session,
        scenarios=snap.get("scenarios"),
    )
    payload = {
        "updated_at": _now_iso(),
        "source": "pipeline",
        "symbol": fut,
        "underlying": underlying,
        "session": session,
        "track": track,
        "bias": bias,
        "levels": {
            k: levels.get(k)
            for k in ("spot", "flip", "struct_flip", "pos", "neg", "zones", "tv_symbol")
        },
    }
    write_state(payload)
    append_journal(payload)
    return payload


def build_from_desktop_dict(data: Dict[str, Any]) -> Dict[str, Any]:
    """Accept the shape written by gex_desktop_app (converted levels + bias)."""
    levels = data.get("futures_levels") or data.get("levels") or data
    bias = data.get("bias") or levels.get("bias") or {}
    session = str(data.get("session") or "rth")
    fut = str(data.get("futures") or levels.get("futures") or data.get("symbol") or "NQ")
    track = build_talk_track(
        bias if isinstance(bias, dict) else {},
        levels if isinstance(levels, dict) else {},
        futures=fut,
        session=session,
        scenarios=data.get("scenarios"),
    )
    return {
        "updated_at": _now_iso(),
        "source": data.get("source") or "desktop",
        "symbol": fut,
        "session": session,
        "track": track,
        "bias": bias,
        "levels": levels,
    }


def get_state(prefer_refresh: bool = False, symbol: str = "NQ", session: str = "rth") -> Dict[str, Any]:
    global _state
    with _lock:
        if prefer_refresh:
            _state = refresh_from_pipeline(symbol, session)
            return _state
        desktop = load_desktop_state()
        if desktop and desktop.get("track"):
            _state = desktop
            return _state
        if desktop and (desktop.get("bias") or desktop.get("futures_levels")):
            _state = build_from_desktop_dict(desktop)
            write_state(_state)
            return _state
        if _state.get("track"):
            return _state
        if load_uw_api_key():
            _state = refresh_from_pipeline(symbol, session)
        return _state


class Handler(BaseHTTPRequestHandler):
    server_version = "GLPStreamCompanion/1.0"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/", "/index.html", "/overlay"):
            self._send(200, OVERLAY_HTML.encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/api/state":
            st = get_state()
            self._send(200, json.dumps(st).encode("utf-8"), "application/json")
            return
        if path == "/api/health":
            body = {
                "ok": True,
                "uw": bool(load_uw_api_key()),
                "state_path": str(STATE_PATH),
                "has_track": bool((_state.get("track"))),
            }
            self._send(200, json.dumps(body).encode("utf-8"), "application/json")
            return
        self._send(404, b'{"error":"not found"}', "application/json")

    def do_POST(self) -> None:  # noqa: N802
        global _state
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send(400, b'{"error":"bad json"}', "application/json")
            return

        if path == "/api/refresh":
            sym = str(data.get("symbol") or _state.get("symbol") or "NQ")
            sess = str(data.get("session") or _state.get("session") or "rth")
            try:
                st = get_state(prefer_refresh=True, symbol=sym, session=sess)
                self._send(200, json.dumps(st).encode("utf-8"), "application/json")
            except Exception as exc:  # noqa: BLE001
                self._send(
                    500,
                    json.dumps({"error": str(exc)}).encode("utf-8"),
                    "application/json",
                )
            return

        if path == "/api/push":
            # Desktop / external tools can POST a converted snapshot.
            try:
                st = build_from_desktop_dict(data)
                with _lock:
                    _state = st
                write_state(st)
                append_journal(st)
                self._send(200, json.dumps(st).encode("utf-8"), "application/json")
            except Exception as exc:  # noqa: BLE001
                self._send(
                    500,
                    json.dumps({"error": str(exc)}).encode("utf-8"),
                    "application/json",
                )
            return

        self._send(404, b'{"error":"not found"}', "application/json")


def main(argv: Optional[list] = None) -> None:
    p = argparse.ArgumentParser(description="GLP Stream Companion")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--symbol", default="NQ")
    p.add_argument("--session", default="rth")
    p.add_argument("--no-boot-refresh", action="store_true")
    args = p.parse_args(argv)

    print("GLP Stream Companion")
    print(f"  desk:     http://{args.host}:{args.port}/?mode=desk")
    print(f"  OBS:      http://{args.host}:{args.port}/?mode=overlay")
    print(f"  lower:    http://{args.host}:{args.port}/?mode=lower")
    print(f"  state:    {STATE_PATH}")
    print(f"  journal:  {JOURNAL_PATH}")
    print("  Educational only — not financial advice.")

    if not args.no_boot_refresh:
        try:
            get_state(prefer_refresh=True, symbol=args.symbol, session=args.session)
            print("  boot refresh: ok")
        except Exception as exc:  # noqa: BLE001
            print(f"  boot refresh skipped: {exc}")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
