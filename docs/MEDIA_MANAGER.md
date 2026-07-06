# Media Manager

Media Manager is a **core** UltraTorrent module (id `media_manager`, route
`/api/media`, menu group **Media**) that turns completed downloads into clean,
media-server-ready libraries. It evolves the original media renamer and adds
media libraries, secure folder scanning, filename identification, metadata,
artwork and subtitle management, NFO generation, template renaming, duplicate
detection, a health dashboard, media-server integrations, automation, and a
post-download workflow — all behind the `media_manager.*` permission block.

- Backend: `apps/backend/src/modules/media/`
- Frontend: `apps/frontend/src/pages/media-manager/`
- Depends on the `auth` and `files` modules.

> **Smart Download** reads this library to compute what's *missing* — its missing
> movie/season/episode detection diffs the local IMDb catalogue against `MediaItem`s
> (with a structured `MediaItem.seriesImdbId` link populated at identification time).
> See [SMART_DOWNLOAD.md](SMART_DOWNLOAD.md) → Missing-media detection.
- REST surface: [API.md → Media Manager](API.md#media-manager--apimedia)
- Path safety: [SECURITY.md → File-path validation](SECURITY.md#file-path-validation)

---

## Contents

- [Overview](#overview)
- [Library setup](#library-setup)
- [Media identification & matching](#media-identification--matching)
- [Metadata providers](#metadata-providers)
- [IMDb integration](#imdb-integration)
- [Artwork](#artwork)
- [Subtitles](#subtitles)
- [Rename templates](#rename-templates)
- [NFO generation](#nfo-generation)
- [Post-download workflow](#post-download-workflow)
- [Media-server integrations](#media-server-integrations)
- [Automation triggers & actions](#automation-triggers--actions)
- [WebSocket job progress](#websocket-job-progress)
- [Security model](#security-model)
- [REST API](#rest-api)
- [Data model](#data-model)
- [Frontend pages](#frontend-pages)

---

## Overview

The browser talks only to `/api/media`; the backend does all scanning, matching,
renaming, and remote calls. Long-running work (scan, identify, metadata/artwork
fetch, subtitle scan, rename, NFO, server refresh) is dispatched to an in-process
queue that persists each unit as a `MediaProcessingJob` and streams progress over
WebSocket (see [job progress](#websocket-job-progress)). Every route is guarded
by `JwtAuthGuard` + `PermissionsGuard`; destructive, rename, move, and integration
actions are audited.

The pipeline, end to end:

```
scan folder ─▶ identify (parse release name) ─▶ metadata ─▶ artwork ─▶ subtitles
      │                    │                                                │
      └── health/duplicates└── rename/move (template) ──▶ NFO ──▶ media-server refresh
```

---

## Library setup

A **media library** (`MediaLibrary`) points Media Manager at a folder on disk and
declares how items in it should be organized.

| Field | Meaning |
|-------|---------|
| `name` | Display name. |
| `kind` | Library type — `tv`, `anime`, `movie`, `music`, `audiobook`, or `general` (default `tv`). |
| `path` | Root folder to scan (see the root-path rule below). |
| `preset` | Naming preset — `plex`, `jellyfin`, `emby`, `kodi`, or `custom` (default `plex`). |
| `template` | Optional per-library rename template (overrides the preset). |
| `mode` | Rename mode — `preview`, `rename_in_place`, `rename_move`, `copy`, `hardlink`, or `symlink` (default `hardlink`). |
| `isEnabled` | Whether the library participates in scans and the post-download workflow. |
| `scanIntervalMinutes` | Optional periodic re-scan interval. |
| `nfoEnabled` | Generate NFO sidecars during the workflow (default off). |
| `artworkEnabled` | Fetch artwork during the workflow (default on). |

Manage libraries under **Media → Libraries** (`POST/PATCH/DELETE
/api/media/libraries`, permission `media_manager.manage_libraries`) and trigger a
scan with `POST /api/media/libraries/:id/scan` (`media_manager.scan`).

### Secure root-path restriction

Library scanning reuses the file manager's **hard root** boundary — the same
mechanism documented in [FILE_MANAGER.md](FILE_MANAGER.md) and
[SECURITY.md](SECURITY.md#file-path-validation). `FILE_MANAGER_ROOTS`
(comma-separated, default `/downloads`) is the ops-controlled outer boundary set
in the deployment environment.

Before walking a library's tree, the scanner calls
`FilePathService.assertWithinHardRoots(library.path)`; a library whose `path`
falls outside the configured hard roots is rejected at scan time. NFO sidecar
reads are guarded the same way. This is the same canonicalized, traversal- and
symlink-safe `PathSafety` enforcement the file manager uses — Media Manager never
reaches a system directory or escapes the allow-list, regardless of what path a
library row stores. The admin-set **Default Root Path** (settings key
`fileManager.defaultRootPath`) narrows browsing within those hard roots and the
directory picker only offers in-root paths.

---

## Media identification & matching

Scanning discovers media files and creates a `MediaItem` per title. Each item
carries a `mediaType` — one of `movie`, `tv`, `anime`, `music_video`,
`documentary`, `other_video` (default `other_video`) — and a `matchStatus`:

| `matchStatus` | Meaning |
|---------------|---------|
| `unmatched` | Auto-identification could not confidently resolve the title. |
| `matched` | Auto-identified from the parsed release name. |
| `manual` | A user matched it explicitly. |

Identification parses the release name into type / title / year / season /
episode and records a `confidence` score. When the filename alone omits the
title — the common case for tidy libraries where the series name lives in the
folder (`Show/Season 01/S01E01.mkv`) — identification climbs to the first
meaningful parent folder (skipping generic `Season N` / `Specials` containers)
to recover it. Confidence is weighted by identity signals: a title plus an
episodic marker (season+episode, absolute episode, or air date) or a movie year
clears the match threshold on its own; scene tokens (resolution, source, codec,
release group) only refine an already-identified item. Unmatched items surface
under **Media → Unmatched**; resolve them by:

- `POST /api/media/items/:id/match` with an **empty body** to re-run
  auto-identification, or with a body to **match manually** (`media_manager.match`).
- `POST /api/media/items/reidentify` to **bulk re-run** auto-identification
  (`media_manager.match`), tracked as a `media_identification` job with WebSocket
  progress. Body is optional: `{ libraryId?, matchStatus? }` — omit both to
  re-identify every non-`manual` item, or pass `matchStatus: 'unmatched'` to
  retry only the failures. `manual` matches are never auto-overwritten. Returns a
  `{ total, matched, unmatched, failed }` summary.
- `POST /api/media/items/:id/unmatch` to clear a match (`media_manager.match`).
- `PATCH /api/media/items/:id` to edit item fields (`media_manager.edit_metadata`).

Parsed per-file technical attributes (container, video/audio codec, resolution,
HDR, language, release group, quality) are stored on `MediaFile` and feed the
rename tokens.

---

## Metadata providers

Metadata is resolved through the `MediaMetadataProvider` abstraction
(`apps/backend/src/modules/media/metadata-provider.ts`). Two implementations ship:

- **`local`** (`LocalMetadataProvider`) — offline; reads a local `.nfo` sidecar
  next to the media (`parseNfoXml`). Always available, no key required.
- **`tmdb`** (`TmdbMetadataProvider`) — The Movie Database (TMDB v3). Requires an
  API key.

### Configuring the TMDB key

The key is resolved at runtime (`media-metadata.service.ts`), in order:

1. The settings value **`media.tmdbApiKey`** (set via Media settings), then
2. the environment variable **`TMDB_API_KEY`**.

If neither is set, the provider silently degrades to the offline
`LocalMetadataProvider` — metadata still works from local NFO sidecars. **No
credentials are hardcoded**; the key is only injected at runtime and is never
logged or returned to clients.

Fetch metadata with `POST /api/media/items/:id/metadata/fetch`
(`media_manager.edit_metadata`); edit stored fields with `PATCH
/api/media/items/:id/metadata`. Stored metadata (`MediaMetadata`, 1:1 with an
item) includes overview, release date, runtime, genres/studios/cast/crew,
rating, certification, and the originating `providerName`. External IDs
(`MediaExternalId`: `tmdb`, `tvdb`, `imdb`, `omdb`, `anilist`) are recorded per
item.

---

## IMDb integration

IMDb ships as an additional, compliant `MediaMetadataProvider` (provider key
`imdb`, `ImdbMetadataProvider`). It enriches items with IMDb identifiers,
titles, alternate titles (AKAs), crew/principals, episode data, and IMDb
ratings — sourced **only** from data you provide or license.

> **No-scraping policy.** UltraTorrent does not scrape IMDb web pages. IMDb
> support uses user-provided IMDb datasets or licensed IMDb API access.

### Supported data sources

- **User-provided IMDb datasets** — the official IMDb non-commercial
  `.tsv.gz` files, imported into local Prisma tables and served entirely
  offline afterwards.
- **Optional licensed IMDb REST API** — an official/licensed IMDb API endpoint
  (base URL + key) that you are entitled to use. This is never imdb.com HTML;
  it is a REST API you configure yourself.

Neither source is required to run UltraTorrent. With no IMDb configuration the
provider stays **disabled** and the rest of Media Manager is unaffected.

### Provider modes

Set the mode on **Media > Settings > IMDb** (`media.imdb.mode`):

| Mode | Behaviour |
|------|-----------|
| `disabled` | IMDb provider off (default). No searches, matches, or enrichment. |
| `dataset` | Serve from imported IMDb dataset tables only (fully offline). |
| `official_api` | Query the configured licensed IMDb REST API only. |
| `hybrid` | Prefer the imported dataset; fall back to the licensed API. |

The provider is **disabled/dataset-only without API credentials** — an API key
is required for `official_api`/`hybrid` and is only ever entered in Settings.

### Dataset import setup

1. **Obtain the datasets.** Download IMDb's non-commercial datasets from
   IMDb's official datasets page (`https://datasets.imdbws.com/`), subject to
   IMDb's terms. Seven `.tsv.gz` files are required:
   - `title.basics.tsv.gz`
   - `title.akas.tsv.gz`
   - `title.crew.tsv.gz`
   - `title.episode.tsv.gz`
   - `title.principals.tsv.gz`
   - `title.ratings.tsv.gz`
   - `name.basics.tsv.gz`
2. **Place them under the Default Root Path.** Put all seven files in a folder
   that lives **under one of your `FILE_MANAGER_ROOTS`** (the Default Root
   Path). Set that folder as the **dataset path** in Settings. The path is
   canonicalised and confined by `FilePathService` — a path outside the roots is
   rejected.
3. **Validate.** Click **Validate** (or `POST
   /api/media/providers/imdb/dataset/validate`). The server checks each file
   exists, is under the root, and is a readable gzip/TSV with the expected
   header. Progress streams over `imdb.dataset.validate.*` WebSocket events.
4. **Import.** Click **Import** (or `POST
   /api/media/providers/imdb/dataset/import`). A detached, resumable job
   streams the gzipped TSV row-by-row into the IMDb tables, emitting live
   progress over `imdb.dataset.import.progress` and completing with
   `imdb.dataset.import.completed`. The endpoint returns the import record
   immediately; the job continues in the background.

An optional **import schedule** (`media.imdb.importSchedule`, a cron-style
string) can be stored to document a periodic refresh cadence; it is **off by
default** (unset) and there is no scheduled-jobs seed to enable.

### Official API setup

On **Media > Settings > IMDb**, choose `official_api` or `hybrid`, then set the
**API base URL** (`media.imdb.apiBaseUrl`) and **API key**
(`media.imdb.apiKey`). Use **Test** (`POST /api/media/providers/imdb/test`) to
verify connectivity. The key is **AES-GCM encrypted at rest**, redacted in every
API response, and never written to logs.

### Matching behaviour

- **Search** by title with optional `year`, `type` (movie/series/episode), and
  `season`/`episode`; alternate titles (AKAs) are considered
  (`GET /api/media/providers/imdb/search`, rate-limited to 30/min).
- **IMDb id lookup** returns a single title
  (`GET /api/media/providers/imdb/title/:imdbId`).
- **Manual match** attaches an IMDb id to a media item
  (`POST /api/media/items/:id/match/imdb`, body `{ imdbId, confidence? }`) with
  a confidence score; the IMDb id is stored as a `MediaExternalId` (`imdb`).
- **Rating as a rating source.** IMDb ratings are surfaced as an IMDb-sourced
  rating; IMDb is not treated as the authoritative title/artwork provider.
- **Cross-provider enrichment.** Once an IMDb id is known, it can enrich from
  **separate licensed APIs** — TMDB `/find` and OMDb (each their own key) —
  emitting `imdb.enrichment.completed`. These enrichment lookups reuse the
  existing `media.tmdbApiKey`/`TMDB_API_KEY` and `media.omdbApiKey`/
  `OMDB_API_KEY` values (Settings first, environment fallback).

Matches and enrichment finish with the `imdb.match.completed` /
`imdb.enrichment.completed` WebSocket events.

### Settings reference (`media.imdb`)

| Key | Meaning | Default |
|-----|---------|---------|
| `mode` | `disabled` / `dataset` / `official_api` / `hybrid` | `disabled` |
| `apiBaseUrl` | Licensed IMDb REST API base URL | `null` |
| `apiKey` | Licensed IMDb API key (AES-GCM encrypted, redacted) | `null` |
| `datasetPath` | Folder of `.tsv.gz` files, **under the Default Root Path** | `null` |
| `importSchedule` | Optional cron-style refresh cadence (off) | `null` |
| `preferredRegion` | Preferred AKA region | `null` |
| `preferredLanguage` | Preferred AKA language | `null` |
| `includeAdult` | Include adult titles | `false` |
| `minVotes` | Minimum vote count for ratings | `0` |
| `cacheTtl` | API response cache TTL (seconds) | `3600` |

Defaults are **code-side** (`imdb-settings.service.ts`); no settings seed is
needed — an unconfigured provider reads as `disabled`.

### Security considerations

- **Root-path restriction.** The dataset path is validated against
  `FILE_MANAGER_ROOTS` via `FilePathService`; files outside the roots are
  rejected.
- **Encrypted key.** The licensed API key is AES-GCM encrypted at rest and
  redacted (`••••••••`) in responses.
- **No secrets logged.** Neither the key nor the dataset contents are written to
  logs.
- **Audited.** Settings changes, dataset validate/import, matches, and API tests
  are recorded to the audit log.
- **RBAC + rate limiting.** Every endpoint is permission-gated (see below) and
  search is throttled.

### IMDb permissions

| Permission | Grants |
|------------|--------|
| `media_manager.imdb.view` | View IMDb status, settings (redacted), imports, and title lookups. |
| `media_manager.imdb.configure` | Change IMDb settings and test the API connection. |
| `media_manager.imdb.import_dataset` | Validate and import IMDb datasets. |
| `media_manager.imdb.search` | Search the IMDb catalogue. |
| `media_manager.imdb.match` | Match a media item to an IMDb id. |

### Troubleshooting

- **Files not found / outside root** — ensure all seven `.tsv.gz` files sit in
  the configured folder and that the folder is **under a `FILE_MANAGER_ROOTS`
  entry**. Paths outside the roots are rejected by design.
- **gzip/TSV validation fails** — the file must be a valid gzip TSV with the
  expected IMDb header; re-download if truncated or renamed.
- **Provider disabled without credentials** — `official_api`/`hybrid` need a
  base URL and key; without them use `dataset` mode after an import, or leave it
  `disabled`.

### Data model (IMDb)

Eight Prisma models back the provider: `IMDbTitle`, `IMDbAka`, `IMDbCrew`,
`IMDbEpisode`, `IMDbPrincipal`, `IMDbPerson`, `IMDbRating`, and
`IMDbDatasetImport` (the import job/history record).

---

## Artwork

Artwork (`MediaArtwork`) is typed — `poster`, `fanart`, `logo`, `clearart`,
`banner`, `thumbnail`, `season_poster`, `episode_thumbnail` — with an optional
remote `url`, a `localPath`, a `source`, dimensions, and a `selected` flag.

| Action | Endpoint | Permission |
|--------|----------|------------|
| List artwork | `GET /api/media/items/:id/artwork` | `media_manager.view` |
| Select the active artwork | `POST /api/media/items/:id/artwork/select` (`{ artworkId }`) | `media_manager.manage_artwork` |
| Upload custom artwork | `POST /api/media/items/:id/artwork/upload` | `media_manager.manage_artwork` |
| Detect missing artwork | `GET /api/media/items/:id/artwork/missing` | `media_manager.view` |

Uploads are validated (type/size), stored under a validated local path, and can
be selected as the item's artwork of its type.

---

## Subtitles

Subtitles (`MediaSubtitle`) are discovered from **sidecar files** next to the
video and recorded with `language`, `forced`, `sdh` (hearing-impaired), and a
`source`.

| Action | Endpoint | Permission |
|--------|----------|------------|
| List subtitles | `GET /api/media/items/:id/subtitles` | `media_manager.view` |
| Scan sidecar subtitles | `POST /api/media/items/:id/subtitles/scan` | `media_manager.manage_subtitles` |
| Detect missing languages | `GET /api/media/items/:id/subtitles/missing` (`?preferred=en,fr`) | `media_manager.view` |

---

## Rename templates

The rename engine (`media-renamer.ts`) renders a per-item destination path from a
template. Presets (`plex`, `jellyfin`, `emby`, `kodi`) ship default templates for
each library type (`tv`, `anime`, `movie`, `music`, `audiobook`); a library may
override with its own `template`, and named templates persist as
`MediaRenameTemplate` rows.

### Tokens

Tokens are **case-sensitive** and use `{Token}` syntax. Numeric tokens accept
zero-padding as `{Token:00}`, and `{Token?…}` renders its inner literal only when
the token is present:

| Token | Value |
|-------|-------|
| `{Movie Title}` | Movie title |
| `{Series Title}` | Series/show title |
| `{Episode Title}` | Episode title |
| `{year}` | Release year |
| `{season}` | Season number (e.g. `{season:00}`) |
| `{episode}` | Episode number (e.g. `{episode:00}`) |
| `{episodeEnd}` | End episode of a range (e.g. `{episodeEnd:00}`) |
| `{Resolution}` | e.g. `1080p`, `2160p` |
| `{Source}` | e.g. `BluRay`, `WEB-DL` |
| `{Codec}` | Video codec |
| `{Release Group}` | Release group |
| `{General}` | General/other title |
| `{ext}` | File extension |

Every path segment is sanitized (traversal neutralized), and `Season 00` is
rewritten to `Specials`.

**Movie example (Plex preset):**

```
{Movie Title} ({year})/{Movie Title} ({year}) - {Resolution}.{ext}
```

**TV example (Plex preset):**

```
{Series Title}/Season {season:00}/{Series Title} - S{season:00}E{episode:00}{episodeEnd? - E{episodeEnd:00}} - {Episode Title}.{ext}
```

### Modes and workflow

| Mode | Effect |
|------|--------|
| `preview` | Dry-run only — build the plan, touch nothing. |
| `rename_in_place` | Rename the original file in place (destructive). |
| `rename_move` | Move the original to the destination (destructive). |
| `copy` | Copy to the destination, keep the original. |
| `hardlink` | Hardlink into the library, keep the original (**default**). |
| `symlink` | Symlink into the library, keep the original. |

Hardlink/symlink/copy are non-destructive so seeding continues; only
`rename_in_place` and `rename_move` relocate the original.

- `GET /api/media/presets` — available presets (`media_manager.view`).
- `POST /api/media/preview` — build a rename plan / dry-run (`media_manager.view`).
- `POST /api/media/apply` — execute the plan (`media_manager.rename`).
- `GET /api/media/history` — rename history (`media_manager.view`).

---

## NFO generation

`POST /api/media/nfo/generate` (`media_manager.generate_nfo`) writes Kodi-style
NFO sidecars for an item (`{ itemId }`) or a whole library (`{ libraryId }`).
Generated files are tracked as `MediaNfoFile` with a `type` of `movie`,
`tvshow`, `season`, or `episode`. NFO writes are confined to the hard roots via
`PathSafety`.

---

## Post-download workflow

`MediaProcessingService` subscribes to the `torrent.completed` event and runs an
**opt-in, best-effort** pipeline (`handleTorrentCompleted`). It fires **only** for
enabled libraries whose root `path` contains the torrent's save path — arbitrary
downloads are never auto-organized. Each stage is isolated (a failure never aborts
the rest), and the handler never throws (it protects the sync loop).

Per covering library, per item:

1. **Scan** (`library_scan` job) → fires `media.detected`.
2. **Identify** (`media_identification`) → fires `media.matched` or
   `media.unmatched`; unmatched items stop here.
3. **Rename/move** per `library.mode` → fires `media.rename_completed`.
4. **Metadata** fetch.
5. **Artwork** fetch (if `artworkEnabled`) → fires `media.missing_artwork` on gaps.
6. **Subtitles** scan → fires `media.missing_subtitles` on gaps.
7. **NFO** generation (if `nfoEnabled`).
8. **Server refresh** for each enabled integration → fires
   `media.server_refresh_failed` on failure.

---

## Media-server integrations

Media Manager pushes library refreshes to external media servers via the
`MediaServerIntegration` model and the `getMediaServerProvider(kind)` abstraction.
Supported `kind` values: **`plex`, `jellyfin`, `emby`, `kodi`**. Integrations
live under `/api/media/server-integrations` (all guarded by
`media_manager.manage_integrations`) — there is no separate `/api/media-servers`
group.

| Action | Endpoint |
|--------|----------|
| List | `GET /api/media/server-integrations` |
| Create | `POST /api/media/server-integrations` |
| Update | `PATCH /api/media/server-integrations/:id` |
| Delete | `DELETE /api/media/server-integrations/:id` |
| Test connection | `POST /api/media/server-integrations/:id/test` |
| Refresh library | `POST /api/media/server-integrations/:id/refresh` |

**Encrypted config.** Secret config keys (`token`, `apiKey`, `password`) are
AES-GCM encrypted at rest via `SecretCipher` (marked with an `__encrypted`
array). Secrets are decrypted only for provider use, and **redacted to
`••••••••`** when config is returned to clients — never returned or logged. On
update, a placeholder value of only `•` characters means "keep the existing
secret." A corrupt or rotated key fails closed on that field. Test and refresh
failures are audited **without** secrets (`media.integration.test_failed`,
`media.integration.refresh_failed`); create/update/delete/refresh are audited too.

---

## Automation triggers & actions

The automation engine registers Media Manager **triggers** (category `media`) and
**actions**; the trigger/action catalog is exposed at `GET
/api/automation/catalog`.

**Triggers:**

| Trigger | Fires when… |
|---------|-------------|
| `media.detected` | A new media file is scanned. |
| `media.matched` | An item is identified/matched. |
| `media.unmatched` | An item could not be matched. |
| `media.missing_artwork` | An item is missing artwork. |
| `media.missing_subtitles` | An item is missing preferred subtitles. |
| `media.rename_completed` | A rename/move completed. |
| `media.server_refresh_failed` | A media-server refresh failed. |

**Actions:**

`media_scan_library`, `media_match`, `media_fetch_metadata`,
`media_fetch_artwork`, `media_generate_nfo`, `media_rename`, `media_move`,
`media_notify`, `media_server_refresh`.

Eight of these (all except `media_notify`) are delegated to
`MediaAutomationActions` in the media module, so the automation engine has no
engine-provider dependency for media work; `media_notify` is handled inline by
the automation engine's own notification path.

---

## WebSocket job progress

Long-running operations run through an in-process queue that persists each unit
as a `MediaProcessingJob` (`type` ∈ `library_scan | media_identification |
metadata_fetch | artwork_fetch | subtitle_scan | rename_preview | rename_execute |
nfo_generate | media_server_refresh`; `status` ∈ `queued | running | completed |
failed`) and streams lifecycle events over the RealtimeGateway:

- `media_manager.job.started`
- `media_manager.job.progress`
- `media_manager.job.completed`
- `media_manager.job.failed`

These events are **permission-scoped**: they are emitted only to the room
**`perm:media_manager.view`**, which a socket joins when the authenticated user
holds `media_manager.view`. The payload (`MediaJobEventPayload` in
`@ultratorrent/shared`) carries `jobId`, `type`, `status`, `progress`, optional
`libraryId`/`itemId`/`message`/`result`/`error`, and a timestamp.

---

## Security model

- **Root-path enforcement.** Scans and NFO reads call
  `FilePathService.assertWithinHardRoots(...)`, confining all filesystem access to
  `FILE_MANAGER_ROOTS`. Traversal, absolute-escape, symlink-escape, and system
  directories are rejected by `PathSafety`. Rename destinations are validated
  against the library root and sanitized per path segment.
- **RBAC.** Every route carries `JwtAuthGuard` + `PermissionsGuard` +
  `@RequirePermissions(...)`. The frontend hides what a user cannot do; the server
  is authoritative.
- **Encrypted provider configs.** Media-server secrets are AES-GCM encrypted at
  rest and redacted in API responses.
- **Auditing.** Destructive, rename, move, and integration actions are recorded
  with actor, IP, user agent, and result.
- **WebSocket scoping.** Job events reach only the `perm:media_manager.view` room.

### Permissions

| Permission | Grants |
|------------|--------|
| `media_manager.view` | Read dashboards, libraries, items, artwork, subtitles, duplicates, presets, history. |
| `media_manager.manage_libraries` | Create / update / delete libraries. |
| `media_manager.scan` | Trigger a library scan. |
| `media_manager.match` | Match / unmatch items. |
| `media_manager.edit_metadata` | Edit items and fetch/edit metadata. |
| `media_manager.manage_artwork` | Select / upload artwork. |
| `media_manager.manage_subtitles` | Scan subtitles. |
| `media_manager.rename` | Apply (execute) a rename plan. |
| `media_manager.move_files` | Move files (reserved). |
| `media_manager.generate_nfo` | Generate NFO sidecars. |
| `media_manager.manage_integrations` | Manage / test / refresh media-server integrations. |
| `media_manager.delete` | Delete media records (reserved). |
| `media_manager.admin` | Full module administration (reserved). |
| `media_manager.imdb.view` | View IMDb status/settings/imports/title lookups. |
| `media_manager.imdb.configure` | Change IMDb settings; test the API connection. |
| `media_manager.imdb.import_dataset` | Validate / import IMDb datasets. |
| `media_manager.imdb.search` | Search the IMDb catalogue. |
| `media_manager.imdb.match` | Match a media item to an IMDb id. |

Default role grants: Power User holds view through `generate_nfo` (not
integrations/delete/admin); User and Read-Only hold only `media_manager.view`;
Administrator and Super Admin hold all. `move_files`, `delete`, and `admin` are
declared in the catalog and reserved for planned routes — they are not enforced by
any endpoint yet.

---

## REST API

All paths are under the global `/api` prefix, `@Controller('media')`, guarded by
`JwtAuthGuard` + `PermissionsGuard`.

| Method | Path | Permission |
|--------|------|------------|
| GET | `/api/media/dashboard` | `media_manager.view` |
| GET | `/api/media/health` | `media_manager.view` |
| GET | `/api/media/libraries` | `media_manager.view` |
| POST | `/api/media/libraries` | `media_manager.manage_libraries` |
| PATCH | `/api/media/libraries/:id` | `media_manager.manage_libraries` |
| DELETE | `/api/media/libraries/:id` | `media_manager.manage_libraries` |
| POST | `/api/media/libraries/:id/scan` | `media_manager.scan` |
| GET | `/api/media/items` | `media_manager.view` (`?mediaType`, `?matchStatus`, `?libraryId`) |
| GET | `/api/media/items/:id` | `media_manager.view` |
| PATCH | `/api/media/items/:id` | `media_manager.edit_metadata` |
| POST | `/api/media/items/:id/match` | `media_manager.match` |
| POST | `/api/media/items/:id/unmatch` | `media_manager.match` |
| POST | `/api/media/items/:id/metadata/fetch` | `media_manager.edit_metadata` |
| PATCH | `/api/media/items/:id/metadata` | `media_manager.edit_metadata` |
| GET | `/api/media/items/:id/artwork` | `media_manager.view` |
| POST | `/api/media/items/:id/artwork/select` | `media_manager.manage_artwork` |
| POST | `/api/media/items/:id/artwork/upload` | `media_manager.manage_artwork` |
| GET | `/api/media/items/:id/artwork/missing` | `media_manager.view` |
| GET | `/api/media/items/:id/subtitles` | `media_manager.view` |
| POST | `/api/media/items/:id/subtitles/scan` | `media_manager.manage_subtitles` |
| GET | `/api/media/items/:id/subtitles/missing` | `media_manager.view` (`?preferred`) |
| POST | `/api/media/nfo/generate` | `media_manager.generate_nfo` |
| GET | `/api/media/duplicates` | `media_manager.view` |
| POST | `/api/media/duplicates/detect` | `media_manager.view` |
| GET | `/api/media/server-integrations` | `media_manager.manage_integrations` |
| POST | `/api/media/server-integrations` | `media_manager.manage_integrations` |
| PATCH | `/api/media/server-integrations/:id` | `media_manager.manage_integrations` |
| DELETE | `/api/media/server-integrations/:id` | `media_manager.manage_integrations` |
| POST | `/api/media/server-integrations/:id/test` | `media_manager.manage_integrations` |
| POST | `/api/media/server-integrations/:id/refresh` | `media_manager.manage_integrations` |
| GET | `/api/media/presets` | `media_manager.view` |
| POST | `/api/media/preview` | `media_manager.view` |
| POST | `/api/media/apply` | `media_manager.rename` |
| GET | `/api/media/history` | `media_manager.view` |
| GET | `/api/media/providers/imdb/status` | `media_manager.imdb.view` |
| GET | `/api/media/providers/imdb/settings` | `media_manager.imdb.view` |
| PATCH | `/api/media/providers/imdb/settings` | `media_manager.imdb.configure` |
| POST | `/api/media/providers/imdb/test` | `media_manager.imdb.configure` |
| POST | `/api/media/providers/imdb/dataset/validate` | `media_manager.imdb.import_dataset` |
| POST | `/api/media/providers/imdb/dataset/import` | `media_manager.imdb.import_dataset` |
| GET | `/api/media/providers/imdb/dataset/imports` | `media_manager.imdb.view` |
| GET | `/api/media/providers/imdb/search` | `media_manager.imdb.search` (`?title`,`?year`,`?type`,`?season`,`?episode`; 30/min) |
| GET | `/api/media/providers/imdb/title/:imdbId` | `media_manager.imdb.view` |
| POST | `/api/media/items/:id/match/imdb` | `media_manager.imdb.match` (`{ imdbId, confidence? }`) |

---

## Data model

Prisma models (`apps/backend/prisma/schema.prisma`):

| Model | Purpose |
|-------|---------|
| `MediaLibrary` | A scanned folder + its kind/preset/template/mode settings. |
| `MediaItem` | An identified title (type, match status, confidence). |
| `MediaFile` | A physical file with parsed technical attributes. |
| `MediaMetadata` | Enriched metadata (1:1 with an item). |
| `MediaArtwork` | Typed artwork (poster/fanart/…). |
| `MediaSubtitle` | Sidecar subtitle (language/forced/SDH). |
| `MediaExternalId` | External provider IDs (tmdb/tvdb/imdb/omdb/anilist). |
| `MediaCollection` / `MediaCollectionItem` | Named collections and membership. |
| `MediaRenameTemplate` | Saved rename templates per media type. |
| `MediaProcessingJob` | Queued/running/completed/failed job with progress. |
| `MediaDuplicateGroup` | A group of duplicate items and the reason. |
| `MediaServerIntegration` | Plex/Jellyfin/Emby/Kodi connector (encrypted config). |
| `MediaNfoFile` | A generated NFO sidecar (movie/tvshow/season/episode). |
| `IMDbTitle` / `IMDbAka` / `IMDbCrew` / `IMDbEpisode` / `IMDbPrincipal` / `IMDbPerson` / `IMDbRating` | Imported IMDb dataset tables (titles, AKAs, crew, episodes, principals, people, ratings). |
| `IMDbDatasetImport` | An IMDb dataset import job/history record. |

Duplicate groups are formed by reason: `title_year`, `show_season_episode`,
`external_id`, `file_hash`, or `similar_filename`.

---

## Frontend pages

All routes are wrapped in `<ModuleRoute moduleId="media_manager">` and gated on
`media_manager.view`:

| Route | Page |
|-------|------|
| `/media` | Media Dashboard |
| `/media/libraries` | Libraries |
| `/media/items` | Media Items |
| `/media/items/:id` | Item detail (metadata/artwork/subtitles/files tabs) |
| `/media/unmatched` | Unmatched items |
| `/media/duplicates` | Duplicate groups |
| `/media/rename-preview` | Rename preview / dry-run |
| `/media/settings` | Media settings (incl. TMDB key) |
| `/media/settings/imdb` | IMDb provider settings (mode, dataset, licensed API, compliance notice) |

See also: [API.md](API.md) · [MODULES.md](MODULES.md) ·
[FILE_MANAGER.md](FILE_MANAGER.md) · [SECURITY.md](SECURITY.md) ·
[ARCHITECTURE.md](ARCHITECTURE.md).
