#!/usr/bin/env python3
"""Regenerate the console screenshots with invented names in place of real ones.

Run from the repo root, against a capture taken with:

    ssh <host> 'tmux new-session -d -s shot -x 150 -y 44 \
        "env TERM=xterm-256color utconsole"'
    # then, per page: tmux send-keys -t shot <n>; tmux capture-pane -p -e -t shot
    # capture-pane needs -e, or every escape is stripped and the result is grey

    python3 ops/scripts/console-screenshots.py <capture-file>

This file exists so the substitution RULES live with the repository. Regenerating
screenshots without them would put real release, site and rule names back into
published documentation, and the failure is silent — the images look fine.

Nothing a copyright holder or a tracker would recognise survives: release titles,
feed and indexer names, rule names and library paths are all replaced. Counts,
states, rates, health and timings are kept, because they are what the
documentation illustrates and they identify nothing.

Every page is rendered in ONE process on purpose. The name registry lives in
`ansi_to_svg`, so a release appearing on both the torrents page and the activity
feed gets the same stand-in, and no two distinct releases ever share one. Running
a subprocess per page would restart the sequence and reissue the same names.
"""
import importlib.util
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC = importlib.util.spec_from_file_location(
    "ansi_to_svg", os.path.join(ROOT, "ops", "scripts", "ansi-to-svg.py"))
ansi = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ansi)

PAGES = {1: "overview", 2: "torrents", 3: "media", 4: "jobs", 5: "acquisition",
         6: "infrastructure", 7: "activity", 8: "alerts", 9: "stream"}

STATES = r"(?:seeding|downloading|stalled|paused|queued|checking|error)"

# (row pattern, first column, last column, kind) — anchored by COLUMN.
#
# Anchored by column and not by substring: an early version matched
# "seeding|stalled|error" anywhere on a line and rewrote the pane that reads
# "Nothing errored or stalled." — a status message, not a title. A title column
# lives at a fixed offset, so the offset is what identifies it.
COLUMNS = {
    2: [(r"^│ .{88}" + STATES + r"\b", 2, 89, "title")],
    3: [(r"^│ .{108}\S", 2, 109, "title")],
    5: [(r"^│ \S.{20}\s+\d+\s", 2, 23, "site"),
        (r"(?:no_match|downloaded|skipped_duplicate|matched)", 77, 112, "title")],
    6: [(r"^.{75}│ [●◐✕○] ", 78, 100, "site")],
    7: [(r"^│ +\d+[smhd].*ago +\S", 14, 148, "title"),
        (r"^│ +↳ ", 15, 148, "path")],
    9: [(r"^│ \d\d:\d\d:\d\d ", 26, 148, "title")],
}

# Names embedded in prose, where the offset moves with the sentence.
MATCHES = {
    3: [(r"↳ .*?[\\/]?([^\\/\s]+\.(?:mkv|mp4|avi|srt))", "path")],
    6: [(r'Indexer "([^"]+)"', "site")],
    8: [(r"Indexer ([^\[]+?) last tested", "site"), (r'Indexer "([^"]+)"', "site")],
}


def main() -> int:
    capture = sys.argv[1] if len(sys.argv) > 1 else None
    if not capture or not os.path.exists(capture):
        print("usage: console-screenshots.py <tmux-capture-file>", file=sys.stderr)
        return 2

    raw = open(capture, encoding="utf-8", errors="replace").read()
    parts = re.split(r"@@@PAGE (\d)@@@\n", raw)
    if len(parts) < 3:
        print("capture has no @@@PAGE n@@@ markers", file=sys.stderr)
        return 2

    out_dir = os.path.join(ROOT, "docs", "images", "utconsole")
    os.makedirs(out_dir, exist_ok=True)

    for i in range(1, len(parts), 2):
        n = int(parts[i])
        lines = parts[i + 1].rstrip("\n").split("\n")
        while lines and not lines[-1].strip():
            lines.pop()

        cells = ansi.parse("\n".join(lines))
        if n in COLUMNS:
            cells = ansi.redact(cells, COLUMNS[n])
        if n in MATCHES:
            cells = ansi.redact_matches(cells, MATCHES[n])

        dest = os.path.join(out_dir, f"{n:02d}-{PAGES[n]}.svg")
        with open(dest, "w", encoding="utf-8") as fh:
            fh.write(ansi.to_svg(cells, f"UltraTorrent Console — {PAGES[n].title()}"))
        print(f"{os.path.relpath(dest, ROOT)}  ({os.path.getsize(dest) // 1024} KB)")

    print(f"\n{len(ansi.REGISTRY.by_original)} distinct name(s) invented, none reused")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
