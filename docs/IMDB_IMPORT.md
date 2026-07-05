# IMDb Import — Optimized Movie Import

UltraTorrent imports IMDb metadata from the **official non-commercial IMDb
datasets** (the `.tsv.gz` files distributed at `datasets.imdbws.com`). It does
**not** scrape imdb.com — see [ARCHITECTURE.md](ARCHITECTURE.md) for the
compliance boundary.

By default UltraTorrent runs the **Optimized Movie Import** strategy
(`imdb_import_strategy = optimized_movies`) instead of blindly importing every
dataset. This page explains what it imports, why, and how to change it.

## Why an optimized subset?

The full IMDb dataset is large and mostly irrelevant to UltraTorrent's job —
**acquiring, matching, ranking, and describing movies**. `title.principals`
alone is ~90M rows of cast/crew links, and `title.episode` is TV-episode
structure. Importing everything wastes disk, memory, and hours of import time
for data the movie workflow never reads.

The optimized strategy imports a lean, production-ready slice tuned for that
workflow, and skips the rest.

## What gets imported

**Imported first (always):**

| Dataset | Table | Notes |
|---|---|---|
| `title.basics.tsv.gz` | `imdb_titles` | Filtered — see below |
| `title.ratings.tsv.gz` | `imdb_ratings` | Only for imported titles |
| `title.akas.tsv.gz` | `imdb_akas` | Only for imported titles; toggleable |

**Optional (off unless enabled):**

| Dataset | Table | Setting |
|---|---|---|
| `title.crew.tsv.gz` | `imdb_crew` | `importCrew` |
| `name.basics.tsv.gz` | `imdb_persons` | `importPeople` (large) |

**Never imported by the optimized strategy:**

- `title.principals.tsv.gz` — ~90M cast/crew link rows; not needed for movie
  acquisition/matching/ranking.
- `title.episode.tsv.gz` — TV-episode structure; out of scope for movies.

To import these too, switch the strategy to **Full import** (see below).

### Title filter

A `title.basics` row is imported only when **all** hold:

- `titleType` ∈ (`movie`, `tvMovie`, `video`)
- `isAdult` = 0 (adult titles are never imported)
- `startYear` ≥ the configured minimum year (default **1970**)

Stored columns: `tconst`, `titleType`, `primaryTitle`, `originalTitle`,
`isAdult`, `startYear`, `endYear`, `runtimeMinutes`, `genres`.

Ratings store `averageRating` + `numVotes`; AKAs store `ordering`, `title`,
`region`, `language`, `types`, `attributes`, `isOriginalTitle` — but only for a
`titleId` that was imported in the title step (referential integrity; orphan
rows are counted and skipped).

## Configuration

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `IMDB_MIN_YEAR` | `1970` | Minimum `startYear` for imported titles. |
| `IMDB_IMPORT_BATCH_SIZE` | `5000` | Streaming insert/upsert batch size. |

The admin **minimum year** setting overrides `IMDB_MIN_YEAR`; `IMDB_MIN_YEAR`
overrides the built-in 1970 default.

### Admin settings (Media → IMDb Import → Import strategy)

- **Strategy** — `Optimized Movie Import` (default) or `Full import`.
- **Minimum year** — floor for imported titles.
- **Import alternate titles (AKAs)** — on by default.
- **Import crew** — off by default.
- **Import people** — off by default (large).

The panel also shows the selected datasets, a warning that `title.principals`
is intentionally skipped, and the latest run's stats (rows scanned/imported and
each skip bucket).

### Enabling crew / people later

Turn on **Import crew** and/or **Import people** in the admin panel (or set
`importCrew` / `importPeople` in the `media.imdb` setting), then run the import
again. Both are additive — they import into `imdb_crew` / `imdb_persons` for the
already-imported titles without re-touching the rest.

## Running an import

- **Run import** — download the datasets (if missing) then import them; progress
  streams over WebSocket.
- **Validate datasets** — check the `.tsv.gz` files are present and well-formed.
- **Reset & reimport** — wipe all imported IMDb rows and reimport from scratch
  (use after changing the minimum year or strategy).

Imports are **streamed** (never loaded whole into memory), written in bounded
batches, **idempotent** (safe to re-run — natural-key dedup per table), and
**resumable** (completed files are recorded on the import row). Import stats
(`rowsScanned`, `rowsImported`, `skippedTitleType`, `skippedAdult`,
`skippedMinYear`, `skippedParentMissing`, `errors`, `durationMs`) are persisted
on each import record.

## Full import

Setting the strategy to **Full import** (`imdb_import_strategy = full`) restores
the legacy behaviour: every present dataset file is imported as-is, including
`title.principals` and `title.episode`. This is available for operators who want
the complete mirror; expect a much larger database and longer import time.

## Release matching

Torrent/release-name matching against IMDb (`ImdbMetadataProvider.searchTitle`)
matches on `primaryTitle`, `originalTitle`, and the imported `title.akas`
alternate titles, prefers an exact-year match, then ranks by vote count, then by
average rating (rating only breaks ties once title/year confidence and
popularity agree). Adult titles are excluded — and, under the optimized
strategy, are never in the database to begin with.
