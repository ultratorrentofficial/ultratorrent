#!/usr/bin/env python3
"""Render captured terminal output (ANSI SGR) to a standalone SVG.

Why SVG and not PNG: the console's screenshots have to live in Markdown that is
read on GitHub, in the Docusaurus site, and in a plain editor. An SVG carries the
real colours, stays sharp at any zoom, has the text selectable and searchable,
and is a few KB of diffable source rather than a binary blob in git history.

Input is what `tmux capture-pane -p -e` produces. Only the subset the console
actually emits is handled — 256-colour fg/bg, the 16 basics, bold, faint,
underline, strikethrough and reset. Anything else is ignored rather than guessed
at, so an unhandled code loses styling instead of corrupting the output.
"""
import hashlib
import html
import re
import sys

# The xterm-256 palette: 16 system colours, a 6×6×6 cube, then 24 greys.
BASE16 = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
]


def palette(n: int) -> str:
    if n < 16:
        return BASE16[n]
    if n < 232:
        n -= 16
        levels = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (levels[n // 36], levels[(n // 6) % 6], levels[n % 6])
    grey = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (grey, grey, grey)


DEFAULT_FG = "#d0d0d0"
DEFAULT_BG = "#12141a"

SGR = re.compile(r"\x1b\[([0-9;]*)m")
# Any OTHER escape the capture may carry, dropped rather than printed.
#
# The final character class deliberately excludes `m`: an SGR sequence ends in
# `m`, and a broad `[A-Za-z]` here silently strips every colour code before the
# parser ever sees one — which renders the whole capture in monochrome and looks
# like the program emitted no colour at all.
OTHER_ESC = re.compile(r"\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]")


class Style:
    __slots__ = ("fg", "bg", "bold", "faint", "underline", "strike")

    def __init__(self):
        self.reset()

    def reset(self):
        self.fg = None
        self.bg = None
        self.bold = False
        self.faint = False
        self.underline = False
        self.strike = False

    def copy(self):
        s = Style()
        s.fg, s.bg = self.fg, self.bg
        s.bold, s.faint = self.bold, self.faint
        s.underline, s.strike = self.underline, self.strike
        return s

    def key(self):
        return (self.fg, self.bg, self.bold, self.faint, self.underline, self.strike)


def apply_sgr(style: Style, params: str) -> None:
    codes = [int(p) for p in params.split(";") if p != ""] or [0]
    i = 0
    while i < len(codes):
        c = codes[i]
        if c == 0:
            style.reset()
        elif c == 1:
            style.bold = True
        elif c == 2:
            style.faint = True
        elif c == 4:
            style.underline = True
        elif c == 9:
            style.strike = True
        elif c in (22,):
            style.bold = style.faint = False
        elif c == 24:
            style.underline = False
        elif c == 29:
            style.strike = False
        elif 30 <= c <= 37:
            style.fg = BASE16[c - 30]
        elif 90 <= c <= 97:
            style.fg = BASE16[c - 90 + 8]
        elif c == 39:
            style.fg = None
        elif 40 <= c <= 47:
            style.bg = BASE16[c - 40]
        elif 100 <= c <= 107:
            style.bg = BASE16[c - 100 + 8]
        elif c == 49:
            style.bg = None
        elif c in (38, 48) and i + 2 < len(codes) and codes[i + 1] == 5:
            colour = palette(codes[i + 2])
            if c == 38:
                style.fg = colour
            else:
                style.bg = colour
            i += 2
        i += 1
    return None


def parse(text: str):
    """Yield one list of (char, Style) per line."""
    lines = []
    style = Style()
    for raw in text.split("\n"):
        raw = OTHER_ESC.sub("", raw.replace("\r", ""))
        cells = []
        pos = 0
        for m in SGR.finditer(raw):
            for ch in raw[pos:m.start()]:
                cells.append((ch, style.copy()))
            apply_sgr(style, m.group(1))
            pos = m.end()
        for ch in raw[pos:]:
            cells.append((ch, style.copy()))
        lines.append(cells)
    return lines


# Invented names used to stand in for real ones in published screenshots.
#
# Substitution rather than blurring, because a blur is only a display filter:
# the real characters would remain in the SVG source, selectable and searchable.
# Replacing them means the file simply does not contain the original — and a
# screenshot full of plausible titles still shows what the console looks like,
# which a wall of grey bars does not.
#
# Every name below is invented. They are deliberately generic and unlike real
# releases, sites or shows.
FAKE_TITLES = [
    "Northwind Hollow S02E04 1080p x265-LUMEN",
    "Paper Lanterns (2024) [1080p] [WEBRip] [5.1]",
    "The Quiet Meridian S01E07 1080p x265-ASHEN",
    "Copper Harbour (2023) [1080p] [BluRay] [5.1]",
    "Lantern Bay S03E11 720p x265-VERDANT",
    "Glasshouse Winter (2025) [1080p] [WEBRip]",
    "Salt Flats S01E02 1080p x265-MERIDIAN",
    "The Long Orchard (2022) [1080p] [BluRay]",
    "Cinder Lake S04E09 1080p x265-HALCYON",
    "Weathervane County S02E01 720p x265-ROWAN",
    "Driftwood Sound (2024) [1080p] [WEBRip] [5.1]",
    "Tin Roof Alley S01E05 1080p x265-CASTLE",
    "The Amber Circuit S05E03 1080p x265-PELICAN",
    "Marble Arch Nights (2021) [1080p] [BluRay]",
    "Quarry Road S02E08 720p x265-THISTLE",
    "The Paper Kingdom (2026) [1080p] [WEBRip]",
]
# Site stand-ins are all three characters, and that is the point.
#
# The same site appears in a wide table column AND inside a narrow quoted string
# in an error message. If the pool held names of mixed length, the wide column
# would take a long one and the quoted span a short one, so a row would read
# "NovaIndex" while its own error said "Arc" — a document contradicting itself,
# which reads as a bug rather than as redaction. Sizing every stand-in to the
# narrowest span any of them has to fit keeps one real name mapping to one
# invented name everywhere it appears.
FAKE_SITES = ["Arc", "Hub", "Orb", "Vex", "Lum", "Nex", "Ako", "Ryn"]
FAKE_RULES = ["Weekly drama rule", "Documentary rule", "Film upgrade rule", "Season pack rule"]
FAKE_PATHS = [
    "Season 2/Northwind Hollow - S02E04 - The Long Way.mkv",
    "Season 1/Lantern Bay - S01E03 - Low Tide.mkv",
    "Copper Harbour (2023)/Copper Harbour (2023).mkv",
    "Season 4/Cinder Lake - S04E09 - Ashfall.mkv",
]
POOLS = {"title": FAKE_TITLES, "site": FAKE_SITES, "rule": FAKE_RULES, "path": FAKE_PATHS}


def invent(original: str, width: int, kind: str) -> str:
    """A stand-in of exactly `width` characters, stable for the same input.

    Stable so one release rendered on two pages gets the same invented name, and
    exactly `width` so every column, rail and box below it stays where it was —
    a substitution that changed a line's length would tear the frame.
    """
    name = _pick(original, width, kind)
    return name.ljust(width)


def _pick(original: str, width: int, kind: str) -> str:
    """The longest stand-in that FITS, chosen deterministically.

    Preferring a name that fits avoids truncating a stand-in — "ArchiveOne" cut
    to "Ar…" in a three-character column reads as a broken renderer, not as a
    redaction.
    """
    pool = POOLS.get(kind, FAKE_TITLES)
    seed = int(hashlib.sha256(original.strip().encode("utf-8")).hexdigest()[:8], 16)
    fitting = [n for n in pool if len(n) <= width]
    if fitting:
        return fitting[seed % len(fitting)]
    name = pool[seed % len(pool)]
    return name[: max(width - 1, 0)] + ("…" if width > 0 else "")


def _apply(cells, start, end, kind):
    """Substitute one span, keeping each cell's original styling."""
    end = min(end, len(cells))
    if end <= start:
        return
    original = "".join(c for c, _ in cells[start:end])
    if not original.strip():
        return
    replacement = invent(original, end - start, kind)
    for offset, col in enumerate(range(start, end)):
        _, st = cells[col]
        cells[col] = (replacement[offset], st)


def redact(lines, specs):
    """Substitute column ranges on rows matching a pattern.

    Anchored by column, not by substring: an early version matched
    "seeding|stalled|error" anywhere on a line and rewrote the pane that says
    "Nothing errored or stalled." A title column lives at a fixed offset, so the
    offset is what identifies it.
    """
    for cells in lines:
        plain = "".join(c for c, _ in cells)
        for pattern, start, end, kind in specs:
            if re.search(pattern, plain):
                _apply(cells, max(start, 0), len(cells) if end is None else end, kind)
    return lines


def _apply_shifted(cells, start, end, kind):
    """Substitute a span inside prose, shifting the tail rather than padding it.

    A column substitution pads to width, which is right in a table and wrong in a
    sentence: `Indexer "NovaIndex        " request failed` reads as a bug. Here
    the replacement keeps its natural length and the rest of the line moves left,
    with the reclaimed space inserted just before the pane's right rail so the
    frame still closes at the same column.
    """
    original = "".join(c for c, _ in cells[start:end])
    if not original.strip():
        return cells
    width = end - start
    name = _pick(original, width, kind)

    style = cells[start][1]
    head, tail = cells[:start], cells[end:]
    body = [(ch, style) for ch in name]
    delta = width - len(name)
    if delta > 0:
        rail = next((i for i in range(len(tail) - 1, -1, -1) if tail[i][0] == "│"), None)
        blank = (" ", style)
        tail = (tail[:rail] + [blank] * delta + tail[rail:]) if rail is not None else tail + [blank] * delta
    return head + body + tail


def redact_matches(lines, patterns):
    """Substitute the span of each regex match, wherever it falls on a line.

    Column ranges handle a table; this handles a name embedded in a sentence —
    "Indexer X last tested as failing" — where the sensitive part is a substring
    whose offset moves with the surrounding text. Group 1 is substituted when the
    pattern defines one, otherwise the whole match.
    """
    for pattern, kind in patterns:
        rx = re.compile(pattern)
        for idx, cells in enumerate(lines):
            plain = "".join(c for c, _ in cells)
            m = rx.search(plain)
            if not m:
                continue
            start, end = (m.span(1) if rx.groups else m.span(0))
            lines[idx] = _apply_shifted(lines[idx], start, end, kind)
    return lines


CELL_W = 8.4
CELL_H = 18.0
PAD = 14.0


def to_svg(lines, title="") -> str:
    cols = max((len(l) for l in lines), default = 0) or 1
    width = cols * CELL_W + PAD * 2
    height = len(lines) * CELL_H + PAD * 2

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {height:.0f}" '
        f'width="{width:.0f}" height="{height:.0f}" font-family="ui-monospace,SFMono-Regular,'
        f'Menlo,Consolas,&quot;DejaVu Sans Mono&quot;,monospace" font-size="13">',
    ]
    if title:
        out.append(f"<title>{html.escape(title)}</title>")
    out.append(f'<rect width="100%" height="100%" rx="8" fill="{DEFAULT_BG}"/>')

    # Background runs first, so text always paints over its own cell colour.
    for row, cells in enumerate(lines):
        y = PAD + row * CELL_H
        run_start, run_bg = 0, None
        for col, (_, st) in enumerate(cells + [(None, Style())]):
            bg = st.bg if col < len(cells) else None
            if bg != run_bg:
                if run_bg:
                    x = PAD + run_start * CELL_W
                    w = (col - run_start) * CELL_W
                    out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" '
                               f'height="{CELL_H:.1f}" fill="{run_bg}"/>')
                run_start, run_bg = col, bg

    for row, cells in enumerate(lines):
        y = PAD + row * CELL_H + CELL_H * 0.74
        col = 0
        while col < len(cells):
            _, st = cells[col]
            end = col
            while end < len(cells) and cells[end][1].key() == st.key():
                end += 1
            text = "".join(c for c, _ in cells[col:end]).rstrip()
            if text:
                x = PAD + col * CELL_W
                attrs = [f'x="{x:.1f}"', f'y="{y:.1f}"',
                         f'fill="{st.fg or DEFAULT_FG}"', 'xml:space="preserve"']
                if st.bold:
                    attrs.append('font-weight="700"')
                if st.faint:
                    attrs.append('opacity="0.55"')
                deco = []
                if st.underline:
                    deco.append("underline")
                if st.strike:
                    deco.append("line-through")
                if deco:
                    attrs.append(f'text-decoration="{" ".join(deco)}"')
                out.append(f'<text {" ".join(attrs)}>{html.escape(text)}</text>')
            col = end

    out.append("</svg>")
    return "\n".join(out)


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: ansi-to-svg.py <in> <out.svg> [title] [--redact ROW_RE:START:END ...]",
              file=sys.stderr)
        return 2

    args = sys.argv[1:]
    specs = []
    matches = []
    while "--redact-match" in args:
        i = args.index("--redact-match")
        pattern, kind = args[i + 1].rsplit("@", 1)
        matches.append((pattern, kind))
        del args[i:i + 2]
    while "--redact" in args:
        i = args.index("--redact")
        spec, kind = args[i + 1].rsplit("@", 1)
        pattern, start, end = spec.rsplit(":", 2)
        specs.append((pattern, int(start), None if end == "" else int(end), kind))
        del args[i:i + 2]

    with open(args[0], encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    title = args[2] if len(args) > 2 else ""

    lines = parse(text.rstrip("\n"))
    if specs:
        lines = redact(lines, specs)
    if matches:
        lines = redact_matches(lines, matches)
    with open(args[1], "w", encoding="utf-8") as fh:
        fh.write(to_svg(lines, title))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
