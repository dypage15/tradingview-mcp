import queue
import threading
import time
import tkinter as tk
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import requests
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure
import matplotlib as mpl

from theme import THEME, configure_styles, init_fonts

from glp_activation import license_banner, require_license, require_terms
from glp_license import is_unsigned_build

from discord_webhook import DiscordPoster, load_webhook_url, post_glp_snapshot
from gex_bias import bias_from_metrics, classify_term_structure
from gex_illustrate import render_scenario_map
from gex_refresh import DEFAULT_PLAN as REFRESH_PLAN
from gex_scenarios import build_card
from gex_core import (
    append_summary_log,
    apply_expiry_scope,
    assess_parity_state,
    compute_data_quality,
    compute_gex,
    compute_hedge_pressure,
    compute_liquidity_zones,
    infer_spot_from_options,
    split_expiry_groups,
)
from unusual_whales_gex import (
    DEFAULT_API_BASE_URL as UW_API_BASE_URL,
    DEFAULT_MCP_URL as UW_MCP_URL,
    fetch_and_compute_uw,
    infer_spot_from_exposures,
    load_uw_api_key,
)
from tv_cdp_draw import (
    draw_converted_levels,
    format_session,
    health_check as tv_health_check,
    resolve_tv_symbol,
    session_key,
)


CYBER = {
    "bg": THEME["bg_base"],
    "panel": THEME["bg_surface"],
    "panel_alt": THEME["bg_elevated"],
    "text": THEME["text_primary"],
    "muted": THEME["text_secondary"],
    "accent_cyan": THEME["cyan"],
    "accent_magenta": THEME["magenta"],
    "accent_green": THEME["green"],
    "accent_orange": THEME["yellow"],
    "accent_purple": THEME["purple"],
    "grid": THEME["grid"],
}
APP_VERSION = "v12.6-UW"
APP_NAME = "GLP LAUNCH"


FUTURES_CONVERSION_MAP = {
    "SPY": {"futures": "ES", "tick": 0.25},
    "SPX": {"futures": "ES", "tick": 0.25},
    "QQQ": {"futures": "NQ", "tick": 0.25},
    "NDX": {"futures": "NQ", "tick": 0.25},
    "GLD": {"futures": "GC", "tick": 0.1},
    "DIA": {"futures": "YM", "tick": 1.0},
    "IWM": {"futures": "RTY", "tick": 0.1},
}
YAHOO_FUTURES_SYMBOL = {
    "ES": "ES=F",
    "NQ": "NQ=F",
    "GC": "GC=F",
    "YM": "YM=F",
    "RTY": "RTY=F",
}

TICKER_PRESETS = {
    "Custom": None,
    "SPY (S&P 500 ETF)": "SPY",
    "SPX (Index Options)": "SPX",
    "QQQ (Nasdaq 100 ETF)": "QQQ",
    "DIA (Dow ETF)": "DIA",
    "IWM (Russell 2000 ETF)": "IWM",
    "GLD (Gold ETF)": "GLD",
    "ES -> SPY proxy": "SPY",
    "NQ -> QQQ proxy": "QQQ",
    "YM -> DIA proxy": "DIA",
    "GC -> GLD proxy": "GLD",
}


def get_data_mode_context(preset: str, underlying: str) -> dict:
    if "->" in preset:
        left, right = preset.split("->", 1)
        source_symbol = left.strip()
        proxy_symbol = right.split("proxy", 1)[0].strip()
        return {
            "mode": "Proxy",
            "confidence": "Medium",
            "source_symbol": source_symbol,
            "proxy_symbol": proxy_symbol,
            "message": f"Using {proxy_symbol} options chain as a proxy for {source_symbol}.",
        }
    return {
        "mode": "Direct",
        "confidence": "High",
        "source_symbol": underlying,
        "proxy_symbol": underlying,
        "message": f"Using direct options chain for {underlying}.",
    }


def build_action_center_text(
    bias,
    *,
    underlying: str,
    horizon: str,
    session_mode: str,
    future: str | None = None,
    future_price: float | None = None,
    weekly_exps: str = "n/a",
    monthly_exps: str = "n/a",
    liquidity_zones=None,
) -> str:
    """Action Center readout that matches what gets drawn on the charts.

    The old long-above/short-below template contradicted the regime-conditional
    plan on TradingView and the Live Dashboard. This is the same GammaBias the
    draw layer uses, plus the measured session widths.
    """
    lines: list[str] = []
    if bias is None:
        lines.append("Waiting for a gamma bias from the current book.")
    else:
        lines.extend(bias.summary_lines())
    lines.append("")
    lines.append(f"Horizon: {horizon}")
    lines.append(f"Weekly expiries: {weekly_exps}")
    lines.append(f"Monthly expiry: {monthly_exps}")
    if liquidity_zones is not None and getattr(liquidity_zones, "empty", True) is False:
        zone_text = ", ".join(f"{float(x):.0f}" for x in liquidity_zones["strike"].tolist())
        lines.append(f"Liquidity zones: {zone_text}")

    card_bias = bias
    card_price = future_price if future_price is not None else (getattr(bias, "spot", None) if bias else None)
    card_future = future or underlying
    if card_bias is not None and card_price is not None:
        try:
            card = build_card(card_bias, future=card_future, price=float(card_price))
            lines.append("")
            lines.extend(card.lines())
        except Exception:
            pass

    lines.append("")
    lines.append(
        f"Chart session: {session_mode.upper()}  |  levels drawn to match this plan. "
        "Use as decision support, not financial advice."
    )
    lines.append("")
    lines.extend(REFRESH_PLAN.summary_lines())
    return "\n".join(lines)


def _package_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _build_notifier(enabled: bool):
    if not enabled:
        return None
    try:
        from win10toast import ToastNotifier

        notifier = ToastNotifier()

        # win10toast is unstable on newer Windows/Python (WPARAM/LRESULT TypeError).
        # Wrap show_toast so toast failures never take down the live worker.
        _orig = notifier.show_toast

        def _safe_show_toast(*args, **kwargs):
            try:
                return _orig(*args, **kwargs)
            except Exception:
                return False

        notifier.show_toast = _safe_show_toast  # type: ignore[method-assign]
        return notifier
    except Exception:
        return None


@dataclass
class AppConfig:
    api_key: str
    api_base_url: str
    provider: str
    preset: str
    underlying: str
    spot: float | None
    auto_spot_open: bool
    auto_futures_convert: bool
    auto_draw_tv: bool
    redraw_tv_each_update: bool
    interval: int
    expiry_scope: str
    top_n: int
    alert_distance: float
    alert_cooldown: int
    toast: bool
    toast_duration: int
    log_csv: str


class GEXDesktopApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title(f"{APP_NAME} {APP_VERSION} - Gamma Liquidity Platform")
        self.root.geometry("1600x900")
        self.root.minsize(1200, 700)
        self.root.configure(bg=CYBER["bg"])
        self.fonts = init_fonts(self.root)

        self.worker_thread = None
        self.stop_event = threading.Event()
        self.ui_queue = queue.Queue()
        self.history = []
        self.compact_mode = False
        self.logo_photo = None
        self.last_payload = None
        self._first_live_cycle = True
        self._session_spot_locked = False
        self._session_anchor_spot = None
        self._futures_conversion_enabled = False
        self._last_converted_levels = None
        self._last_bias = None
        self._tv_drawn_entity_ids: list[str] = []
        self._tv_auto_draw_done = False
        self._tv_draw_in_flight = False
        self._tv_last_session_key = None

        self._configure_theme()
        self._setup_matplotlib_theme()
        self._build_ui()
        self._apply_futures_mapping(self.underlying_var.get())
        self._load_api_key_from_env()
        self.root.after(300, self._poll_queue)

    def _configure_theme(self):
        configure_styles(self.root, THEME, self.fonts)

    def _setup_matplotlib_theme(self):
        mpl.rcParams.update(
            {
                "figure.facecolor": THEME["bg_panel"],
                "axes.facecolor": THEME["bg_surface"],
                "axes.edgecolor": THEME["border"],
                "axes.labelcolor": THEME["text_secondary"],
                "axes.titlecolor": THEME["cyan"],
                "axes.grid": True,
                "grid.color": THEME["grid"],
                "grid.linewidth": 0.4,
                "grid.alpha": 0.4,
                "xtick.color": THEME["text_muted"],
                "ytick.color": THEME["text_muted"],
                "legend.facecolor": THEME["bg_elevated"],
                "legend.edgecolor": THEME["border"],
                "text.color": THEME["text_primary"],
                "font.family": "monospace",
                "font.monospace": ["Consolas", "Cascadia Code", "Courier New"],
            }
        )

    def _style_axes(self, ax):
        ax.set_facecolor(CYBER["panel"])
        ax.tick_params(colors=THEME["text_muted"], length=3, width=0.5)
        ax.xaxis.label.set_color(THEME["text_secondary"])
        ax.yaxis.label.set_color(THEME["text_secondary"])
        ax.title.set_color(CYBER["accent_cyan"])
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.spines["left"].set_color(THEME["border"])
        ax.spines["bottom"].set_color(THEME["border"])

    def _draw_vertical_gradient(self, canvas: tk.Canvas, color_top: str, color_bottom: str):
        canvas.delete("grad")
        w = max(canvas.winfo_width(), 2)
        h = max(canvas.winfo_height(), 2)

        def hex_to_rgb(hx: str):
            hx = hx.lstrip("#")
            return tuple(int(hx[i : i + 2], 16) for i in (0, 2, 4))

        r1, g1, b1 = hex_to_rgb(color_top)
        r2, g2, b2 = hex_to_rgb(color_bottom)
        for i in range(h):
            t = i / (h - 1)
            r = int(r1 + (r2 - r1) * t)
            g = int(g1 + (g2 - g1) * t)
            b = int(b1 + (b2 - b1) * t)
            color = f"#{r:02x}{g:02x}{b:02x}"
            canvas.create_line(0, i, w, i, fill=color, tags="grad")
        canvas.tag_lower("grad")

    def _add_axes_gradient(self, ax, x_min, x_max, y_min, y_max):
        grad = np.linspace(0, 1, 200).reshape(200, 1)
        ax.imshow(
            grad,
            extent=[x_min, x_max, y_min, y_max],
            aspect="auto",
            origin="lower",
            cmap=plt.matplotlib.colors.LinearSegmentedColormap.from_list(
                "cyber_grad", [CYBER["panel"], CYBER["panel_alt"]]
            ),
            alpha=0.55,
            zorder=0,
        )

    # Smallest shared window, as a fraction of spot either side of the midpoint.
    # Stops a quiet tape from shrinking the profile down to two or three bars.
    WINDOW_MIN_PCT = 0.0025

    def _shared_price_window(self, price_df, by_strike, spot, flip):
        """The price range the chart and the profile beside it both use.

        Framed on the price series, not on the levels. Structure is only ever
        included when it already falls inside that frame: stretching the window
        out to reach a magnet a few percent away buys one more bar in the profile
        and costs the entire shape of the session, which collapses to a flat
        line. Levels that fall outside are annotated by the callers instead.
        """
        spot = float(spot)
        lo = hi = spot
        if price_df is not None and not price_df.empty:
            lo = min(lo, float(price_df["close"].min()))
            hi = max(hi, float(price_df["close"].max()))

        pad = max((hi - lo) * 0.30, spot * 0.0008)
        lo, hi = lo - pad, hi + pad

        min_w = spot * self.WINDOW_MIN_PCT * 2
        if (hi - lo) < min_w:
            mid = (lo + hi) / 2.0
            lo, hi = mid - min_w / 2, mid + min_w / 2
        return lo, hi

    def _plot_with_glow(self, ax, x, y, color, linewidth=1.5, glow_alpha=0.15, n_glow=3, **kwargs):
        for i in range(n_glow, 0, -1):
            ax.plot(
                x,
                y,
                color=color,
                linewidth=linewidth + i * 2.0,
                alpha=glow_alpha / i,
                solid_capstyle="round",
                zorder=max(1, kwargs.get("zorder", 5) - 1),
            )
        ax.plot(x, y, color=color, linewidth=linewidth, solid_capstyle="round", **kwargs)

    def _build_ui(self):
        header = ttk.Frame(self.root, style="Elevated.TFrame", height=44)
        header.pack(fill="x", padx=8, pady=(8, 4))
        header.pack_propagate(False)
        ttk.Label(header, text=APP_NAME, style="Title.TLabel").pack(side="left", padx=(12, 8), pady=8)
        ttk.Label(header, text=f"Gamma Liquidity Platform {APP_VERSION.upper()}", style="Subtitle.TLabel").pack(side="left", pady=10)

        view_bar = ttk.Frame(self.root)
        view_bar.pack(fill="x", padx=8, pady=(0, 6))
        self.compact_btn = ttk.Button(view_bar, text="Compact Mode: Off", command=self._toggle_compact_mode)
        self.compact_btn.pack(side="right")

        self.controls_frame = ttk.LabelFrame(self.root, text="Settings")
        self.controls_frame.pack(fill="x", padx=8, pady=8)

        self.api_key_var = tk.StringVar()
        self.api_base_url_var = tk.StringVar(value=UW_API_BASE_URL)
        self.preset_var = tk.StringVar(value="SPY (S&P 500 ETF)")
        self.underlying_var = tk.StringVar(value="SPY")
        self.spot_var = tk.StringVar(value="")
        self.auto_spot_open_var = tk.BooleanVar(value=True)
        self.auto_futures_convert_var = tk.BooleanVar(value=True)
        self.auto_draw_tv_var = tk.BooleanVar(value=True)
        self.redraw_tv_each_update_var = tk.BooleanVar(value=False)
        # Chain refresh: OI is overnight, so 15-30 min is enough. See gex_refresh.
        self.interval_var = tk.StringVar(value="20")
        self.expiry_scope_var = tk.StringVar(value="all")
        self.top_n_var = tk.StringVar(value="7")
        self.alert_distance_var = tk.StringVar(value="8")
        self.alert_cooldown_var = tk.StringVar(value="90")
        self.toast_var = tk.BooleanVar(value=False)
        self.toast_duration_var = tk.StringVar(value="6")
        default_log = str(_package_root() / "saved_plots" / "uw_gex_log.csv")
        self.log_csv_var = tk.StringVar(value=default_log)
        self.show_levels_var = tk.BooleanVar(value=False)
        self.futures_symbol_var = tk.StringVar(value="")
        self.futures_open_var = tk.StringVar(value="")
        self.futures_status_var = tk.StringVar(value="No conversion mapping loaded yet.")
        self._futures_open_session_date = None
        self.tv_switch_symbol_var = tk.BooleanVar(value=True)
        self.tv_clear_previous_var = tk.BooleanVar(value=True)
        self.tv_draw_target_var = tk.StringVar(value="Futures")
        self.tv_session_mode_var = tk.StringVar(value="RTH")
        self.futures_ratio_mode_var = tk.StringVar(value="Live")
        self._futures_last_price = None
        self._futures_last_ts = 0.0
        self._futures_last_symbol = None
        self._futures_last_inflight = False
        self._futures_ratio_mode_used = "session open"

        row1 = ttk.Frame(self.controls_frame)
        row1.pack(fill="x", padx=6, pady=4)
        ttk.Label(row1, text="Unusual Whales API Key").pack(side="left")
        ttk.Entry(row1, textvariable=self.api_key_var, show="*", width=36).pack(side="left", padx=6)
        ttk.Label(row1, text="API Base").pack(side="left", padx=(8, 0))
        ttk.Entry(row1, textvariable=self.api_base_url_var, width=28).pack(side="left", padx=6)
        ttk.Label(row1, text="Preset").pack(side="left", padx=(8, 0))
        preset_combo = ttk.Combobox(
            row1,
            textvariable=self.preset_var,
            values=list(TICKER_PRESETS.keys()),
            state="readonly",
            width=20,
        )
        preset_combo.pack(side="left", padx=6)
        preset_combo.bind("<<ComboboxSelected>>", self._on_preset_selected)
        ttk.Label(row1, text="Underlying").pack(side="left", padx=(8, 0))
        ttk.Entry(row1, textvariable=self.underlying_var, width=8).pack(side="left", padx=6)
        ttk.Label(row1, text="Spot (opt)").pack(side="left", padx=(8, 0))
        ttk.Entry(row1, textvariable=self.spot_var, width=10).pack(side="left", padx=6)
        ttk.Button(row1, text="Auto Open Spot", command=self._set_spot_from_open_now).pack(side="left", padx=(4, 0))
        ttk.Label(row1, text="Interval(s)").pack(side="left", padx=(8, 0))
        ttk.Entry(row1, textvariable=self.interval_var, width=6).pack(side="left", padx=6)
        ttk.Label(row1, text="Horizon").pack(side="left", padx=(8, 0))
        ttk.Combobox(
            row1,
            textvariable=self.expiry_scope_var,
            values=["all", "weekly", "monthly"],
            state="readonly",
            width=10,
        ).pack(side="left", padx=6)

        row2 = ttk.Frame(self.controls_frame)
        row2.pack(fill="x", padx=6, pady=4)
        ttk.Label(row2, text="Top N").pack(side="left")
        ttk.Entry(row2, textvariable=self.top_n_var, width=6).pack(side="left", padx=6)
        ttk.Label(row2, text="Alert Dist").pack(side="left", padx=(8, 0))
        ttk.Entry(row2, textvariable=self.alert_distance_var, width=6).pack(side="left", padx=6)
        ttk.Label(row2, text="Cooldown(s)").pack(side="left", padx=(8, 0))
        ttk.Entry(row2, textvariable=self.alert_cooldown_var, width=6).pack(side="left", padx=6)
        ttk.Checkbutton(row2, text="Auto Spot(Open)", variable=self.auto_spot_open_var).pack(side="left", padx=(8, 0))
        ttk.Checkbutton(row2, text="Auto Futures Convert", variable=self.auto_futures_convert_var).pack(
            side="left", padx=(8, 0)
        )
        ttk.Checkbutton(row2, text="Auto Draw TV", variable=self.auto_draw_tv_var).pack(side="left", padx=(8, 0))
        ttk.Checkbutton(row2, text="Redraw each update", variable=self.redraw_tv_each_update_var).pack(
            side="left", padx=(8, 0)
        )
        ttk.Checkbutton(row2, text="Toast Alerts", variable=self.toast_var).pack(side="left", padx=(8, 0))
        ttk.Checkbutton(row2, text="Levels Overlay (Beta)", variable=self.show_levels_var).pack(side="left", padx=(8, 0))
        ttk.Label(row2, text="Toast Sec").pack(side="left", padx=(8, 0))
        ttk.Entry(row2, textvariable=self.toast_duration_var, width=6).pack(side="left", padx=6)

        row3 = ttk.Frame(self.controls_frame)
        row3.pack(fill="x", padx=6, pady=4)
        ttk.Label(row3, text="Log CSV").pack(side="left")
        ttk.Entry(row3, textvariable=self.log_csv_var, width=70).pack(side="left", padx=6)
        ttk.Button(row3, text="Browse", command=self._browse_log).pack(side="left")
        ttk.Button(row3, text="Revert Chart View", command=self._revert_chart_view).pack(side="left", padx=(6, 0))
        ttk.Button(row3, text="Start", command=self._start, style="Accent.TButton").pack(side="right", padx=3)
        ttk.Button(row3, text="Stop", command=self._stop, style="Danger.TButton").pack(side="right", padx=3)

        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(fill="both", expand=True, padx=8, pady=(0, 8))

        tab_live = ttk.Frame(self.notebook, style="Tab.TFrame")
        tab_action = ttk.Frame(self.notebook, style="Tab.TFrame")
        tab_sessions = ttk.Frame(self.notebook, style="Tab.TFrame")
        tab_mode = ttk.Frame(self.notebook, style="Tab.TFrame")
        tab_futures = ttk.Frame(self.notebook, style="Tab.TFrame")
        self.notebook.add(tab_live, text="Live Dashboard")
        self.notebook.add(tab_action, text="Action Center")
        self.notebook.add(tab_sessions, text="Session Map")
        self.notebook.add(tab_mode, text="Data Mode")
        self.notebook.add(tab_futures, text="Futures Conversion")

        status_frame = ttk.Frame(tab_live)
        status_frame.pack(fill="x", padx=2, pady=(0, 8))
        self.status_var = tk.StringVar(value="Idle")
        ttk.Label(status_frame, textvariable=self.status_var, font=self.fonts["mono_sm"]).pack(side="left")
        self.metrics_var = tk.StringVar(value="No data yet")
        ttk.Label(status_frame, textvariable=self.metrics_var, font=self.fonts["mono_xs"]).pack(side="left", padx=12)

        chart_frame = ttk.Frame(tab_live)
        chart_frame.pack(fill="both", expand=True, padx=2, pady=0)

        self.fig = Figure(figsize=(12, 8), dpi=100)
        self.fig.patch.set_facecolor(CYBER["bg"])
        # The strike profile sits beside the price panel and shares its price
        # axis, so a magnet reads straight across from the price it sits at.
        gs = self.fig.add_gridspec(2, 2, width_ratios=[3.2, 1.0], height_ratios=[2.1, 1.0])
        self.ax_price = self.fig.add_subplot(gs[0, 0])
        self.ax_profile = self.fig.add_subplot(gs[0, 1], sharey=self.ax_price)
        self.ax_total = self.fig.add_subplot(gs[1, :])
        self._style_axes(self.ax_price)
        self._style_axes(self.ax_profile)
        self._style_axes(self.ax_total)
        self.fig.tight_layout()

        self.canvas = FigureCanvasTkAgg(self.fig, master=chart_frame)
        self.canvas.draw()
        self.canvas.get_tk_widget().pack(fill="both", expand=True)

        plan_frame = ttk.LabelFrame(tab_action, text="What To Do Now")
        plan_frame.pack(fill="both", expand=True, padx=2, pady=(0, 8))
        self.plan_text = tk.Text(
            plan_frame,
            height=12,
            bg=CYBER["panel"],
            fg=CYBER["accent_green"],
            insertbackground=CYBER["accent_cyan"],
            relief="flat",
        )
        self.plan_text.pack(fill="both", expand=True)
        self.plan_text.insert("1.0", "Start stream to generate a live action plan.")

        text_frame = ttk.LabelFrame(tab_action, text="Alerts / Logs")
        text_frame.pack(fill="both", expand=True, padx=2, pady=0)
        self.log_text = tk.Text(
            text_frame,
            height=10,
            bg=CYBER["panel"],
            fg=CYBER["text"],
            insertbackground=CYBER["accent_cyan"],
            relief="flat",
        )
        self.log_text.pack(fill="both", expand=True)
        self.log_text.tag_configure("ALERT", foreground=CYBER["accent_magenta"])
        self.log_text.tag_configure("ERROR", foreground=CYBER["accent_orange"])

        # Session Map: how far each session has historically travelled from a
        # book that looks like today's. Sized from research/scenario_study.py.
        session_frame = ttk.Frame(tab_sessions)
        session_frame.pack(fill="both", expand=True, padx=2, pady=0)
        self.session_fig = Figure(figsize=(11, 6), dpi=100)
        self.session_fig.patch.set_facecolor(CYBER["bg"])
        self.session_canvas = FigureCanvasTkAgg(self.session_fig, master=session_frame)
        self.session_canvas.get_tk_widget().pack(fill="both", expand=True)
        self.session_notes = tk.Text(
            tab_sessions,
            height=7,
            bg=CYBER["panel"],
            fg=CYBER["text"],
            insertbackground=CYBER["accent_cyan"],
            wrap="word",
            relief="flat",
        )
        self.session_notes.pack(fill="x", padx=2, pady=(6, 2))
        self.session_notes.insert(
            "1.0", "Start the stream and convert to futures to size the sessions.")
        self._session_card = None

        mode_frame = ttk.LabelFrame(tab_mode, text="Data Source Clarity")
        mode_frame.pack(fill="both", expand=True, padx=2, pady=0)
        self.mode_badge_var = tk.StringVar(value="Mode: Direct")
        self.mode_confidence_var = tk.StringVar(value="Confidence: High")
        ttk.Label(
            mode_frame,
            textvariable=self.mode_badge_var,
            font=self.fonts["mono_lg"],
            foreground=CYBER["accent_cyan"],
        ).pack(anchor="w", padx=10, pady=(8, 2))
        ttk.Label(
            mode_frame,
            textvariable=self.mode_confidence_var,
            font=self.fonts["mono_sm"],
            foreground=CYBER["accent_green"],
        ).pack(anchor="w", padx=10, pady=(0, 8))
        self.mode_text = tk.Text(
            mode_frame,
            height=18,
            bg=CYBER["panel"],
            fg=CYBER["text"],
            insertbackground=CYBER["accent_cyan"],
            relief="flat",
        )
        self.mode_text.pack(fill="both", expand=True, padx=10, pady=(0, 10))

        futures_frame = ttk.LabelFrame(tab_futures, text="Proxy-to-Futures Mapping")
        futures_frame.pack(fill="x", padx=2, pady=(0, 8))
        futures_row = ttk.Frame(futures_frame)
        futures_row.pack(fill="x", padx=8, pady=8)
        ttk.Label(futures_row, text="Futures Symbol").pack(side="left")
        ttk.Entry(futures_row, textvariable=self.futures_symbol_var, width=10).pack(side="left", padx=6)
        ttk.Label(futures_row, text="Futures Session Open").pack(side="left", padx=(10, 0))
        ttk.Entry(futures_row, textvariable=self.futures_open_var, width=12).pack(side="left", padx=6)
        ttk.Button(futures_row, text="Fetch Open", command=self._set_futures_open_now).pack(side="left", padx=(6, 0))
        ttk.Button(futures_row, text="Start Conversion", command=self._activate_manual_futures_conversion).pack(
            side="left", padx=(8, 0)
        )
        ttk.Button(futures_row, text="Stop Conversion", command=self._deactivate_manual_futures_conversion).pack(
            side="left", padx=(6, 0)
        )
        ttk.Label(futures_row, text="Anchor").pack(side="left", padx=(10, 0))
        ttk.Combobox(
            futures_row,
            textvariable=self.futures_ratio_mode_var,
            values=["Live", "Session Open"],
            state="readonly",
            width=13,
        ).pack(side="left", padx=6)
        ttk.Label(
            futures_row,
            text="SPY/SPX->ES | QQQ/NDX->NQ | GLD->GC | DIA->YM | IWM->RTY",
        ).pack(side="left", padx=(12, 0))

        ttk.Label(futures_frame, textvariable=self.futures_status_var, font=self.fonts["mono_xs"]).pack(
            anchor="w", padx=10, pady=(0, 8)
        )

        tv_row = ttk.Frame(futures_frame)
        tv_row.pack(fill="x", padx=8, pady=(0, 8))
        ttk.Button(
            tv_row,
            text="Draw to TradingView",
            command=self._draw_converted_to_tradingview,
            style="Accent.TButton",
        ).pack(side="left")
        ttk.Label(tv_row, text="Target").pack(side="left", padx=(10, 0))
        ttk.Combobox(
            tv_row,
            textvariable=self.tv_draw_target_var,
            values=["Underlying", "Futures"],
            state="readonly",
            width=11,
        ).pack(side="left", padx=6)
        ttk.Label(tv_row, text="Session").pack(side="left", padx=(10, 0))
        ttk.Combobox(
            tv_row,
            textvariable=self.tv_session_mode_var,
            values=["RTH", "Asia", "London", "Globex", "Visible"],
            state="readonly",
            width=9,
        ).pack(side="left", padx=6)
        ttk.Checkbutton(tv_row, text="Switch chart symbol", variable=self.tv_switch_symbol_var).pack(
            side="left", padx=(10, 0)
        )
        ttk.Checkbutton(tv_row, text="Clear previous GLP drawings", variable=self.tv_clear_previous_var).pack(
            side="left", padx=(10, 0)
        )
        ttk.Label(tv_row, text="Action-plan style · CDP :9222").pack(side="left", padx=(12, 0))

        discord_row = ttk.Frame(futures_frame)
        discord_row.pack(fill="x", padx=8, pady=(0, 8))
        ttk.Label(discord_row, text="Discord webhook").pack(side="left")
        self.discord_webhook_var = tk.StringVar(value=load_webhook_url() or "")
        ttk.Entry(discord_row, textvariable=self.discord_webhook_var, width=52, show="*").pack(
            side="left", padx=6
        )
        self.discord_auto_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            discord_row, text="Auto-post on convert", variable=self.discord_auto_var
        ).pack(side="left", padx=(8, 0))
        ttk.Button(
            discord_row, text="Post to Discord", command=self._post_discord_now
        ).pack(side="left", padx=(8, 0))
        self._discord_poster = None

        futures_text_frame = ttk.LabelFrame(tab_futures, text="Converted Levels (Session Anchor)")
        futures_text_frame.pack(fill="both", expand=True, padx=2, pady=0)
        self.futures_text = tk.Text(
            futures_text_frame,
            height=20,
            bg=CYBER["panel"],
            fg=CYBER["text"],
            insertbackground=CYBER["accent_cyan"],
            relief="flat",
        )
        self.futures_text.pack(fill="both", expand=True)
        self.futures_text.insert("1.0", "Start stream to populate futures-converted levels.")
        self._create_status_bar()
        self._update_data_mode_panel()

    def _load_api_key_from_env(self):
        if self.api_key_var.get().strip():
            return
        uw_key = load_uw_api_key()
        if uw_key:
            self.api_key_var.set(uw_key)
            self.api_base_url_var.set(UW_API_BASE_URL)
            self._append_log("Unusual Whales API key loaded (env/file). MCP-compatible auth ready.")

    def _create_status_bar(self):
        self.status_bar = tk.Frame(self.root, bg=THEME["status_ok"], height=28)
        self.status_bar.pack(side="bottom", fill="x")
        self.status_bar.pack_propagate(False)
        self.status_left_var = tk.StringVar(value=" ●  idle")
        self.status_right_var = tk.StringVar(value="")
        self.status_left_label = tk.Label(
            self.status_bar,
            textvariable=self.status_left_var,
            fg=THEME["green"],
            bg=THEME["status_ok"],
            font=self.fonts["mono_sm"],
            anchor="w",
            padx=8,
        )
        self.status_left_label.pack(side="left", fill="x", expand=True)
        self.status_right_label = tk.Label(
            self.status_bar,
            textvariable=self.status_right_var,
            fg=THEME["text_muted"],
            bg=THEME["status_ok"],
            font=self.fonts["mono_xs"],
            anchor="e",
            padx=8,
        )
        self.status_right_label.pack(side="right")

    def _update_status_bar(self, quality):
        if quality is None:
            return
        if quality.degraded:
            if quality.chain_completeness < 0.8 or quality.gamma_fill_rate < 0.3:
                bg = THEME["status_error"]
                fg = THEME["red"]
                icon = "✖"
            else:
                bg = THEME["status_warn"]
                fg = THEME["yellow"]
                icon = "⚠"
        else:
            bg = THEME["status_ok"]
            fg = THEME["green"]
            icon = "●"
        self.status_bar.configure(bg=bg)
        self.status_left_label.configure(bg=bg, fg=fg)
        self.status_right_label.configure(bg=bg)
        fill_pct = f"{quality.gamma_fill_rate:.0%}"
        chain_pct = f"{quality.chain_completeness:.0%}"
        text = (
            f" {icon}  {self.underlying_var.get().strip().upper()}  ·  "
            f"{quality.usable_contract_count} contracts  ·  γ {fill_pct}  ·  chain {chain_pct}  ·  "
            f"parity {quality.parity_state}"
        )
        if quality.degraded and quality.degraded_reasons:
            text += f"  ·  {quality.degraded_reasons[0]}"
        self.status_left_var.set(text)
        try:
            ts = datetime.fromisoformat(quality.fetch_timestamp_utc).strftime("%H:%M:%S")
        except Exception:
            ts = datetime.now().strftime("%H:%M:%S")
        self.status_right_var.set(f"updated {ts} UTC")

    def _toggle_compact_mode(self):
        self.compact_mode = not self.compact_mode
        if self.compact_mode:
            self.controls_frame.pack_forget()
            self.compact_btn.configure(text="Compact Mode: On")
            self._append_log("Compact mode enabled.")
        else:
            self.controls_frame.pack(fill="x", padx=8, pady=8, before=self.notebook)
            self.compact_btn.configure(text="Compact Mode: Off")
            self._append_log("Compact mode disabled.")

    def _browse_log(self):
        path = filedialog.asksaveasfilename(
            title="Select log CSV path",
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
        if path:
            self.log_csv_var.set(path)

    def _read_config(self) -> AppConfig:
        spot_raw = self.spot_var.get().strip()
        spot_value = None if spot_raw == "" else float(spot_raw)
        provider = "unusual_whales"
        api_key_value = self.api_key_var.get().strip() or load_uw_api_key()
        api_base = self.api_base_url_var.get().strip() or UW_API_BASE_URL
        return AppConfig(
            api_key=api_key_value,
            api_base_url=api_base,
            provider=provider,
            preset=self.preset_var.get().strip(),
            underlying=self.underlying_var.get().strip().upper(),
            spot=spot_value,
            auto_spot_open=bool(self.auto_spot_open_var.get()),
            auto_futures_convert=bool(self.auto_futures_convert_var.get()),
            auto_draw_tv=bool(self.auto_draw_tv_var.get()),
            redraw_tv_each_update=bool(self.redraw_tv_each_update_var.get()),
            interval=max(1, int(self.interval_var.get().strip())),
            expiry_scope=self.expiry_scope_var.get().strip().lower(),
            top_n=max(1, int(self.top_n_var.get().strip())),
            alert_distance=float(self.alert_distance_var.get().strip()),
            alert_cooldown=max(1, int(self.alert_cooldown_var.get().strip())),
            toast=bool(self.toast_var.get()),
            toast_duration=max(1, int(self.toast_duration_var.get().strip())),
            log_csv=self.log_csv_var.get().strip(),
        )

    def _on_preset_selected(self, _event=None):
        selected = self.preset_var.get().strip()
        mapped = TICKER_PRESETS.get(selected)
        if mapped:
            self.underlying_var.set(mapped)
            self._append_log(f"Preset selected: {selected} -> {mapped}")
            self._apply_futures_mapping(mapped)
        self._update_data_mode_panel()

    def _apply_futures_mapping(self, underlying: str):
        key = (underlying or "").strip().upper()
        mapping = FUTURES_CONVERSION_MAP.get(key)
        if mapping:
            self.futures_symbol_var.set(mapping["futures"])
            self.futures_status_var.set(
                f"Mapped {key} -> {mapping['futures']}. Auto Convert on Start, or Fetch Open + Start Conversion."
            )
        else:
            self.futures_status_var.set(f"No futures mapping configured for {key or 'ticker'}.")
        self._futures_conversion_enabled = False
        self._futures_open_session_date = None

    def _fetch_yahoo_futures_open(self, futures_symbol: str):
        yf_symbol = YAHOO_FUTURES_SYMBOL.get((futures_symbol or "").strip().upper())
        if not yf_symbol:
            return None
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yf_symbol}"
        # Prefer multi-day so we still get a session open around weekends/holidays.
        for range_val in ("5d", "1d"):
            try:
                resp = requests.get(
                    url,
                    params={"interval": "1d", "range": range_val},
                    timeout=12,
                    headers={"User-Agent": "GLP/1.0"},
                )
                if not resp.ok:
                    continue
                chart = (resp.json() or {}).get("chart", {})
                result = (chart.get("result") or [None])[0] or {}
                meta = result.get("meta") or {}
                quote = ((result.get("indicators") or {}).get("quote") or [None])[0] or {}
                opens = [x for x in (quote.get("open") or []) if x is not None]
                if opens:
                    return float(opens[-1])
                # Fallback: chart meta sometimes exposes regular-session open.
                for key in ("chartPreviousClose", "previousClose", "regularMarketPrice"):
                    val = meta.get(key)
                    if val is not None:
                        try:
                            return float(val)
                        except Exception:
                            pass
            except Exception:
                continue
        return None

    def _refresh_futures_last_async(self, fut_symbol: str, max_age_s: float = 30.0):
        """Keep self._futures_last_price warm without blocking the Tk thread."""
        now = time.time()
        if self._futures_last_symbol != fut_symbol:
            self._futures_last_price = None
            self._futures_last_ts = 0.0
            self._futures_last_symbol = fut_symbol
        if self._futures_last_inflight or (now - self._futures_last_ts) < max_age_s:
            return
        self._futures_last_inflight = True

        def worker():
            price = None
            try:
                price = self._fetch_yahoo_futures_last(fut_symbol)
            finally:
                if price:
                    self._futures_last_price = price
                    self._futures_last_ts = time.time()
                self._futures_last_inflight = False

        threading.Thread(target=worker, daemon=True).start()

    def _fetch_yahoo_futures_last(self, futures_symbol: str):
        yf_symbol = YAHOO_FUTURES_SYMBOL.get((futures_symbol or "").strip().upper())
        if not yf_symbol:
            return None
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yf_symbol}"
        try:
            resp = requests.get(
                url,
                params={"interval": "1m", "range": "1d"},
                timeout=12,
                headers={"User-Agent": "GLP/1.0"},
            )
            if not resp.ok:
                return None
            result = (((resp.json() or {}).get("chart") or {}).get("result") or [None])[0] or {}
            meta = result.get("meta") or {}
            for key in ("regularMarketPrice", "previousClose", "chartPreviousClose"):
                val = meta.get(key)
                if val:
                    return float(val)
        except Exception:
            return None
        return None

    def _set_futures_open_now(self):
        fut = self.futures_symbol_var.get().strip().upper()
        if not fut:
            messagebox.showwarning("Missing futures symbol", "Enter a futures symbol first (e.g., ES, NQ, GC).")
            return
        value = self._fetch_yahoo_futures_open(fut)
        if value is None:
            self._append_log("ERROR: Could not auto-fetch futures session open. Enter manually.")
            messagebox.showwarning("Futures open fetch failed", "Could not fetch futures open. Enter it manually.")
            return
        self.futures_open_var.set(f"{value:.2f}")
        self._futures_open_session_date = datetime.now().date()
        self._append_log(f"Futures open set: {fut} = {value:.2f} (Yahoo {YAHOO_FUTURES_SYMBOL.get(fut, fut)})")

    def _auto_enable_futures_conversion(self, underlying: str | None = None) -> bool:
        """Fetch today's futures session open and enable conversion. Returns True on success."""
        key = (underlying or self.underlying_var.get() or "").strip().upper()
        mapping = FUTURES_CONVERSION_MAP.get(key)
        if not mapping:
            self._append_log(f"Auto Futures Convert skipped: no mapping for {key or 'ticker'}.")
            return False
        fut = (self.futures_symbol_var.get() or mapping["futures"]).strip().upper()
        self.futures_symbol_var.set(fut)
        value = self._fetch_yahoo_futures_open(fut)
        if value is None:
            self._append_log(
                f"ERROR: Auto Futures Convert failed to fetch {fut} session open. "
                "Use Fetch Open / enter manually, then Start Conversion."
            )
            self.futures_status_var.set(f"Auto-fetch failed for {fut}. Enter open manually.")
            return False
        self.futures_open_var.set(f"{value:.2f}")
        self._futures_open_session_date = datetime.now().date()
        self._futures_conversion_enabled = True
        self.futures_status_var.set(f"Auto conversion ON for {key}->{fut} @ open {value:.2f}")
        self._append_log(f"Auto Futures Convert enabled: {key}->{fut} open={value:.2f}")
        return True

    def _activate_manual_futures_conversion(self):
        fut = self.futures_symbol_var.get().strip().upper()
        if not fut:
            messagebox.showwarning("Missing futures symbol", "Enter a futures symbol first (e.g., ES, NQ, GC).")
            return
        try:
            float(self.futures_open_var.get().strip())
        except Exception:
            messagebox.showwarning("Missing futures open", "Enter a valid futures session open price first.")
            return
        self._futures_conversion_enabled = True
        self.futures_status_var.set(f"Manual conversion enabled for {fut}.")
        self._append_log(f"Manual futures conversion started for {fut}.")
        # Refresh immediately from latest live payload (don't wait for next poll).
        if self.last_payload is not None:
            try:
                self._update_futures_conversion(self.last_payload)
            except Exception as exc:
                self._append_log(f"ERROR: Futures conversion refresh failed: {exc}")

    def _deactivate_manual_futures_conversion(self):
        self._futures_conversion_enabled = False
        self.futures_status_var.set("Manual conversion stopped. Enter futures open and click Start Conversion.")
        self._append_log("Manual futures conversion stopped.")
        self.futures_text.delete("1.0", "end")
        self.futures_text.insert(
            "1.0",
            "Manual mode:\n1) Enter futures open\n2) Click Start Conversion\n3) Converted levels will appear here.",
        )

    def _round_to_tick(self, value: float, tick: float) -> float:
        if tick <= 0:
            return float(value)
        return round(round(float(value) / tick) * tick, 6)

    def _extract_zone_strikes(self, payload) -> list[float]:
        zones_obj = payload.get("liquidity_zones")
        if zones_obj is None:
            return []
        try:
            if isinstance(zones_obj, pd.DataFrame):
                if zones_obj.empty or "strike" not in zones_obj.columns:
                    return []
                return [float(x) for x in zones_obj["strike"].dropna().tolist()]
            if isinstance(zones_obj, dict) and "strike" in zones_obj:
                return [float(x) for x in list(zones_obj.get("strike") or [])]
            if isinstance(zones_obj, (list, tuple)):
                return [float(x) for x in zones_obj]
        except Exception:
            return []
        return []

    def _update_futures_conversion(self, payload, trigger_auto_draw: bool = True):
        if not payload:
            return
        metrics = payload.get("metrics") or {}
        pressure = payload.get("hedge_pressure") or {}
        underlying = self.underlying_var.get().strip().upper()
        mapping = FUTURES_CONVERSION_MAP.get(underlying)
        if not mapping:
            self.futures_text.delete("1.0", "end")
            self.futures_text.insert("1.0", f"No configured mapping for {underlying}.")
            self.futures_status_var.set(f"No futures mapping configured for {underlying}.")
            return

        if not self.futures_symbol_var.get().strip():
            self.futures_symbol_var.set(mapping["futures"])
        fut_symbol = self.futures_symbol_var.get().strip().upper()

        if not self._futures_conversion_enabled:
            self.futures_text.delete("1.0", "end")
            self.futures_text.insert(
                "1.0",
                "Manual mode:\n1) Enter futures open\n2) Click Start Conversion\n3) Converted levels will appear here.",
            )
            return

        try:
            fut_open = float(self.futures_open_var.get().strip())
        except Exception:
            fut_open = None

        anchor_spot = self._session_anchor_spot
        if anchor_spot is None:
            anchor_spot = metrics.get("spot")
        try:
            anchor_spot = float(anchor_spot) if anchor_spot is not None else None
        except Exception:
            anchor_spot = None
        if not anchor_spot:
            self.futures_text.delete("1.0", "end")
            self.futures_text.insert("1.0", "Waiting for session anchor spot.")
            return

        if fut_open is None:
            self.futures_status_var.set(
                f"{underlying}->{fut_symbol} mapped. Enter futures open and click Start Conversion."
            )
            self.futures_text.delete("1.0", "end")
            self.futures_text.insert(
                "1.0",
                f"Underlying anchor spot: {anchor_spot:.2f}\n"
                f"Futures open missing for {fut_symbol}.",
            )
            return

        if float(anchor_spot) == 0.0:
            self.futures_text.delete("1.0", "end")
            self.futures_text.insert("1.0", "ERROR: Session anchor spot is zero; cannot convert.")
            return

        ratio = float(fut_open) / float(anchor_spot)
        ratio_mode = "session open"
        if (self.futures_ratio_mode_var.get() or "").strip().lower().startswith("live"):
            self._refresh_futures_last_async(fut_symbol)
            live_spot = metrics.get("spot")
            fut_last = self._futures_last_price
            try:
                live_spot = float(live_spot) if live_spot is not None else None
            except Exception:
                live_spot = None
            if fut_last and live_spot:
                # Anchoring on simultaneous prices keeps converted spot on top of the
                # real futures print; session-open anchoring drifts because cash and
                # Globex opens are hours apart.
                ratio = float(fut_last) / live_spot
                ratio_mode = "live"
        self._futures_ratio_mode_used = ratio_mode
        tick = float(mapping["tick"])

        def convert(level):
            if level is None:
                return None
            try:
                return self._round_to_tick(float(level) * ratio, tick)
            except Exception:
                return None

        struct_flip = convert(pressure.get("mhp_level"))
        flip = convert(metrics.get("zero_gamma"))
        spot_conv = convert(metrics.get("spot"))
        zones = [z for z in (convert(x) for x in self._extract_zone_strikes(payload)) if z is not None]
        horizon = (metrics.get("expiry_scope") or self.expiry_scope_var.get() or "all").strip().lower()

        try:
            magnet_n = max(5, int(self.top_n_var.get().strip() or "7"))
        except Exception:
            magnet_n = 7

        def _fmt_magnet_frame(frame, n=magnet_n):
            if frame is None:
                return []
            try:
                out = []
                for row in frame.head(n).itertuples():
                    conv = convert(getattr(row, "strike", None))
                    if conv is None:
                        continue
                    bn = getattr(row, "gex_bn", None)
                    if bn is None:
                        out.append(f"{conv:.2f}")
                    else:
                        out.append(f"{conv:.2f} ({float(bn):+.3f}bn)")
                return out
            except Exception:
                return []

        pos_conv = _fmt_magnet_frame(metrics.get("top_positive"))
        neg_conv = _fmt_magnet_frame(metrics.get("top_negative"))

        pos_levels = []
        neg_levels = []
        # Underlying (ETF/index) prices for QQQ-style action plan draws.
        und_pos = []
        und_neg = []
        try:
            for row in (metrics.get("top_positive") or []).head(magnet_n).itertuples():
                bn = float(getattr(row, "gex_bn", 0.0) or 0.0)
                und_pos.append({"price": float(row.strike), "strike": float(row.strike), "gex_bn": bn})
                conv = convert(getattr(row, "strike", None))
                if conv is not None:
                    pos_levels.append({"price": float(conv), "strike": float(row.strike), "gex_bn": bn})
            for row in (metrics.get("top_negative") or []).head(magnet_n).itertuples():
                bn = float(getattr(row, "gex_bn", 0.0) or 0.0)
                und_neg.append({"price": float(row.strike), "strike": float(row.strike), "gex_bn": bn})
                conv = convert(getattr(row, "strike", None))
                if conv is not None:
                    neg_levels.append({"price": float(conv), "strike": float(row.strike), "gex_bn": bn})
        except Exception:
            pass

        # The bias is computed once on the underlying, where the full by-strike
        # gamma frame is available, then expressed in futures prices. Regime and
        # direction are scale invariant; only the level numbers change.
        try:
            bias = bias_from_metrics(
                metrics,
                pressure,
                horizon=horizon,
                degraded=bool(getattr(payload.get("quality"), "degraded", False)),
            )
        except Exception:
            bias = None
        bias_fut = bias.rescale(ratio, tick) if bias is not None else None
        self._last_bias = bias
        und_zones = self._extract_zone_strikes(payload)
        und_struct_flip = pressure.get("mhp_level")
        und_flip = metrics.get("zero_gamma")
        und_spot = metrics.get("spot")

        self._last_converted_levels = {
            "underlying": underlying,
            "futures": fut_symbol,
            "horizon": horizon,
            "anchor_spot": float(anchor_spot),
            "fut_open": float(fut_open),
            "ratio": float(ratio),
            # Futures-converted snapshot
            "futures_levels": {
                "underlying": underlying,
                "futures": fut_symbol,
                "label_symbol": fut_symbol,
                "tv_symbol": resolve_tv_symbol(fut_symbol),
                "horizon": horizon,
                "spot": spot_conv,
                "anchor_spot": float(fut_open),
                "flip": flip,
                "struct_flip": struct_flip,
                "zones": zones,
                "pos": pos_levels,
                "neg": neg_levels,
                "bias": bias_fut.to_dict() if bias_fut is not None else None,
            },
            # Underlying snapshot (matches reference QQQ plan style)
            "underlying_levels": {
                "underlying": underlying,
                "futures": fut_symbol,
                "label_symbol": underlying,
                "tv_symbol": underlying,
                "horizon": horizon,
                "spot": und_spot,
                "anchor_spot": float(anchor_spot),
                "flip": und_flip,
                "struct_flip": und_struct_flip,
                "zones": und_zones,
                "pos": und_pos,
                "neg": und_neg,
                "bias": bias.to_dict() if bias is not None else None,
            },
            # Default convenience fields = futures converted
            "tv_symbol": resolve_tv_symbol(fut_symbol),
            "spot": spot_conv,
            "flip": flip,
            "struct_flip": struct_flip,
            "zones": zones,
            "pos": pos_levels,
            "neg": neg_levels,
            "bias": bias_fut.to_dict() if bias_fut is not None else None,
        }

        lines = [
            f"Underlying: {underlying}  ->  Futures: {fut_symbol}  (TV {resolve_tv_symbol(fut_symbol)})",
            f"Horizon: {horizon}",
            f"Session anchor spot: {float(anchor_spot):.2f}",
            f"Futures open anchor: {float(fut_open):.2f}",
            f"Conversion ratio: {ratio:.6f} ({ratio_mode} anchor)   |   Tick: {tick}",
            "",
            f"Spot (converted): {spot_conv:.2f}" if spot_conv is not None else "Spot (converted): n/a",
            f"Flip near-dated (converted): {flip:.2f}" if flip is not None else "Flip near-dated (converted): n/a",
            f"Flip monthly (converted): {struct_flip:.2f}"
            if struct_flip is not None
            else "Flip monthly (converted): n/a",
        ]
        if pos_conv:
            lines.append(f"+GEX magnets (converted): {', '.join(pos_conv)}")
        if neg_conv:
            lines.append(f"-GEX zones (converted): {', '.join(neg_conv)}")
        if zones:
            lines.append(
                f"Liquidity zones (converted): {', '.join(f'{z:.2f}' for z in zones)}"
            )
        if bias_fut is not None:
            lines.append("")
            lines.append("-" * 60)
            lines.extend(bias_fut.summary_lines())
            lines.append("-" * 60)
            self._update_session_map(bias_fut, fut_symbol, spot_conv)
            # Action Center should quote futures prices once conversion is live,
            # so it matches the NQ/ES drawings rather than the ETF book.
            if self.last_payload is not None:
                self._refresh_action_center(self.last_payload)
            if bool(self.discord_auto_var.get()):
                self._post_discord_now(silent=True)
            self._push_stream_companion(silent=True)
        lines.append("")
        lines.append(
            f"Auto pipeline: {underlying}->{fut_symbol}->{resolve_tv_symbol(fut_symbol)} | "
            "Auto Draw TV uses Futures target."
        )
        lines.append("Manual: click 'Draw to TradingView' anytime.")
        self.futures_text.delete("1.0", "end")
        self.futures_text.insert("1.0", "\n".join(lines))
        self.futures_status_var.set(
            f"Converted {underlying}->{fut_symbol} ({horizon}) ready for {resolve_tv_symbol(fut_symbol)}."
        )
        if trigger_auto_draw:
            self._maybe_auto_draw_tv()

    def _discord_snapshot(self) -> dict:
        """Bundle the last conversion into the shape discord_webhook expects."""
        levels = self._last_converted_levels or {}
        fut = levels.get("futures_levels") or levels
        card = getattr(self, "_session_card", None)
        return {
            "underlying": levels.get("underlying") or self.underlying_var.get(),
            "futures": levels.get("futures") or self.futures_symbol_var.get(),
            "levels": fut,
            "bias": fut.get("bias") or levels.get("bias"),
            "scenarios": card.to_dict() if card is not None and hasattr(card, "to_dict") else None,
            "session": {"mode": self._tv_session_mode()},
            "plan": {},
        }

    def _push_stream_companion(self, silent: bool = False):
        """Write / POST talk-track state for the YouTube stream companion."""
        if not self._last_converted_levels:
            return
        try:
            from stream_companion import STATE_PATH, build_from_desktop_dict, write_state
        except Exception as exc:
            if not silent:
                self._append_log(f"Stream companion import failed: {exc}")
            return

        snap = self._discord_snapshot()
        snap["session"] = self._tv_session_mode()
        # Flatten for build_from_desktop_dict
        payload = {
            "futures_levels": snap.get("levels"),
            "bias": snap.get("bias"),
            "futures": snap.get("futures"),
            "session": snap.get("session") if isinstance(snap.get("session"), str)
            else (snap.get("session") or {}).get("mode", "rth"),
            "scenarios": snap.get("scenarios"),
            "source": "desktop",
        }
        try:
            st = build_from_desktop_dict(payload)
            write_state(st)
            # Best-effort live push if companion is running.
            try:
                import requests

                requests.post(
                    "http://127.0.0.1:8765/api/push",
                    json=st,
                    timeout=1.5,
                )
            except Exception:
                pass
            if not silent:
                self._append_log(f"Stream companion state → {STATE_PATH}")
        except Exception as exc:
            self._append_log(f"Stream companion push failed: {exc}")

    def _post_discord_now(self, silent: bool = False):
        url = (self.discord_webhook_var.get() or "").strip() or load_webhook_url()
        if not url:
            if not silent:
                messagebox.showwarning(
                    "Discord",
                    "Paste a Discord webhook URL, or set GLP_DISCORD_WEBHOOK in the environment.",
                )
            return
        if not self._last_converted_levels:
            if not silent:
                messagebox.showwarning("Discord", "Convert futures levels first, then post.")
            return
        if self._discord_poster is None or self._discord_poster.url != url:
            self._discord_poster = DiscordPoster(url, cooldown_sec=300)
        else:
            self._discord_poster.url = url
        result = self._discord_poster.post(
            self._discord_snapshot(),
            force=not silent,
            session=self._tv_session_mode(),
        )
        if result.get("ok"):
            self._append_log("Discord: Action Center summary posted.")
            if not silent:
                messagebox.showinfo("Discord", "Posted Action Center summary.")
        elif result.get("skipped"):
            self._append_log(f"Discord: skipped ({result.get('error')})")
        else:
            err = result.get("error") or result.get("status")
            self._append_log(f"Discord post failed: {err}", "ERROR")
            if not silent:
                messagebox.showerror("Discord", f"Post failed: {err}")

    def _update_session_map(self, bias_fut, fut_symbol, spot_conv):
        """Redraw the Session Map from the futures-scale bias.

        Built on the converted bias rather than the underlying one because the
        calibration is measured in futures points, per contract.
        """
        if spot_conv is None:
            return
        try:
            card = build_card(bias_fut, future=fut_symbol, price=float(spot_conv))
            render_scenario_map(
                card, bias=bias_fut, fig=self.session_fig,
                title=(f"{fut_symbol}  -  {card.regime} gamma  -  "
                       f"usual session travel from {float(spot_conv):,.0f}"),
            )
            self.session_canvas.draw_idle()
            self._session_card = card

            notes = [s.line() for s in card.sessions]
            notes.append("")
            notes.extend(f"! {n}" for n in card.notes)
            sample = card.sample or {}
            if sample.get("start"):
                notes.append("")
                notes.append(f"Measured over {sample['start']} to {sample['end']} "
                             f"across {', '.join(sample.get('pairs', []))}.")
            self.session_notes.delete("1.0", "end")
            self.session_notes.insert("1.0", "\n".join(notes))
        except Exception as exc:  # noqa: BLE001 - a chart must never kill the stream
            self._append_log(f"Session map unavailable: {exc}", "ERROR")

    def _tv_session_mode(self) -> str:
        return (self.tv_session_mode_var.get() or "RTH").strip().lower()

    def _current_session_key(self):
        mode = self._tv_session_mode()
        if mode == "visible":
            return "visible"
        try:
            return session_key(mode)
        except Exception:
            return None

    def _maybe_auto_draw_tv(self):
        """Auto-draw converted futures plan after a successful conversion cycle."""
        if not bool(self.auto_draw_tv_var.get()):
            return
        if not self._futures_conversion_enabled or not self._last_converted_levels:
            return
        if self._tv_draw_in_flight:
            return
        redraw_each = bool(self.redraw_tv_each_update_var.get())
        # Session-bounded drawings are anchored to a fixed window, so a new session
        # always needs a fresh set even when redraw-each-update is off.
        rolled = self._current_session_key() != self._tv_last_session_key
        if self._tv_auto_draw_done and not redraw_each and not rolled:
            return
        # Force Futures target for automation (SPY->ES1!, QQQ->NQ1!, GLD->GC1!).
        self.tv_draw_target_var.set("Futures")
        self._draw_converted_to_tradingview(silent=True, force_futures=True)

    def _draw_converted_to_tradingview(self, silent: bool = False, force_futures: bool = False):
        if not self._futures_conversion_enabled:
            if not silent:
                messagebox.showwarning(
                    "Conversion off",
                    "Enable futures conversion first (Auto Futures Convert on Start, or Start Conversion).",
                )
            return
        if not self._last_converted_levels:
            if self.last_payload is not None:
                try:
                    self._update_futures_conversion(self.last_payload, trigger_auto_draw=False)
                except Exception:
                    pass
        if not self._last_converted_levels:
            if not silent:
                messagebox.showwarning(
                    "No levels",
                    "No converted levels yet. Start the stream and wait for one cycle.",
                )
            return
        if self._tv_draw_in_flight:
            if not silent:
                self._append_log("TradingView draw already in progress...")
            return

        underlying = str(self._last_converted_levels.get("underlying") or "").upper()
        mapping = FUTURES_CONVERSION_MAP.get(underlying)
        if force_futures or (self.tv_draw_target_var.get() or "").strip().lower().startswith("fut"):
            if not mapping:
                msg = f"No futures mapping for {underlying}. Supported: SPY/ES, QQQ/NQ, GLD/GC, DIA/YM, IWM/RTY."
                self._append_log(f"ERROR: {msg}")
                if not silent:
                    messagebox.showwarning("No futures mapping", msg)
                return
            target = "futures"
            levels = dict(self._last_converted_levels.get("futures_levels") or self._last_converted_levels)
        else:
            target = "underlying"
            levels = dict(self._last_converted_levels.get("underlying_levels") or self._last_converted_levels)

        switch_symbol = bool(self.tv_switch_symbol_var.get())
        clear_previous = bool(self.tv_clear_previous_var.get())
        prev_ids = list(self._tv_drawn_entity_ids) if clear_previous else []
        session_mode = self._tv_session_mode()
        self._tv_draw_in_flight = True

        self._append_log(
            f"{'Auto-' if silent else ''}Drawing action-plan to TradingView: {levels.get('tv_symbol')} "
            f"({levels.get('horizon')}) {underlying}->{levels.get('futures') or levels.get('label_symbol')} "
            f"target={target} switch={switch_symbol} clear_prev={clear_previous} session={session_mode}"
        )
        self.futures_status_var.set(f"Drawing {levels.get('tv_symbol')} action-plan...")

        def worker():
            try:
                health = tv_health_check()
                if not health.get("ok"):
                    raise RuntimeError(health.get("error") or "TradingView CDP not reachable on :9222")
                try:
                    draw_n = max(5, int(self.top_n_var.get().strip() or "7"))
                except Exception:
                    draw_n = 7
                result = draw_converted_levels(
                    levels,
                    switch_symbol=switch_symbol,
                    clear_previous_ids=prev_ids,
                    clear_all=False,
                    clear_glp=bool(self.tv_clear_previous_var.get()),
                    top_n_magnets=max(draw_n, len(levels.get("pos") or []), len(levels.get("neg") or [])),
                    session_mode=session_mode,
                )
                result["silent"] = silent
                self.ui_queue.put(("tv_draw_done", result))
            except Exception as exc:
                self.ui_queue.put(("tv_draw_error", {"error": str(exc), "silent": silent}))

        threading.Thread(target=worker, daemon=True).start()

    def _update_data_mode_panel(self):
        preset = self.preset_var.get().strip()
        underlying = self.underlying_var.get().strip().upper()
        ctx = get_data_mode_context(preset, underlying if underlying else "N/A")
        self.mode_badge_var.set(f"Mode: {ctx['mode']}")
        self.mode_confidence_var.set(f"Confidence: {ctx['confidence']}")
        self.mode_text.delete("1.0", "end")
        body = [
            ctx["message"],
            "",
            f"Displayed underlying: {underlying if underlying else 'N/A'}",
            f"Preset selection: {preset}",
            "",
            "Interpretation guidance:",
        ]
        if ctx["mode"] == "Proxy":
            body.extend(
                [
                    "- Treat levels as directional context, not exact futures-options positioning.",
                    "- Strike/OI concentration differs from true futures options chains.",
                    "- Use tighter risk controls and confirm with price/volume behavior.",
                ]
            )
        else:
            body.extend(
                [
                    "- Levels are based on direct options chain for the selected underlying.",
                    "- Better alignment for strike magnets and flip interpretation.",
                    "- Still verify with live price action before execution.",
                ]
            )
        body.extend(
            [
                "",
                "Goal: keep this tab as your confusion guardrail while the main tabs remain execution-focused.",
            ]
        )
        self.mode_text.insert("1.0", "\n".join(body))

    def _fetch_open_spot(self, api_key: str, api_base_url: str, ticker: str, provider: str | None = None):
        """Session-open anchor for the underlying, inferred from the UW chain."""
        try:
            result = fetch_and_compute_uw(
                api_key=api_key,
                underlying=ticker,
                spot=None,
                top_n=3,
                api_base_url=api_base_url or UW_API_BASE_URL,
                max_pages=1,
            )
        except Exception:
            return None
        try:
            inferred = infer_spot_from_exposures(result["rows"], result["df"])
            if inferred is not None:
                return float(inferred)
            return float(result["metrics"]["spot"])
        except Exception:
            return None

    def _set_spot_from_open_now(self):
        api_key = self.api_key_var.get().strip() or load_uw_api_key()
        api_base = self.api_base_url_var.get().strip() or UW_API_BASE_URL
        ticker = self.underlying_var.get().strip().upper()
        if not api_key or not api_base or not ticker:
            messagebox.showwarning("Missing fields", "Enter API key, base URL, and underlying first.")
            return
        value = self._fetch_open_spot(api_key, api_base, ticker)
        if value is None:
            self._append_log("ERROR: Could not auto-fetch opening spot for ticker.")
            messagebox.showwarning("Spot fetch failed", "Could not fetch opening spot for this ticker/plan.")
            return
        self.spot_var.set(f"{value:.2f}")
        self._append_log(f"Auto Spot(Open) set: {ticker} = {value:.2f}")

    def _get_default_writable_log_csv(self) -> str:
        base = Path.home() / "Documents" / "GLP" / "saved_plots"
        base.mkdir(parents=True, exist_ok=True)
        return str(base / "uw_gex_log.csv")

    def _resolve_log_csv_path(self, raw_path: str) -> str:
        if not raw_path:
            return ""
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            # Prefer package root (v12 folder), not whatever cwd Python was launched from.
            path = _package_root() / path
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            test_file = path.parent / ".glp_write_test.tmp"
            with open(test_file, "w", encoding="utf-8") as f:
                f.write("ok")
            test_file.unlink(missing_ok=True)
            return str(path)
        except Exception:
            fallback = self._get_default_writable_log_csv()
            self.ui_queue.put(("log", f"ERROR: Log path not writable. Falling back to: {fallback}"))
            return fallback

    def _fetch_intraday_series(self, api_key: str, api_base_url: str, ticker: str, lookback_minutes: int = 180):
        base = api_base_url.rstrip("/")
        now_utc = datetime.utcnow()
        start_utc = now_utc - timedelta(minutes=lookback_minutes)
        date_from = start_utc.strftime("%Y-%m-%d")
        date_to = now_utc.strftime("%Y-%m-%d")
        url = f"{base}/v2/aggs/ticker/{ticker}/range/1/minute/{date_from}/{date_to}"
        try:
            resp = requests.get(
                url,
                params={"adjusted": "true", "sort": "asc", "limit": 50000, "apiKey": api_key},
                timeout=15,
            )
            if not resp.ok:
                return []
            results = resp.json().get("results") or []
            cutoff_ts_ms = int(start_utc.timestamp() * 1000)
            out = []
            for row in results:
                ts_ms = row.get("t")
                close = row.get("c")
                if ts_ms is None or close is None or ts_ms < cutoff_ts_ms:
                    continue
                out.append({"time": datetime.fromtimestamp(ts_ms / 1000.0), "close": float(close)})
            return out
        except Exception:
            return []

    def _start(self):
        if self.worker_thread and self.worker_thread.is_alive():
            messagebox.showinfo("Already running", "The dashboard is already running.")
            return

        try:
            cfg = self._read_config()
        except Exception as exc:
            messagebox.showerror("Invalid settings", f"Please check your inputs.\n\n{exc}")
            return

        if not cfg.api_key:
            messagebox.showerror(
                "Missing API key",
                "Enter your Unusual Whales API key (Bearer token). Get one at unusualwhales.com.",
            )
            return

        self.stop_event.clear()
        self.history = []
        self._session_spot_locked = False
        self._session_anchor_spot = None
        self._futures_conversion_enabled = False
        self._futures_open_session_date = None
        self._first_live_cycle = True
        self._tv_auto_draw_done = False
        self._tv_draw_in_flight = False
        self._last_converted_levels = None
        self._apply_futures_mapping(cfg.underlying)
        self.plan_text.delete("1.0", "end")
        self.plan_text.insert("1.0", "Waiting for first data pull...")
        cfg.log_csv = self._resolve_log_csv_path(cfg.log_csv)
        if cfg.log_csv:
            self.log_csv_var.set(cfg.log_csv)
        mapped = FUTURES_CONVERSION_MAP.get(cfg.underlying)
        map_txt = (
            f"{cfg.underlying}->{mapped['futures']}->{resolve_tv_symbol(mapped['futures'])}"
            if mapped
            else f"{cfg.underlying} (no futures map)"
        )
        self._append_log(
            f"Provider=Unusual Whales | base={cfg.api_base_url} | MCP={UW_MCP_URL}"
            + f" | horizon={cfg.expiry_scope} | map={map_txt}"
            + f" | auto_convert={cfg.auto_futures_convert} | auto_draw_tv={cfg.auto_draw_tv}"
        )
        if cfg.spot is None and cfg.auto_spot_open:
            open_spot = self._fetch_open_spot(
                cfg.api_key, cfg.api_base_url, cfg.underlying
            )
            if open_spot is not None:
                cfg.spot = open_spot
                self._session_spot_locked = True
                self._session_anchor_spot = float(open_spot)
                self.spot_var.set(f"{open_spot:.2f}")
                self._append_log(
                    f"Session open anchor locked at start: {cfg.underlying} = {open_spot:.2f}"
                )
            else:
                self._append_log(
                    "ERROR: Auto Spot(Open) endpoint fetch failed. Will lock session spot from first options snapshot."
                )
        if cfg.auto_futures_convert:
            ok = self._auto_enable_futures_conversion(cfg.underlying)
            if ok:
                self._append_log(
                    f"Auto pipeline armed: pull {cfg.underlying} -> convert "
                    f"{self.futures_symbol_var.get()} -> "
                    f"{'auto-draw ' + resolve_tv_symbol(self.futures_symbol_var.get()) if cfg.auto_draw_tv else 'manual draw'}."
                )
            elif cfg.auto_draw_tv:
                self._append_log("ERROR: Auto Draw TV waiting — futures open fetch failed. Use Fetch Open.")
        self.worker_thread = threading.Thread(target=self._worker_loop, args=(cfg,), daemon=True)
        self.worker_thread.start()
        self.status_var.set("Running")
        self._append_log("Started live stream.")
        self._update_data_mode_panel()

    def _stop(self):
        self.stop_event.set()
        self.status_var.set("Stopping...")
        self._append_log("Stop requested.")

    def _notify(self, notifier, title: str, message: str, duration: int):
        if notifier is None:
            return
        try:
            # Prefer non-blocking; ignore toast backend crashes.
            notifier.show_toast(title, message, duration=duration, threaded=True)
        except Exception as exc:
            self.ui_queue.put(("log", f"Toast disabled after backend error: {exc}"))
            # Permanently disable toaster for this worker run.
            try:
                notifier.show_toast = lambda *a, **k: False  # type: ignore[method-assign]
            except Exception:
                pass

    def _worker_loop(self, cfg: AppConfig):
        notifier = _build_notifier(cfg.toast)
        prev_spot = None
        last_alert = {}
        uw_spot_trail: list[dict] = []

        while not self.stop_event.is_set():
            try:
                ts = datetime.now()
                # Keep pulls bounded for responsiveness; avoid long full-chain blocking.
                max_pages = 2 if self._first_live_cycle else 8
                if self._first_live_cycle:
                    self.ui_queue.put(("log", f"Fast-start: loading first {cfg.provider} snapshot..."))
                else:
                    self.ui_queue.put(("log", f"Loading live {cfg.provider} snapshot..."))

                uw = fetch_and_compute_uw(
                    api_key=cfg.api_key,
                    underlying=cfg.underlying,
                    spot=cfg.spot,
                    top_n=cfg.top_n,
                    expiry_scope=cfg.expiry_scope,
                    api_base_url=cfg.api_base_url,
                    max_pages=max_pages,
                )
                rows = uw["rows"]
                df = uw["df"]
                df_scoped = uw["df_scoped"]
                df_weekly_near = uw["df_weekly_near"]
                df_monthly = uw["df_monthly"]
                metrics = uw["metrics"]
                quality = uw["quality"]
                parity_state = uw["parity_state"]
                pressure = uw["pressure"]
                liquidity_zones = uw["liquidity_zones"]
                diag = uw.get("diag") or {}
                if cfg.spot is None and cfg.auto_spot_open and not self._session_spot_locked:
                    inferred = float(metrics["spot"])
                    cfg.spot = inferred
                    self._session_spot_locked = True
                    self._session_anchor_spot = inferred
                    self.ui_queue.put(
                        (
                            "log",
                            f"Session open anchor locked from UW exposures: {cfg.underlying} = {cfg.spot:.2f}",
                        )
                    )
                note = uw.get("expiry_scope_note") or ""
                self.ui_queue.put(
                    (
                        "log",
                        "Diag | "
                        f"horizon {cfg.expiry_scope} | "
                        f"raw {diag.get('raw', len(rows)):,} | "
                        f"OI {diag.get('oi', 0):,} | "
                        f"gamma {diag.get('gamma', 0):,} | "
                        f"usable {diag.get('usable_scoped', len(df_scoped)):,}/"
                        f"{diag.get('usable_universe', len(df)):,} | UW MCP-compatible",
                    )
                )
                if note:
                    self.ui_queue.put(("log", f"Horizon: {note}"))
                weekly_exps = (pressure or {}).get("weekly_expiries") or []
                monthly_exps = (pressure or {}).get("monthly_expiries") or []
                if weekly_exps or monthly_exps:
                    self.ui_queue.put(
                        (
                            "log",
                            "Expiry buckets | "
                            f"weekly={','.join(weekly_exps) or 'n/a'} "
                            f"({float((pressure or {}).get('weekly_net_units') or 0):,.0f} u) | "
                            f"monthly={','.join(monthly_exps) or 'n/a'} "
                            f"({float((pressure or {}).get('monthly_net_units') or 0):,.0f} u)",
                        )
                    )
                # UW exposes no minute aggregates; synthesize a spot trail for the price panel.
                uw_spot_trail.append({"time": ts, "close": float(metrics["spot"])})
                uw_spot_trail = uw_spot_trail[-300:]
                price_series = list(uw_spot_trail)

                # Alerts (skip first cycle — avoids startup proximity spam + toast storms)
                now_ts = time.time()
                z = metrics["zero_gamma"]
                spot = float(metrics["spot"])
                alerts_enabled = (
                    (not self._first_live_cycle)
                    and parity_state == "aligned"
                    and not quality.degraded
                )
                if prev_spot is not None and z is not None and alerts_enabled:
                    crossed = (prev_spot - z) * (spot - z) < 0
                    if crossed and now_ts - last_alert.get("flip", 0) >= cfg.alert_cooldown:
                        msg = f"{cfg.underlying} crossed gamma flip {z:.2f} ({prev_spot:.2f}->{spot:.2f})"
                        self.ui_queue.put(("alert", msg))
                        self._notify(notifier, f"{cfg.underlying} Gamma Flip", msg, cfg.toast_duration)
                        last_alert["flip"] = now_ts

                if alerts_enabled:
                    # Only nearest magnet on each side — prevents 5–10 alerts per refresh.
                    for side_name, frame, title in [
                        ("pos", metrics["top_positive"].head(1), f"{cfg.underlying} +GEX Magnet"),
                        ("neg", metrics["top_negative"].head(1), f"{cfg.underlying} -GEX Zone"),
                    ]:
                        for row in frame.itertuples():
                            strike = float(row.strike)
                            dist = abs(spot - strike)
                            if dist <= cfg.alert_distance:
                                key = f"{side_name}_{int(round(strike))}"
                                if now_ts - last_alert.get(key, 0) >= cfg.alert_cooldown:
                                    msg = f"{cfg.underlying} near {strike:.2f} (spot {spot:.2f}, dist {dist:.2f})"
                                    self.ui_queue.put(("alert", msg))
                                    self._notify(notifier, title, msg, cfg.toast_duration)
                                    last_alert[key] = now_ts
                elif quality.degraded:
                    self.ui_queue.put(
                        (
                            "log",
                            "ERROR: Parity/data-quality degraded; alert notifications suppressed this cycle.",
                        )
                    )

                prev_spot = spot

                if cfg.log_csv:
                    try:
                        append_summary_log(
                            cfg.log_csv,
                            cfg.underlying,
                            metrics,
                            contracts_total=len(rows),
                            contracts_used=len(df_scoped),
                            expiry_scope=cfg.expiry_scope,
                        )
                    except Exception as exc:
                        self.ui_queue.put(("log", f"ERROR: Logging disabled this run ({exc})"))
                        cfg.log_csv = ""

                payload = {
                    "timestamp": ts,
                    "metrics": metrics,
                    "contracts_used": len(df_scoped),
                    "weekly_near_used": len(df_weekly_near),
                    "monthly_used": len(df_monthly),
                    "price_series": price_series,
                    "quality": quality,
                    "hedge_pressure": pressure,
                    "liquidity_zones": liquidity_zones,
                }
                self.ui_queue.put(("data", payload))
                if self._first_live_cycle:
                    self.ui_queue.put(
                        (
                            "log",
                            "First data pull complete. Live updates running.",
                        )
                    )
                    self._first_live_cycle = False
            except requests.RequestException as exc:
                self.ui_queue.put(("log", f"ERROR: Network timeout/connection issue ({exc}). Retrying..."))
            except Exception as exc:
                self.ui_queue.put(("error", str(exc)))

            # Sleep with cooperative stop checks.
            for _ in range(cfg.interval * 10):
                if self.stop_event.is_set():
                    break
                time.sleep(0.1)

        self.ui_queue.put(("stopped", "Worker stopped"))

    def _append_log(self, message: str):
        stamp = datetime.now().strftime("%H:%M:%S")
        tag = None
        if "ALERT:" in message:
            tag = "ALERT"
        elif "ERROR:" in message:
            tag = "ERROR"
        if tag:
            self.log_text.insert("end", f"[{stamp}] {message}\n", tag)
        else:
            self.log_text.insert("end", f"[{stamp}] {message}\n")
        self.log_text.see("end")

    def _revert_chart_view(self):
        # Safety fallback: instantly return to baseline chart rendering.
        self.show_levels_var.set(False)
        self._append_log("Chart view reverted to baseline (levels overlay OFF).")
        if self.last_payload is not None:
            self._update_charts(self.last_payload)

    def _draw_action_levels_on_price(self, bias, on_scale):
        """Overlay the Action Center levels on the live price panel."""
        marks = [
            (getattr(bias, "flip", None), f"Flip {getattr(bias, 'flip', 0):.2f}",
             THEME["purple"], "-.", 1.4),
            (getattr(bias, "struct_flip", None), f"Monthly flip {getattr(bias, 'struct_flip', 0):.2f}",
             "#7E57C2", ":", 1.0),
            (getattr(bias, "pin", None), f"Pin {getattr(bias, 'pin', 0):.2f}",
             THEME["yellow"], "-", 1.6),
            (getattr(bias, "call_wall", None), f"Call wall {getattr(bias, 'call_wall', 0):.2f}",
             CYBER["accent_green"], "-", 1.1),
            (getattr(bias, "put_wall", None), f"Support {getattr(bias, 'put_wall', 0):.2f}",
             CYBER["accent_cyan"], "-", 1.1),
            (getattr(bias, "air_pocket", None), f"Air pocket {getattr(bias, 'air_pocket', 0):.2f}",
             CYBER["accent_orange"], ":", 1.0),
        ]
        seen = set()
        for price, label, color, style, width in marks:
            if price is None:
                continue
            key = round(float(price), 4)
            if key in seen:
                continue
            seen.add(key)
            if on_scale(price):
                self.ax_price.axhline(
                    float(price), color=color, linestyle=style,
                    linewidth=width, alpha=0.9, label=label,
                )
            else:
                side = "below" if float(price) < self.ax_price.get_ylim()[0] else "above"
                self.ax_price.plot([], [], color=color, linestyle=style,
                                  label=f"{label} ({side} view)")

        band = bias.containment() if hasattr(bias, "containment") else None
        if band and on_scale(band[0]) and on_scale(band[1]):
            self.ax_price.axhspan(
                band[0], band[1], color=CYBER["accent_green"], alpha=0.08,
                label=f"Containment {band[0]:.0f}-{band[1]:.0f}",
            )

    def _refresh_action_center(self, payload):
        metrics = payload["metrics"]
        quality = payload.get("quality")
        pressure = payload.get("hedge_pressure") or {
            "daily_bn": 0.0, "monthly_bn": 0.0, "mhp_level": None,
            "weekly_expiries": [], "monthly_expiries": [],
        }
        horizon = (metrics.get("expiry_scope") or self.expiry_scope_var.get() or "all").strip().lower()
        weekly_exps = ", ".join((pressure.get("weekly_expiries") or [])[:6]) or "n/a"
        monthly_exps = ", ".join(pressure.get("monthly_expiries") or []) or "n/a"
        try:
            bias = bias_from_metrics(
                metrics, pressure, horizon=horizon,
                degraded=bool(getattr(quality, "degraded", False)),
            )
        except Exception:
            bias = getattr(self, "_last_bias", None)
        self._last_bias = bias

        display_bias = bias
        fut_symbol = (self.futures_symbol_var.get() or "").strip().upper() or None
        fut_price = None
        if self._last_converted_levels:
            fut_price = (self._last_converted_levels.get("futures_levels") or {}).get("spot")
            fut_symbol = self._last_converted_levels.get("futures") or fut_symbol
            raw = self._last_converted_levels.get("bias")
            if isinstance(raw, dict) and raw.get("regime"):
                try:
                    from gex_bias import GammaBias
                    display_bias = GammaBias(**{k: v for k, v in raw.items()
                                                if k in GammaBias.__dataclass_fields__})
                except Exception:
                    pass

        plan = build_action_center_text(
            display_bias,
            underlying=self.underlying_var.get().strip().upper(),
            horizon=horizon,
            session_mode=self._tv_session_mode(),
            future=fut_symbol,
            future_price=fut_price if fut_price is not None else getattr(display_bias, "spot", None),
            weekly_exps=weekly_exps,
            monthly_exps=monthly_exps,
            liquidity_zones=payload.get("liquidity_zones"),
        )
        self.plan_text.delete("1.0", "end")
        self.plan_text.insert("1.0", plan)

    def _update_charts(self, payload):
        self.last_payload = payload
        ts = payload["timestamp"]
        metrics = payload["metrics"]
        price_series = payload.get("price_series") or []
        self.history.append(
            {
                "time": ts,
                "total_bn": metrics["total_bn"],
                "spot": metrics["spot"],
                "zero_gamma": metrics["zero_gamma"],
            }
        )
        self.history = self.history[-300:]
        hist_df = pd.DataFrame(self.history)

        # Bias first so the price panel can draw the same levels Action Center quotes.
        pressure_early = payload.get("hedge_pressure") or {}
        horizon_early = (metrics.get("expiry_scope") or self.expiry_scope_var.get() or "all").strip().lower()
        try:
            self._last_bias = bias_from_metrics(
                metrics, pressure_early, horizon=horizon_early,
                degraded=bool(getattr(payload.get("quality"), "degraded", False)),
            )
        except Exception:
            pass

        by_strike = metrics["by_strike"]
        spot_f = float(metrics["spot"])
        flip_f = None if metrics["zero_gamma"] is None else float(metrics["zero_gamma"])
        price_df = pd.DataFrame(price_series) if price_series else pd.DataFrame()

        # One price scale drives both top panels, so a magnet in the profile sits
        # at the same height as that price in the chart beside it.
        p_lo, p_hi = self._shared_price_window(price_df, by_strike, spot_f, flip_f)

        def on_scale(level) -> bool:
            return level is not None and p_lo <= float(level) <= p_hi

        # Live price chart
        self.ax_price.clear()
        self._style_axes(self.ax_price)
        self.ax_price.grid(color=CYBER["grid"], alpha=0.35)
        if not price_df.empty:
            self._plot_with_glow(
                self.ax_price,
                price_df["time"],
                price_df["close"],
                THEME["cyan"],
                linewidth=1.8,
                glow_alpha=0.14,
                zorder=10,
                label=f"{self.underlying_var.get().strip().upper()} 1m Close",
            )
            self.ax_price.axhline(
                spot_f,
                color=CYBER["accent_cyan"],
                linestyle="--",
                linewidth=1.0,
                alpha=0.9,
                label=f"Spot {spot_f:.2f}",
            )
            if flip_f is not None:
                if on_scale(flip_f):
                    x_vals = [price_df["time"].iloc[0], price_df["time"].iloc[-1]]
                    self._plot_with_glow(
                        self.ax_price,
                        x_vals,
                        [flip_f, flip_f],
                        THEME["purple"],
                        linewidth=1.0,
                        glow_alpha=0.10,
                        zorder=8,
                        linestyle="-.",
                        alpha=0.9,
                        label=f"Flip {flip_f:.2f}",
                    )
                else:
                    # Off the visible scale. Say where it is rather than
                    # stretching the axis until the price action disappears.
                    side = "below" if flip_f < p_lo else "above"
                    self.ax_price.plot(
                        [], [], color=THEME["purple"], linestyle="-.",
                        label=f"Flip {flip_f:.2f} ({side} view)",
                    )
            # Action-plan levels (same names the Action Center and TV use), not
            # the anonymous top-N magnet dump that made the chart unreadable.
            if self.show_levels_var.get() and getattr(self, "_last_bias", None) is not None:
                self._draw_action_levels_on_price(self._last_bias, on_scale)
            self.ax_price.legend(loc="upper left", fontsize=7)
            self.ax_price.tick_params(axis="x", rotation=25)
        self.ax_price.set_ylim(p_lo, p_hi)
        self.ax_price.set_title("Live Underlying Price")
        self.ax_price.set_ylabel("Price")
        self.ax_price.set_xlabel("Time")

        # Profile chart, rotated to share the price axis: strike runs up the side,
        # gamma runs across, so each bar points out of the price it belongs to.
        self.ax_profile.clear()
        self._style_axes(self.ax_profile)
        visible = (
            by_strike[(by_strike["strike"] >= p_lo) & (by_strike["strike"] <= p_hi)]
            if not by_strike.empty
            else by_strike
        )
        x_abs = max(0.05, float(np.nanmax(np.abs(visible["gex_bn"]))) if not visible.empty else 1.0)
        x_min, x_max = -x_abs * 1.25, x_abs * 1.25
        self._add_axes_gradient(self.ax_profile, x_min, x_max, p_lo, p_hi)
        self.ax_profile.grid(color=CYBER["grid"], alpha=0.4)
        if not visible.empty:
            # One bar per strike. A fixed width on a $1 strike ladder drew every
            # bar several times too tall, merging them into a solid block.
            ladder = np.sort(by_strike["strike"].unique())
            step = float(np.median(np.diff(ladder))) if len(ladder) > 1 else 1.0
            # Colour by sign so the regime reads at a glance instead of having to
            # trace which side of zero each bar falls on.
            bar_colors = [
                CYBER["accent_green"] if float(v) >= 0 else CYBER["accent_orange"]
                for v in visible["gex_bn"]
            ]
            self.ax_profile.barh(
                visible["strike"],
                visible["gex_bn"],
                height=max(step * 0.8, 1e-6),
                alpha=0.85,
                color=bar_colors,
            )
        self.ax_profile.axvline(0, color=CYBER["muted"], linewidth=1)
        self.ax_profile.axhline(
            spot_f, color=CYBER["accent_magenta"], linestyle="--", linewidth=1.2, label=f"Spot {spot_f:.2f}"
        )
        if on_scale(flip_f):
            # Purple, matching the price panel. It was green here, the same colour
            # as the +GEX markers, which made the regime line look like a magnet.
            self.ax_profile.axhline(
                flip_f, color=THEME["purple"], linestyle="--", linewidth=1.4, label=f"Flip {flip_f:.2f}"
            )
        if self.show_levels_var.get():
            top_pos = metrics["top_positive"].sort_values("gex_bn", ascending=False).head(5)
            top_neg = metrics["top_negative"].sort_values("gex_bn", ascending=True).head(5)
            for idx, level in enumerate([float(x) for x in top_pos["strike"].tolist()]):
                if on_scale(level):
                    self.ax_profile.axhline(
                        level, color=CYBER["accent_green"], linestyle=":", linewidth=1.0, alpha=0.75,
                        label="+GEX levels" if idx == 0 else None,
                    )
            for idx, level in enumerate([float(x) for x in top_neg["strike"].tolist()]):
                if on_scale(level):
                    self.ax_profile.axhline(
                        level, color=CYBER["accent_orange"], linestyle=":", linewidth=1.0, alpha=0.75,
                        label="-GEX levels" if idx == 0 else None,
                    )
        self.ax_profile.set_title("Strike GEX")
        self.ax_profile.set_xlabel("Bn per 1%")
        self.ax_profile.set_xlim(x_min, x_max)
        self.ax_profile.set_ylim(p_lo, p_hi)
        # The price axis is already labelled on the panel to the left.
        self.ax_profile.tick_params(labelleft=False)
        self.ax_profile.legend(loc="upper right", fontsize=7)

        # Total history chart
        self.ax_total.clear()
        self._style_axes(self.ax_total)
        self.ax_total.grid(color=CYBER["grid"], alpha=0.4)
        self.ax_total.plot(hist_df["time"], hist_df["total_bn"], color=CYBER["accent_orange"], linewidth=1.8)
        self.ax_total.axhline(0, color=CYBER["muted"], linewidth=1)
        if not hist_df.empty:
            yh_abs = max(0.5, float(np.nanmax(np.abs(hist_df["total_bn"]))))
            self.ax_total.set_ylim(-yh_abs * 1.2, yh_abs * 1.2)
            # The gradient has to span the axis in that axis's own units. This x
            # axis is datetime, so filling it with row indices puts the backdrop
            # at the 1970 epoch, stretches the view across fifty empty years and
            # squeezes the actual series into the last few pixels.
            xh_min, xh_max = self.ax_total.get_xlim()
            self._add_axes_gradient(self.ax_total, xh_min, xh_max, *self.ax_total.get_ylim())
            self.ax_total.set_xlim(xh_min, xh_max)
        self.ax_total.set_title("Net Total Gamma Over Time")
        self.ax_total.set_ylabel("Bn per 1%")
        self.ax_total.tick_params(axis="x", rotation=25)

        self.fig.tight_layout()
        self.canvas.draw_idle()

        zero_gamma = metrics["zero_gamma"]
        zg = "none" if zero_gamma is None else f"{zero_gamma:.2f}"
        quality = payload.get("quality")
        pressure = payload.get("hedge_pressure") or {
            "daily_bn": 0.0,
            "monthly_bn": 0.0,
            "mhp_level": None,
        }
        self._update_status_bar(quality)
        parity = quality.parity_state if quality else "unknown"
        gamma_fill = f"{quality.gamma_fill_rate:.0%}" if quality else "n/a"
        pages = f"{quality.chain_completeness:.0%}" if quality else "n/a"
        struct_flip_txt = "none" if pressure.get("mhp_level") is None else f"{pressure['mhp_level']:.2f}"
        horizon_now = (metrics.get("expiry_scope") or self.expiry_scope_var.get() or "all").strip().lower()
        term = classify_term_structure(
            metrics.get("spot"), metrics.get("zero_gamma"), pressure.get("mhp_level"), horizon_now
        )
        self.metrics_var.set(
            f"Spot {metrics['spot']:.2f} | Total {metrics['total_bn']:.2f}Bn | Flip {zg} | "
            f"Gamma near {pressure['daily_bn']:.2f}Bn monthly {pressure['monthly_bn']:.2f}Bn | "
            f"Flip monthly {struct_flip_txt} | Term {term} | "
            f"Used {payload['contracts_used']} (W {payload.get('weekly_near_used', 0)} / M {payload.get('monthly_used', 0)}) | "
            f"Gamma {gamma_fill} | Pages {pages} | "
            f"Parity {parity} | Price bars {len(price_series)}"
        )
        self._refresh_action_center(payload)
        self._update_data_mode_panel()

    def _poll_queue(self):
        try:
            while True:
                kind, data = self.ui_queue.get_nowait()
                if kind == "data":
                    self.status_var.set("Running")
                    self._update_charts(data)
                    self._update_futures_conversion(data)
                    self._append_log(
                        f"Updated: spot={data['metrics']['spot']:.2f}, total={data['metrics']['total_bn']:.2f}Bn"
                    )
                elif kind == "tv_draw_done":
                    self._tv_draw_in_flight = False
                    self._tv_auto_draw_done = True
                    ids = data.get("entity_ids") or []
                    self._tv_drawn_entity_ids = list(ids)
                    self._tv_last_session_key = data.get("session_key")
                    err_n = len(data.get("errors") or [])
                    plan = data.get("plan_text") or ""
                    span = ""
                    if data.get("session_from") and data.get("session_to"):
                        span = " " + format_session(data["session_from"], data["session_to"])
                    msg = (
                        f"TradingView action-plan drawn: {data.get('drawn_count', 0)} shapes on "
                        f"{data.get('symbol') or 'chart'} [{data.get('session_mode') or 'rth'}{span}]"
                        + (f" ({err_n} warnings)" if err_n else "")
                    )
                    self._append_log(msg)
                    if plan:
                        self._append_log(plan)
                    labels = data.get("labels") or []
                    if labels:
                        self._append_log("TV labels: " + " | ".join(labels[:20]))
                    self.futures_status_var.set(msg)
                    if data.get("errors"):
                        for e in data["errors"][:5]:
                            self._append_log(f"TV draw warn: {e}")
                elif kind == "tv_draw_error":
                    self._tv_draw_in_flight = False
                    err = data.get("error") if isinstance(data, dict) else str(data)
                    silent = bool(data.get("silent")) if isinstance(data, dict) else False
                    self._append_log(f"ERROR: TradingView draw failed: {err}")
                    self.futures_status_var.set(f"TV draw failed: {err}")
                    if not silent:
                        messagebox.showerror("TradingView draw failed", str(err))
                elif kind == "alert":
                    self._append_log(f"ALERT: {data}")
                elif kind == "error":
                    self.status_var.set("Error")
                    self._append_log(f"ERROR: {data}")
                elif kind == "log":
                    self._append_log(data)
                elif kind == "stopped":
                    self.status_var.set("Stopped")
                    self._append_log(data)
        except queue.Empty:
            pass
        finally:
            self.root.after(300, self._poll_queue)


def main():
    root = tk.Tk()
    if not require_terms(root):
        root.destroy()
        return
    if require_license(root) is None and not is_unsigned_build():
        root.destroy()
        return
    root.deiconify()
    app = GEXDesktopApp(root)
    app._append_log(license_banner())
    root.protocol("WM_DELETE_WINDOW", lambda: (app._stop(), root.destroy()))
    root.mainloop()


if __name__ == "__main__":
    main()
