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

## Drill-down

Selecting a show opens its seasons and episodes, served by the existing
`GET /media/series/episodes` — which already returns episodes grouped into
ordered seasons with a season poster (falling back to the show's).

The state lives in the **URL**, not component state: browser Back must return to
the wall, and a show view should survive a reload and be linkable.

Seasons render plainly — a show has tens at most. Episodes are virtualized,
because a long-running series genuinely reaches several hundred in one season.
The view lands on the first season rather than an accordion that must be opened
before anything is visible, and season zero is labelled **Specials**, not
"Season 0".

Technical detail on an episode row is shown **only where the file has it**. The
renamer strips exactly those tokens from filenames, so on a renamed library most
are null until `MediaProbeService` has measured the file; a placeholder per field
would fill the row with dashes and imply the data is missing rather than simply
unmeasured.

## Selection, and why the action bar is not wired yet

Selection is pure functions over a `Set`, not component state. The range rules
are the fiddly part and are far easier to get right away from React — and the
list is virtualized, so a selection must survive rows unmounting as they scroll
out of view. Anything derived from rendered DOM would silently forget what is
off-screen.

Two rules worth stating:

- **Select-all covers the rows currently loaded**, not the library. Paging is
  incremental; claiming to select 500 000 items while holding 60 would make
  every count and every subsequent action a lie. A whole-library operation is a
  server-side *scope*, not a selection.
- **A selection is pruned when the list changes.** One that outlived its rows
  would act on things the user can no longer see — the worst possible input to a
  destructive bulk operation.

**The blocker.** No existing endpoint accepts a set of ids:

| Endpoint | Scope |
|---|---|
| `POST /media/items/reidentify` | `{ libraryId, matchStatus }` — a whole library |
| `POST /media/nfo/generate` | one `itemId` **or** a whole `libraryId` |
| `POST /media/items/:id/lock`, `…/metadata/fetch` | one item |

So a bulk action over a selection would have to fan out N requests from the
browser — N round trips, no single job, no single audit record, and no progress.
That is the wrong shape for a workspace whose operations are supposed to be
jobs. Wiring the bar honestly needs id-list bulk endpoints that dispatch one
job and audit one operation; that is the next piece of backend work, not a
frontend one.

## Paging

Server-side and additive. Rows are appended as the grid nears its end, so
scrolling a very large library costs one request per screenful rather than one
enormous response. Nothing fetches a whole library.

## What Phase 1 does not do

Stated so the gaps are not mistaken for bugs:

- **The context action bar is not wired.** The selection model beneath it is
  built and tested (`selection.ts`) — plain/ctrl/shift click, checkbox,
  select-all-loaded, and pruning when the list changes. What is missing is
  **backend support**, not UI: see below.
- **No filters or search** beyond what the underlying endpoints accept — Phase 3.
- **No issues panel, no export** — later phases.
- **No music/audiobook/photo hierarchies** — needs the schema migration above.
- Drill-down **is** in place — Library → Show → Season → Episode, below.
- **Operations are unchanged** — metadata, artwork, rename, cleanup, subtitles
  and jobs are reached through their existing pages. The browser does not
  reimplement them, and Phase 2 wires them into a selection-aware toolbar.
