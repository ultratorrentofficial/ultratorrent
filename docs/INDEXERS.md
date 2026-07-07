# Indexers & Missing-Episode Auto-Acquire

UltraTorrent can search external **Torznab/Newznab indexers** for releases and
automatically fill gaps detected by **Missing Episodes** — the bridge that turns
"this episode is missing" into "search → evaluate → download".

## Overview

```
Missing Episodes scan ─▶ WantedEpisode(status=missing)
        │
        ▼  (scheduled sweep, opt-in) or manual "Search now"
MissingEpisodeSearchService
        │  IndexerService.searchAll(show, SxxEyy)  ── Torznab/Newznab, all enabled indexers
        ▼
  candidate releases ─▶ filter to exact SxxEyy (parseTorrentName)
        │
        ▼  AcquisitionEvaluatorService.evaluate({ releaseName, downloadUrl, … })
   quality profile + decision engine
        ├─ auto-download (profile satisfied, no approval)  ─▶ torrent client
        └─ hold for approval  ─▶ approval queue
```

Two independent halves are wired together here: **detection** (Missing Episodes,
which enumerates a series' episodes from the local IMDb catalogue and diffs the
library) and the **download pipeline** (the evaluator/decision-engine/executor
that scores a release and adds it to the torrent client). The indexer subsystem
is the missing search step between them.

## Indexers

An **Indexer** (`indexers` table) is a Torznab or Newznab search endpoint:

| Field | Meaning |
|-------|---------|
| `name` | Display name |
| `implementation` | `torznab` \| `newznab` |
| `baseUrl` | The API base (e.g. a Jackett/Prowlarr torznab URL; `/api` is appended if absent) |
| `apiKey` | **AES-256-GCM encrypted at rest** (SecretCipher); never returned by the API |
| `enabled` | Whether the search fan-out includes it |
| `priority` | Lower = tried first; also the dedup tie-breaker |
| `categories` | Newznab categories to query (default `5000,5030,5040` = TV) |
| `minSeeders` | Optional floor; a candidate below it is dropped |
| `capabilities` | Cached `t=caps` negotiation (tv/movie search, categories, limits) |
| `status` / `lastTestedAt` | Last Test result |

### API (`/api/indexers`, RBAC-gated)

| Method | Route | Permission |
|--------|-------|------------|
| GET | `/indexers` | `indexers.view` |
| GET | `/indexers/:id` | `indexers.view` |
| POST | `/indexers` | `indexers.manage` |
| PATCH | `/indexers/:id` | `indexers.manage` |
| DELETE | `/indexers/:id` | `indexers.manage` |
| POST | `/indexers/:id/test` | `indexers.test` |
| GET | `/indexers/:id/search?q=&season=&ep=` | `indexers.test` |

API keys are **redacted** (`••••••••`) on every read; sending the mask on update
keeps the existing key. The key is injected into the `apikey=` query param and
the full URL is never logged.

### Torznab client behavior
- `t=caps` negotiation is cached; if an indexer doesn't advertise `tv-search`, the
  client falls back to `t=search&q="Show SxxEyy"`.
- Both **magnet** and plain **`.torrent`** links are accepted (the download
  executor handles either); magnet is preferred.
- `seeders`/`size` come from `torznab:attr`/`newznab:attr`; a missing seeder count
  is treated as unknown (never as 0), so it doesn't block an otherwise-valid grab.
- `searchAll` fans out across enabled indexers (priority order), isolates
  per-indexer failures, filters by `minSeeders`, and dedups candidates
  cross-indexer by info-hash (falling back to release identity).

## The auto-acquire bridge

`MissingEpisodeSearchService` searches for `WantedEpisode`s with `status=missing`:

1. For each episode it queries the indexers (`show title` + season + ep),
   filters candidates to the exact `SxxEyy` via `parseTorrentName`, and picks the
   best (magnet preferred, then seeders).
2. It hands the winner to `AcquisitionEvaluatorService.evaluate()` — the *same*
   pipeline RSS/manual grabs use. The quality profile decides: a satisfied,
   non-approval decision **auto-downloads**; otherwise it lands in the
   **approval queue**.
3. Grab-state is written back onto the `WantedEpisode` (`searchStatus`,
   `grabbedAt`, `grabbedEvaluationId`, `releaseTitle`) and **preserved across
   rescans** (like user `ignored` overrides), so a grabbed/searched episode is
   not re-searched. State drops automatically once the episode is owned.

`searchStatus`: `idle → searching → grabbed | pending_approval | no_results | failed`.

### Triggers
- **Scheduled sweep** — runs on the acquisition scheduler tick, **opt-in and OFF
  by default**. Enable via settings; a per-episode `lastSearchedAt` backoff
  (`searchIntervalMinutes`) enforces the effective cadence and a bounded batch
  (`maxSearchesPerSweep`) caps work per run.
- **Manual** — `POST /media-acquisition/missing-episodes/:id/search` (one episode)
  and `POST /media-acquisition/missing-episodes/series/:watchlistItemId/search`
  (a whole series), permission `media_acquisition.evaluate`. Manual search runs
  whenever the module is enabled, regardless of the auto-search setting.

### Settings (`media_acquisition.settings`)
| Key | Default | Meaning |
|-----|---------|---------|
| `autoSearchMissing` | `false` | Enable the scheduled sweep |
| `searchIntervalMinutes` | `60` | Per-episode re-search backoff |
| `missingSearchProfileId` | `null` | Quality profile for grabs (else the watchlist item's) |
| `maxSearchesPerSweep` | `50` | Episodes searched per sweep tick |

### Duplicate-grab safeguards (layered)
`searchStatus` excludes grabbed/pending rows · `lastSearchedAt` backoff · a
re-entrancy guard on the sweep · cross-indexer dedup in `searchAll` · and the
evaluator's own **owned** check (it returns `skip` if the library already has it).

## UI

- **Indexers** page (`/indexers`, nav under Downloads, permission `indexers.view`):
  add/edit/delete indexers, a **Test** button that runs `t=caps` and shows OK/error,
  and a status badge per indexer. The API-key field is write-only (masked
  `••••••••`); leaving it blank on edit keeps the stored key.
- **Missing Episodes** page: each missing episode shows a **Search now** button and
  a `searchStatus` badge (searching / grabbed / awaiting approval / no release /
  failed); each series has a **Search all** button. Both require
  `media_acquisition.evaluate`.

## Notifications & events
A successful grab emits `media.missing_episode_filled` on the Notification Center
bus and broadcasts `media_acquisition.missing_episode.grabbed` over realtime.

## Security notes
- API keys are AES-256-GCM encrypted (SecretCipher), redacted in responses, and
  the request URL (which carries `apikey=`) is never logged.
- Every indexer route is RBAC-gated (`indexers.*`).

## Known limitations
- **RSS feeds are not indexers.** Only Torznab/Newznab endpoints are searched here.
- A candidate only matches when its scene title parses to the show name; shows
  known by an alias different from the watchlist title may not match (the release
  is skipped rather than mis-grabbed).
- Movies (`WantedMovie`) carry the same grab-state columns but auto-search is
  episode-only for now.
