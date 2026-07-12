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
        ▼  AcquisitionMatchPreferenceService.select() — the ranked match-preference
        │  list (quality + size cap), the same model RSS rules use
        ├─ a candidate matches ─▶ AcquisitionEvaluatorService.grabSelected() ─▶ torrent client
        └─ nothing matches (e.g. all over the size cap) ─▶ no_results
```

Two independent halves are wired together here: **detection** (Missing Episodes,
which enumerates a series' episodes from the local IMDb catalogue and diffs the
library) and the **download pipeline** (the match-preference selector + executor
that picks a release and adds it to the torrent client). The indexer subsystem
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

1. For each episode it queries the indexers (`show title` + season + ep) and
   filters candidates to the exact `SxxEyy` (plus a loose show-title match) via
   `parseTorrentName`.
2. The survivors are gated through the **auto-download match preferences**
   (`AcquisitionMatchPreferenceService`) — the same ranked candidate list +
   `qualityRules` + `sizeRules` model RSS rules use. The winner is the one
   matching the highest-priority candidate, tie-broken by magnet, then seeders.
   The show's linked **Show Rule** (`rssRuleId`) supplies the list when set;
   otherwise the **global defaults** apply. A quality profile is **not**
   consulted here.
3. The winner is grabbed via `AcquisitionEvaluatorService.grabSelected()`, which
   records a `download` evaluation + action and runs the Smart Download executor
   — bypassing the scorer/decision engine, since the preference list already
   applied quality + size gating. Nothing matching the preferences (e.g.
   everything over the size cap) ⇒ `no_results`.
4. The save path is resolved with a layered fallback (linked Show Rule's
   `savePath` → an RSS rule named after the show → the show's existing library
   folder → `<TV library>/<Title> (Year)`), so grabbed episodes land beside the
   show's other files rather than in the engine's default download dir.
5. Grab-state is written back onto the `WantedEpisode` (`searchStatus`,
   `grabbedAt`, `grabbedEvaluationId`, `releaseTitle`) and **preserved across
   rescans** (like user `ignored` overrides), so a grabbed/searched episode is
   not re-searched. State drops automatically once the episode is owned.

`searchStatus`: `idle → searching → grabbed | no_results | failed`. (The column
also still allows `pending_approval` from when the bridge routed through the
approval queue; the match-preference path never sets it.)

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
| `missingSearchProfileId` | `null` | Legacy — the bridge now selects via match preferences and no longer reads a quality profile |
| `maxSearchesPerSweep` | `50` | Episodes searched per sweep tick |

Which *release* gets grabbed is configured under **Acquisition Intelligence →
Auto-download** (the global match-preference list), or by linking the show to an
RSS rule and using that rule's Match Preferences.

### Duplicate-grab safeguards (layered)
The sweep only considers `status=missing` rows (an owned episode is reclassified
by the scan) · `searchStatus` excludes already-grabbed rows · `lastSearchedAt`
backoff · a re-entrancy guard on the sweep · cross-indexer dedup in `searchAll`.

## UI

- **Indexers** page (`/indexers`, nav under Downloads, permission `indexers.view`):
  add/edit/delete indexers, a **Test** button that runs `t=caps` and shows OK/error,
  and a status badge per indexer. The API-key field is write-only (masked
  `••••••••`); leaving it blank on edit keeps the stored key.
- **Missing Episodes** page: each missing episode shows a **Search now** button and
  a `searchStatus` badge (searching / grabbed / no release / failed); each series
  has a **Search all** button. Both require `media_acquisition.evaluate`.
- **Acquisition Intelligence → Auto-download** tab (`AutoDownloadPreferencesTab`):
  the ranked global match-preference list the sweep grabs by (quality + size cap
  per candidate). Seeded on first boot with *1080p x265 (≤1 GB)* then *720p x265
  (≤700 MB)*. Editing requires `media_acquisition.manage_profiles`
  (`/api/media-acquisition/match-preferences`).

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
