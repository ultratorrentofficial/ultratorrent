# Missing Episodes

UltraTorrent can tell you which episodes of a TV series you **don't** have yet, by
diffing the local IMDb episode catalogue against your media library — a Sonarr-style
"missing episodes" view. It is **detect + view** today: it finds and lists the gaps.
It does not (yet) automatically fetch them.

See [ARCHITECTURE.md](ARCHITECTURE.md) for where this sits in the Media Acquisition
module, and [IMDB_IMPORT.md](IMDB_IMPORT.md) for the episode data it relies on.

## What it needs

1. **TV episodes in the local IMDb mirror.** The "what episodes should exist" set comes
   from `imdb_episodes`, which is only populated when the IMDb import runs with **Import
   TV series & episodes** enabled (`importTvShows`). A movies-only import has no episodes
   to diff against.
2. **A monitored series.** A series is monitored when it's on the Media Acquisition
   **watchlist** as a `series` (or `season`) item **with an IMDb ID** in its external ids
   (e.g. `tt0903747`). The watchlist add/edit dialog has an **IMDb ID** field for this.
   Without an IMDb ID the series shows as *not monitorable*.

   **Bulk-add from the library:** rather than hand-typing each show, the Missing Episodes
   page has an **Add from library** picker (`AddSeriesFromLibraryDialog`) — a searchable
   multi-select of the TV series already in your libraries, with their IMDb IDs resolved
   automatically (from each show's `seriesImdbId`, or an episode's `imdb` external id).
   Select the shows to monitor and add them all at once (`POST /watchlist/bulk`); series
   already on the watchlist are shown pre-checked and locked, and shows with no resolvable
   IMDb ID are flagged (addable, but re-identify the library to make them scannable).

## How the diff works

For each monitored series the scan:

1. Enumerates every episode of the series from `imdb_episodes`
   (`parentTitleId = <series tconst>`), joined to `imdb_titles` for the episode title and
   air year.
2. Determines which episodes the **library** owns. Primary signal is the structured
   `MediaItem.seriesImdbId` link (set during identification for TV/anime items); if a
   library hasn't been re-identified yet, it falls back to a case-insensitive **title
   match** against the series title.
3. Classifies every catalogue episode and stores it as a `WantedEpisode` row:

   | Status | Meaning |
   |---|---|
   | `owned` | The library has this season/episode. |
   | `missing` | Aired (has a past air year) and not owned. |
   | `unaired` | Air year is in the future or unknown — can't be acquired yet. |
   | `ignored` | You opted this episode out; it survives rescans. |

   Season 0 (specials) is excluded from the missing math.

The result is per-series counts (owned / total / missing / unaired / ignored) plus a
season→episode grid. Scans are idempotent — rescanning rebuilds everything except your
`ignored` overrides.

## Using it

**Media Acquisition → Missing Episodes** (permission `media_acquisition.view`; scanning /
ignoring needs `media_acquisition.manage_watchlist`).

- **Scan all** — scan every monitored series.
- **Scan** (per series) — rescan one series.
- Expand a series to see its seasons/episodes; **Ignore** an episode to drop it from the
  missing count (**Unignore** to restore it).

### Accuracy caveats

- **Ownership tracks identification quality.** `MediaItem.season`/`episode` are filled by
  filename identification, not by a raw scan. A library with poorly-named or unidentified
  files will over-report "missing." Re-identify a library for the most accurate results.
- **The mirror lags IMDb.** The catalogue is only as fresh as your last IMDb import, and
  the optimized import drops episodes with no/pre-minimum-year air date. The page shows the
  mirror date; very recent episodes may not appear until the mirror updates.

## API

All under `/api/media-acquisition`:

| Method + path | Permission | Purpose |
|---|---|---|
| `GET  /missing-episodes` | `media_acquisition.view` | Per-series summary (owned/total/missing/…). |
| `GET  /missing-episodes/:watchlistItemId` | `media_acquisition.view` | Episode grid for one series. |
| `POST /missing-episodes/scan` | `media_acquisition.manage_watchlist` | `{ watchlistItemId? }` — scan one series, or all if omitted. |
| `POST /missing-episodes/:id/ignore` · `/unignore` | `media_acquisition.manage_watchlist` | Toggle an episode's ignore state. |

## Not included (yet)

- **Auto-acquisition.** The wanted list is not yet fed into the evaluator/RSS pipeline —
  detection only. (The plumbing is designed for it: creating `episode` watchlist items for
  the gaps would let the existing `needed = watchlist.matched && !owned` flow fill them.)
- **Active search.** There is no indexer search to go fetch a named episode on demand.
- **Scheduled rescans.** Scanning is manual; there is no periodic sweep yet.
