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
        print("usage: ansi-to-svg.py <input> <output.svg> [title]", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    title = sys.argv[3] if len(sys.argv) > 3 else ""
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        fh.write(to_svg(parse(text.rstrip("\n")), title))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
