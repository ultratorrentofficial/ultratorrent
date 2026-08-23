"""Regenerate the console screenshots with invented names in place of real ones.

Run from the repo root, against a capture taken with:

    ssh <host> 'tmux new-session -d -s shot -x 150 -y 44 \
        "env TERM=xterm-256color utconsole"'
    # then, per page: tmux send-keys -t shot <n>; tmux capture-pane -p -e -t shot
    # capture-pane needs -e or every escape is stripped and the result is grey

This file exists so the substitution RULES live with the repository. Regenerating
screenshots without them would put real release, site and rule names back into
published documentation, and the failure is silent — the images look fine.

Nothing a copyright holder or a tracker would recognise survives: release
titles, feed and indexer names, RSS rule names and library paths are all
replaced with invented equivalents of the same width. Counts, states, rates,
health and timings are kept — they are what the documentation illustrates and
they identify nothing.
"""
import os, re, subprocess

S = "/tmp/claude-1001/-var-www-ultratorrent/15a68c17-f351-4072-9677-1b923db2ce62/scratchpad"
NAMES = {1:"overview",2:"torrents",3:"media",4:"jobs",5:"acquisition",
         6:"infrastructure",7:"activity",8:"alerts",9:"stream"}

STATES = r"(?:seeding|downloading|stalled|paused|queued|checking|error)"

# (row pattern, first col, last col, kind) — anchored by COLUMN.
COLS = {
    2: [(r"^│ .{88}" + STATES + r"\b", 2, 89, "title")],
    3: [(r"^│ .{108}\S", 2, 109, "title")],
    5: [(r"^│ \S.{20}\s+\d+\s", 2, 23, "site"),                       # FEED column
        (r"(?:no_match|downloaded|skipped_duplicate|matched)", 77, 112, "title")],
    6: [(r"^.{75}│ [●◐✕○] ", 78, 100, "site")],                        # indexer names
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

raw = open(f"{S}/fresh.raw", encoding="utf-8", errors="replace").read()
parts = re.split(r"@@@PAGE (\d)@@@\n", raw)
for i in range(1, len(parts), 2):
    n = int(parts[i])
    lines = parts[i + 1].rstrip("\n").split("\n")
    while lines and not lines[-1].strip():
        lines.pop()
    src = f"{S}/fresh{n}.ansi"
    open(src, "w", encoding="utf-8").write("\n".join(lines))

    dest = f"docs/images/utconsole/{n:02d}-{NAMES[n]}.svg"
    cmd = ["python3", "ops/scripts/ansi-to-svg.py", src, dest,
           f"UltraTorrent Console — {NAMES[n].title()}"]
    for pattern, a, b, kind in COLS.get(n, []):
        cmd += ["--redact", f"{pattern}:{a}:{'' if b is None else b}@{kind}"]
    for pattern, kind in MATCHES.get(n, []):
        cmd += ["--redact-match", f"{pattern}@{kind}"]
    subprocess.run(cmd, check=True)
    print(f"{dest}  ({os.path.getsize(dest)//1024} KB)")
