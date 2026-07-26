# Library Browser

A poster-first way through a media library, in place of the paginated
single-column list. Phase 1 of the Library Browser & Media Operations Workspace.

- [What it is, and is not](#what-it-is-and-is-not)
- [View modes](#view-modes)
- [Virtualization](#virtualization)
- [Paging](#paging)
- [What Phase 1 does not do](#what-phase-1-does-not-do)

---

## Decision: projection, not a hierarchy (2026-07-26)

The browser projects hierarchy from flat `MediaItem` rows. It does **not**
introduce Show / Season / Episode / Artist / Album / Track / Author / Book /
Photo entities. This was decided explicitly, not by omission.

**What that buys.** No migration, and no risk to three shipped subsystems that
depend on the current invariant: duplicate detection is built on
`@@unique([libraryId, path])` — one row per file per library — and Library
Cleanup decides what to *delete* from aggregates keyed on flat items. Reworking
the entity model underneath those, alongside a new browser, is how a data-loss
bug happens.

**What it costs, stated plainly.**

- **Music, audiobooks and photos cannot be browsed as hierarchies.**
  `MediaItem.mediaType` admits only video types, so there is nothing to project
  an Artist or an Author from. `MediaLibrary.kind` accepts `music` and
  `audiobook`, but nothing produces such items — they scan as `other_video`.
- **A show has no id of its own**, being a projection. It cannot be selected,
  locked, or passed to a bulk operation; selection therefore applies to items.

**If that changes.** Moving to real entities is its own project — schema,
migration of ~29k rows on live libraries, and coordinated changes to
identification, duplicate detection, rename, cleanup, NFO, media-server sync and
Trakt scrobbling. It should be planned and reviewed on its own, not folded into
browser work.

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

**Resolved.** `POST /media/items/bulk/{metadata,lock,unlock,nfo}` take an
explicit `{ itemIds }`, dispatch **one** job and write **one** audit row, and
the toolbar now uses them.

Selection applies to **items, not shows** — the bulk routes take item ids, and a
show is a projection with no id of its own. A **modified** click selects
(shift for a range, ctrl/cmd to toggle); a plain click opens. Selecting on every
click would make the grid unnavigable.

The toolbar reports honestly: a job id means *queued*, not *done*, and ids that
resolved to nothing are surfaced rather than swallowed, because acting on fewer
items than were selected must not look like plain success. Each action is hidden
without its permission — not the security boundary, which is the server guard,
but a button that always fails is its own kind of lie.

The three scopes, for reference:

| Endpoint | Scope |
|---|---|
| `POST /media/items/reidentify` | `{ libraryId, matchStatus }` — a whole library |
| `POST /media/nfo/generate` | one `itemId` **or** a whole `libraryId` |
| `POST /media/items/:id/lock`, `…/metadata/fetch` | one item |

A client-side fan-out would have given N round trips, no single job to watch,
and N audit rows for one operator action. The bulk service instead resolves the
ids once (duplicates collapse; unknown ids come back as `missing` rather than
being silently dropped), skips locked items the way every other bulk path does,
refuses a selection over 1 000, and runs detached so the browser gets a job id
immediately.

## Search and filtering

Filtering happens **server-side**, and the active filters are part of the query
key, so changing one resets paging rather than appending a filtered page to an
unfiltered list.

That placement is the point: the browser holds one screenful of an incrementally
paged library. Filtering the loaded rows would search the 60 fetched so far and
confidently report no matches for a title sitting later in the library.

Search is debounced (250 ms) — each change is a round trip *and* a full list
reset — and the box does not re-emit the value it was handed, or the debounce
would fire on mount and reset paging for nothing.

A selection is cleared whenever the filters change. One made against the previous
result set would act on rows the filter has just hidden.

**What is filterable:** title (case-insensitive contains) and match status
(unmatched / matched / manual). One status at a time, because the server takes
one — letting two appear selected would misrepresent the query.

## Export

`GET /media/items/export.csv`, gated on the new `media_manager.export`
permission — export is a bulk read of library contents, which is why it is its
own permission rather than folded into `view`, matching `media_acquisition` and
`media_server_analytics`.

**Streamed, never materialised.** The analytics CSV loads up to 50 000 rows into
an array and joins it; at the sizes this workspace targets that is an
out-of-memory error rather than a slow response. Peak memory here is one page
regardless of library size.

**Keyset pagination on `id`**, not `OFFSET`. A deep offset makes Postgres walk
every skipped row, so the last page of a large export costs far more than the
first — and an offset is unstable under concurrent inserts, which skips or
repeats rows.

**The same filters as the browser.** An export that silently covers more than the
screen is a disclosure bug.

**Formula injection is neutralised.** A cell beginning `=`, `+`, `-` or `@` is
executed by spreadsheet software on open. Media titles are arbitrary text from
filenames and providers, so this is the realistic path, not a theoretical one.

The audit row is written **after** the stream drains and carries the count that
actually left — a generator created and abandoned exported nothing.

## Paging

Server-side and additive. Rows are appended as the grid nears its end, so
scrolling a very large library costs one request per screenful rather than one
enormous response. Nothing fetches a whole library.

## What Phase 1 does not do

Stated so the gaps are not mistaken for bugs:

- **The action bar covers four operations**, not the full spec list: refresh
  metadata, generate NFO, lock, unlock, plus scan with nothing selected. Rename,
  artwork, cleanup, subtitles and delete remain on their own pages until they
  grow id-list endpoints of the same shape.
- **Filters cover what the server can answer**: title search and match status.
  Resolution, HDR, codec, genre, year, studio and runtime are **not** query
  parameters on `GET /media/items` — the columns exist on `MediaFile` and
  `MediaMetadata` but nothing filters on them, so offering those controls would
  be UI that silently does nothing. They need backend query support first.
- **CSV export ships; Excel, JSON and PDF do not.** There is no PDF library in
  the repository and adding one for a table is a poor trade; Excel is CSV for
  every practical purpose here. JSON would be a small addition to the same
  service if it is wanted.
- **No issues panel** — later phase.
- **No music/audiobook/photo hierarchies** — needs the schema migration above.
- Drill-down **is** in place — Library → Show → Season → Episode, below.
- **Operations are unchanged** — metadata, artwork, rename, cleanup, subtitles
  and jobs are reached through their existing pages. The browser does not
  reimplement them, and Phase 2 wires them into a selection-aware toolbar.
