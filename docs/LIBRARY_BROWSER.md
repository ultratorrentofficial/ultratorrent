# Library Browser

A poster-first way through a media library, in place of the paginated
single-column list. Phase 1 of the Library Browser & Media Operations Workspace.

- [What it is, and is not](#what-it-is-and-is-not)
- [View modes](#view-modes)
- [Virtualization](#virtualization)
- [Paging](#paging)
- [What Phase 1 does not do](#what-phase-1-does-not-do)

---

## What it is, and is not

It **composes existing endpoints**; it adds none of its own and changes no
schema. A TV library browses through `GET /media/series` — which already returns
a poster, season and episode counts per show — and everything else through
`GET /media/items`.

A "show" is therefore still a **projection over flat `MediaItem` rows**, not an
entity. `MediaItem` is one row per file (`@@unique([libraryId, path])`), with
`season` and `episode` as integer columns. There is a `MediaShow` row per show
*folder*, but no Season entity and no Episode entity.

That has a consequence worth stating plainly: **music, audiobook and photo
libraries cannot be browsed as hierarchies**, because `MediaItem.mediaType` is
restricted to video types. Those need a schema migration, which Phase 1
deliberately does not attempt.

Which browser a library gets is decided by **the library's declared `kind`**, not
by inspecting its rows — the same rule identification already follows, so a show
whose folder carries a year is not mistaken for a film.

## View modes

Poster wall · Grid · List · Compact · Table.

The choice is remembered **per library, in `localStorage`** — a music library
can stay a list while films are a wall. It is deliberately client-side, matching
the existing preference pattern: a layout belongs to a *screen*, and the same
person wants a poster wall on a television and a table on a laptop. A
server-side preference would fight that.

Reading a preference never throws. `localStorage` fails in private browsing and
on quota exhaustion, and a layout preference must never be why a library refuses
to render; an unrecognised stored value (a mode removed in a later release)
falls back rather than rendering nothing.

## Virtualization

Only the rows intersecting the viewport are mounted, so DOM cost tracks the
window rather than the library.

**Rows are virtualized, not cells.** A row is at most a dozen posters wide, so
cell-level windowing buys nothing and would break keyboard order and text
selection across a row.

**The column count is computed from a measured width**, not left to CSS.
`repeat(auto-fill, …)` reflows on its own, and the virtualizer would then be
sizing rows it cannot see — the scrollbar lies and items overlap at the seams.
Width is measured with a `ResizeObserver` rather than a window listener, because
the shell's sidebar collapses without the window resizing at all.

`columnsForWidth` never returns zero: a zero makes the row count `Infinity` and
the virtualizer allocates an unbounded scroll height.

## Paging

Server-side and additive. Rows are appended as the grid nears its end, so
scrolling a very large library costs one request per screenful rather than one
enormous response. Nothing fetches a whole library.

## What Phase 1 does not do

Stated so the gaps are not mistaken for bugs:

- **No multi-selection or context action bar** — Phase 2.
- **No filters or search** beyond what the underlying endpoints accept — Phase 3.
- **No issues panel, no export** — later phases.
- **No music/audiobook/photo hierarchies** — needs the schema migration above.
- **Drill-down is partial**: a show opens the existing item list filtered by
  title. The Season → Episode surface is the existing `SeriesGroupedList`, not
  yet folded into the browser.
- **Operations are unchanged** — metadata, artwork, rename, cleanup, subtitles
  and jobs are reached through their existing pages. The browser does not
  reimplement them, and Phase 2 wires them into a selection-aware toolbar.
