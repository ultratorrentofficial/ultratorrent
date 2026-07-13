---
'@ultratorrent/backend': minor
'@ultratorrent/frontend': minor
---

feat(media): the library is the source of truth for where a TV show lives

A TV show's folder used to be re-derived in memory, three separate times, by
climbing `showFolderRoot()` from every episode row — once for the media browser,
once for the watchlist picker, and once to choose a download's target folder. The
last one had to **reconstruct** a folder name from the show's title whenever it
matched nothing, which is how `TV Shows/Ghosts 2021 (2021)`, `TV Shows/Happys Place`
and `TV Shows/Magnum P.I (2018)` came to exist beside the real folders.

New **`MediaShow`** model (`media_shows`): the scanner records one row per show
**folder it actually saw** — `title`, `year`, `path`, `imdbId`, `canonicalKey`,
`episodeCount` — unique on `(libraryId, path)` and pruned when a folder's last item
goes. A monitored show binds to one of these rows via the new
`MediaAcquisitionWatchlistItem.libraryShowId` (FK, `ON DELETE SET NULL`), so an
acquired episode is filed into a path the library **observed**: nothing is matched,
nothing is built.

- `librarySeries()` reads the table instead of re-deriving shows from ~25k episode
  rows on every picker load. The picker carries the show's id back on add.
- The legacy name-resolution chain survives only for a show that is **not yet in the
  library** (a first-ever grab has no folder to bind to).
- `canonicalKey` is compared by **equality** on a case/punctuation-insensitive,
  year-stripped form — never a substring test — so `Ghosts US` cannot collide with
  `Ghosts UK`, and the `Rise` / `Rise of the Merlin` class of bug is not reintroduced.

**No backfill.** The table is valid empty and the next library scan (manual, or the
5-minute scheduler tick) populates it; until then the picker falls back to the old
derivation and items bind by name exactly as before.
