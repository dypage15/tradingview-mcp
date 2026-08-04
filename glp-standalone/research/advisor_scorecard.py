"""Scorecard ideas for enhancing the Argos / stream advisor.

This is the research harness that turns stream journals + existing studies into
advisor improvements. It does NOT invent directional edges that the playbook
backtest already rejected.

Run:
  python research/advisor_scorecard.py
  python research/advisor_scorecard.py --journal "%APPDATA%/GLP/stream_journal.jsonl"

What it measures (honest, map-quality):
  1) Regime width — negative vs positive session range (should stay ~1.3–1.6×)
  2) Journal coverage — how often you streamed each regime/term
  3) Cue checklist — whether talk-track watch items match evidence rules

What it deliberately does NOT optimize for:
  win-rate of FADE_WALL / RECLAIM_FLIP (already failed mechanical tests)

Enhancement loop for the advisor:
  A. Stream with companion → journal rows written automatically
  B. After session, tag journal lines with realized_range_pts / flip_broken (manual CSV)
  C. Re-run scorecard + scenario_study / playbook_backtest
  D. Only promote cues that survive out-of-sample width / invalidation tests
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def default_journal() -> Path:
    appdata = os.environ.get("APPDATA") or str(Path.home())
    return Path(appdata) / "GLP" / "stream_journal.jsonl"


def load_journal(path: Path) -> list:
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--journal", default=str(default_journal()))
    args = ap.parse_args()
    path = Path(os.path.expandvars(args.journal))
    rows = load_journal(path)

    print("GLP advisor scorecard")
    print(f"  journal: {path} ({len(rows)} rows)")
    if not rows:
        print("  No stream journal yet. Run Start-GLP-Stream-Companion.cmd during a session.")
        print()
        print("Next tests to enhance the advisor (existing research):")
        print("  python research/scenario_study.py --emit")
        print("  python research/playbook_backtest.py --fut NQ --session rth")
        print("  python research/session_study.py")
        print("  python research/pin_study.py SPY QQQ")
        return

    regimes = Counter(r.get("regime") or "?" for r in rows)
    terms = Counter(r.get("term") or "?" for r in rows)
    symbols = Counter(r.get("symbol") or "?" for r in rows)
    print("  by symbol:", dict(symbols))
    print("  by regime:", dict(regimes))
    print("  by term:  ", dict(terms))
    print()
    print("Enhancement rules of thumb:")
    print("  • Keep width / invalidation cues; drop any cue that implies direction alone.")
    print("  • Tag journal rows post-session with realized_range_pts and flip_broken=0/1.")
    print("  • Promote a talk-track line only if it matches scenario_study evidence.")
    print("  • Never re-introduce mechanical FADE_WALL / RECLAIM_FLIP as auto-entries.")


if __name__ == "__main__":
    main()
