---
id: api
title: REST API Reference
sidebar_position: 1
description: Every REST endpoint UltraTorrent exposes, with its verb, path and required permission.
keywords: [api, rest, endpoints, curl, javascript, python, powershell, authentication, bearer]
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# REST API Reference

:::info Auto-generated
This page is generated from `the @Controller / @Get / @RequirePermissions decorators in apps/backend/src` at build time. **Do not edit it by hand** — change the source and rebuild. This guarantees the reference always matches the code that ships.
:::

Every endpoint below was read from the controllers themselves, including the **exact
permission** its guard enforces.

- **273 endpoints** across **14 controllers**
- Base URL: `http://<host>:<port>/api`

## Authentication

All endpoints except `/api/auth/login` require a **Bearer token**.

```bash
# 1. Log in to get an access token
curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<password>"}'
# → { "accessToken": "eyJ...", "refreshToken": "..." }

# 2. Use it
curl -s http://localhost:8080/api/torrents \
  -H 'Authorization: Bearer eyJ...'
```

Access tokens are short-lived; use the refresh token to rotate. See [Authentication](/develop/authentication).

## Authorization

Each endpoint declares a permission (the **Permission** column below). A token whose role
lacks that permission gets **`403 Forbidden`**. The full catalogue is in the
[Permissions Reference](/reference/permissions).

## Common status codes

| Code | Meaning |
| --- | --- |
| `200` / `201` | Success |
| `400` | Validation failed (bad body/query) |
| `401` | Missing or expired token |
| `403` | Token valid, but the role lacks the required permission |
| `404` | Resource does not exist |
| `500` | Server error — check [logs](/operate/troubleshooting) |

## Client examples

<Tabs>
<TabItem value="curl" label="cURL">

```bash
curl -s http://localhost:8080/api/torrents -H "Authorization: Bearer $TOKEN"
```

</TabItem>
<TabItem value="ts" label="TypeScript">

```ts
const res = await fetch('http://localhost:8080/api/torrents', {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
const torrents = await res.json();
```

</TabItem>
<TabItem value="py" label="Python">

```python
import requests
r = requests.get(
    "http://localhost:8080/api/torrents",
    headers={"Authorization": f"Bearer {token}"},
    timeout=30,
)
r.raise_for_status()
torrents = r.json()
```

</TabItem>
<TabItem value="ps" label="PowerShell">

```powershell
$headers = @{ Authorization = "Bearer $Token" }
Invoke-RestMethod -Uri "http://localhost:8080/api/torrents" -Headers $headers
```

</TabItem>
</Tabs>

## `/audit`

From `AuditController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/audit` | `AUDIT_VIEW` | `list` |

## `/auth`

From `AuthController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | — | `login` |
| `POST` | `/api/auth/refresh` | — | `refresh` |
| `POST` | `/api/auth/logout` | — | `logout` |
| `GET` | `/api/auth/me` | — | `me` |
| `POST` | `/api/auth/change-password` | — | `changePassword` |

## `/engines`

From `EngineController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/engines` | `SYSTEM_VIEW` | `list` |
| `GET` | `/api/engines/health` | `SYSTEM_VIEW` | `health` |
| `POST` | `/api/engines/test` | `ENGINES_MANAGE` | `test` |
| `POST` | `/api/engines` | `ENGINES_MANAGE` | `create` |
| `PATCH` | `/api/engines/:id` | `ENGINES_MANAGE` | `update` |
| `DELETE` | `/api/engines/:id` | `ENGINES_MANAGE` | `remove` |

## `/files`

From `FilesController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/files` | `FILES_VIEW` | `browse` |
| `GET` | `/api/files/root` | `FILES_VIEW` | `root` |
| `PUT` | `/api/files/root` | `SETTINGS_MANAGE_ROOT_PATH` | `setRoot` |
| `GET` | `/api/files/properties` | `FILES_VIEW` | `properties` |
| `GET` | `/api/files/preview` | `FILES_PREVIEW` | `preview` |
| `GET` | `/api/files/download` | `FILES_DOWNLOAD` | `download` |
| `GET` | `/api/files/inspect` | `FILES_VIEW` | `inspect` |
| `POST` | `/api/files/folders` | `FILES_CREATE_FOLDER` | `createFolder` |
| `POST` | `/api/files/ensure-dir` | `FILES_CREATE_FOLDER` | `ensureDir` |
| `POST` | `/api/files/rename` | `FILES_RENAME` | `rename` |
| `POST` | `/api/files/move` | `FILES_MOVE` | `move` |
| `POST` | `/api/files/copy` | `FILES_COPY` | `copy` |
| `POST` | `/api/files/delete` | `FILES_DELETE` | `remove` |
| `POST` | `/api/files/bulk` | `FILES_BULK_ACTIONS` | `bulk` |
| `POST` | `/api/files/cleanup-preview` | `FILES_CLEANUP` | `cleanupPreview` |
| `POST` | `/api/files/cleanup-execute` | `FILES_CLEANUP` | `cleanupExecute` |
| `GET` | `/api/files/trash` | `FILES_VIEW` | `listTrash` |
| `POST` | `/api/files/trash/restore` | `FILES_DELETE` | `restore` |
| `POST` | `/api/files/trash/purge` | `FILES_DELETE` | `purge` |
| `POST` | `/api/files/trash/empty` | `FILES_DELETE` | `empty` |

## `/indexers`

From `IndexersController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/indexers` | `INDEXERS_VIEW` | `list` |
| `GET` | `/api/indexers/:id` | `INDEXERS_VIEW` | `get` |
| `POST` | `/api/indexers` | `INDEXERS_MANAGE` | `create` |
| `PATCH` | `/api/indexers/:id` | `INDEXERS_MANAGE` | `update` |
| `DELETE` | `/api/indexers/:id` | `INDEXERS_MANAGE` | `remove` |
| `POST` | `/api/indexers/:id/test` | `INDEXERS_TEST` | `test` |
| `GET` | `/api/indexers/:id/search` | `INDEXERS_TEST` | `search` |

## `/integrations/prowlarr`

From `ProwlarrController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/integrations/prowlarr` | `INTEGRATIONS_PROWLARR_VIEW` | `get` |
| `PATCH` | `/api/integrations/prowlarr` | `INTEGRATIONS_PROWLARR_MANAGE` | `update` |
| `POST` | `/api/integrations/prowlarr/test` | `INTEGRATIONS_PROWLARR_TEST` | `test` |
| `GET` | `/api/integrations/prowlarr/status` | `INTEGRATIONS_PROWLARR_VIEW` | `status` |
| `POST` | `/api/integrations/prowlarr/open` | `INTEGRATIONS_PROWLARR_OPEN` | `open` |

## `/media`

From `MediaController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/media/dashboard` | `MEDIA_MANAGER_VIEW` | `dashboard` |
| `GET` | `/api/media/health` | `MEDIA_MANAGER_VIEW` | `health` |
| `GET` | `/api/media/libraries` | `MEDIA_MANAGER_VIEW` | `listLibraries` |
| `POST` | `/api/media/libraries` | `MEDIA_MANAGER_MANAGE_LIBRARIES` | `createLibrary` |
| `PATCH` | `/api/media/libraries/:id` | `MEDIA_MANAGER_MANAGE_LIBRARIES` | `updateLibrary` |
| `DELETE` | `/api/media/libraries/:id` | `MEDIA_MANAGER_MANAGE_LIBRARIES` | `removeLibrary` |
| `POST` | `/api/media/libraries/:id/scan` | `MEDIA_MANAGER_SCAN` | `scanLibrary` |
| `POST` | `/api/media/libraries/:id/organize` | `MEDIA_MANAGER_RENAME` | `organizeLibrary` |
| `GET` | `/api/media/items` | `MEDIA_MANAGER_VIEW` | `listItems` |
| `GET` | `/api/media/series` | `MEDIA_MANAGER_VIEW` | `listSeries` |
| `GET` | `/api/media/series/episodes` | `MEDIA_MANAGER_VIEW` | `seriesEpisodes` |
| `GET` | `/api/media/items/:id` | `MEDIA_MANAGER_VIEW` | `getItem` |
| `PATCH` | `/api/media/items/:id` | `MEDIA_MANAGER_EDIT_METADATA` | `updateItem` |
| `POST` | `/api/media/items/reidentify` | `MEDIA_MANAGER_MATCH` | `reidentifyItems` |
| `POST` | `/api/media/items/:id/match` | `MEDIA_MANAGER_MATCH` | `matchItem` |
| `POST` | `/api/media/items/:id/unmatch` | `MEDIA_MANAGER_MATCH` | `unmatchItem` |
| `POST` | `/api/media/items/:id/metadata/fetch` | `MEDIA_MANAGER_EDIT_METADATA` | `fetchMetadata` |
| `PATCH` | `/api/media/items/:id/metadata` | `MEDIA_MANAGER_EDIT_METADATA` | `updateMetadata` |
| `GET` | `/api/media/items/:id/artwork` | `MEDIA_MANAGER_VIEW` | `listArtwork` |
| `POST` | `/api/media/items/:id/artwork/select` | `MEDIA_MANAGER_MANAGE_ARTWORK` | `selectArtwork` |
| `POST` | `/api/media/items/:id/artwork/upload` | `MEDIA_MANAGER_MANAGE_ARTWORK` | `uploadArtwork` |
| `POST` | `/api/media/items/:id/artwork/import` | `MEDIA_MANAGER_MANAGE_ARTWORK` | `importArtwork` |
| `GET` | `/api/media/items/:id/artwork/missing` | `MEDIA_MANAGER_VIEW` | `missingArtwork` |
| `GET` | `/api/media/artwork/:artworkId/image` | `MEDIA_MANAGER_VIEW` | `artworkImage` |
| `GET` | `/api/media/items/:id/subtitles` | `MEDIA_MANAGER_VIEW` | `listSubtitles` |
| `POST` | `/api/media/items/:id/subtitles/scan` | `MEDIA_MANAGER_MANAGE_SUBTITLES` | `scanSubtitles` |
| `GET` | `/api/media/items/:id/subtitles/missing` | `MEDIA_MANAGER_VIEW` | `missingSubtitles` |
| `POST` | `/api/media/nfo/generate` | `MEDIA_MANAGER_GENERATE_NFO` | `generateNfo` |
| `GET` | `/api/media/duplicates` | `MEDIA_MANAGER_VIEW` | `listDuplicates` |
| `POST` | `/api/media/duplicates/detect` | `MEDIA_MANAGER_VIEW` | `detectDuplicates` |
| `GET` | `/api/media/server-integrations` | `MEDIA_MANAGER_MANAGE_INTEGRATIONS` | `listIntegrations` |
| `POST` | `/api/media/server-integrations` | `MEDIA_MANAGER_MANAGE_INTEGRATIONS` | `createIntegration` |
| `PATCH` | `/api/media/server-integrations/:id` | `MEDIA_MANAGER_MANAGE_INTEGRATIONS` | `updateIntegration` |
| `DELETE` | `/api/media/server-integrations/:id` | `MEDIA_MANAGER_MANAGE_INTEGRATIONS` | `removeIntegration` |
| `POST` | `/api/media/server-integrations/:id/test` | `MEDIA_MANAGER_MANAGE_INTEGRATIONS` | `testIntegration` |
| `POST` | `/api/media/server-integrations/:id/refresh` | `MEDIA_MANAGER_MANAGE_INTEGRATIONS` | `refreshIntegration` |
| `POST` | `/api/media/providers/tmdb/test` | `SETTINGS_MANAGE` | `testTmdbApi` |
| `GET` | `/api/media/providers/imdb/status` | `MEDIA_MANAGER_IMDB_VIEW` | `imdbStatus` |
| `GET` | `/api/media/providers/imdb/settings` | `MEDIA_MANAGER_IMDB_VIEW` | `imdbSettings` |
| `PATCH` | `/api/media/providers/imdb/settings` | `MEDIA_MANAGER_IMDB_CONFIGURE` | `updateImdbSettings` |
| `POST` | `/api/media/providers/imdb/test` | `MEDIA_MANAGER_IMDB_CONFIGURE` | `testImdbApi` |
| `POST` | `/api/media/providers/imdb/dataset/validate` | `MEDIA_MANAGER_IMDB_IMPORT_DATASET` | `validateImdbDataset` |
| `POST` | `/api/media/providers/imdb/dataset/import` | `MEDIA_MANAGER_IMDB_IMPORT_DATASET` | `importImdbDataset` |
| `POST` | `/api/media/providers/imdb/dataset/import/stop` | `MEDIA_MANAGER_IMDB_IMPORT_DATASET` | `stopImdbImport` |
| `POST` | `/api/media/providers/imdb/dataset/update-now` | `MEDIA_MANAGER_IMDB_IMPORT_DATASET` | `updateImdbDatasetNow` |
| `POST` | `/api/media/providers/imdb/dataset/reset` | `MEDIA_MANAGER_IMDB_IMPORT_DATASET` | `resetImdbData` |
| `GET` | `/api/media/providers/imdb/dataset/imports` | `MEDIA_MANAGER_IMDB_VIEW` | `imdbImports` |
| `GET` | `/api/media/providers/imdb/search` | `MEDIA_MANAGER_IMDB_SEARCH` | `imdbSearch` |
| `GET` | `/api/media/providers/imdb/title/:imdbId` | `MEDIA_MANAGER_IMDB_VIEW` | `imdbTitle` |
| `POST` | `/api/media/items/:id/match/imdb` | `MEDIA_MANAGER_IMDB_MATCH` | `matchItemImdb` |
| `GET` | `/api/media/presets` | `MEDIA_MANAGER_VIEW` | `presets` |
| `POST` | `/api/media/preview` | `MEDIA_MANAGER_VIEW` | `preview` |
| `POST` | `/api/media/apply` | `MEDIA_MANAGER_RENAME` | `apply` |
| `GET` | `/api/media/history` | `MEDIA_MANAGER_VIEW` | `history` |
| `GET` | `/api/media/settings/cleanup` | `MEDIA_MANAGER_VIEW` | `getCleanup` |
| `PATCH` | `/api/media/settings/cleanup` | `MEDIA_MANAGER_MANAGE_LIBRARIES` | `updateCleanup` |

## `/media-acquisition`

From `MediaAcquisitionController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/media-acquisition/overview` | `MEDIA_ACQUISITION_VIEW` | `overview` |
| `GET` | `/api/media-acquisition/watchlist` | `MEDIA_ACQUISITION_VIEW` | `listWatchlist` |
| `GET` | `/api/media-acquisition/watchlist/library-series` | `MEDIA_ACQUISITION_VIEW` | `librarySeries` |
| `POST` | `/api/media-acquisition/watchlist/library/resolve-imdb` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `resolveLibraryImdbIds` |
| `POST` | `/api/media-acquisition/watchlist/bulk` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `bulkAddWatchlist` |
| `POST` | `/api/media-acquisition/watchlist` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `createWatchlist` |
| `GET` | `/api/media-acquisition/watchlist/:id` | `MEDIA_ACQUISITION_VIEW` | `getWatchlist` |
| `PATCH` | `/api/media-acquisition/watchlist/:id` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `updateWatchlist` |
| `DELETE` | `/api/media-acquisition/watchlist/:id` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `deleteWatchlist` |
| `GET` | `/api/media-acquisition/profiles` | `MEDIA_ACQUISITION_VIEW` | `listProfiles` |
| `POST` | `/api/media-acquisition/profiles` | `MEDIA_ACQUISITION_MANAGE_PROFILES` | `createProfile` |
| `GET` | `/api/media-acquisition/profiles/:id` | `MEDIA_ACQUISITION_VIEW` | `getProfile` |
| `PATCH` | `/api/media-acquisition/profiles/:id` | `MEDIA_ACQUISITION_MANAGE_PROFILES` | `updateProfile` |
| `DELETE` | `/api/media-acquisition/profiles/:id` | `MEDIA_ACQUISITION_MANAGE_PROFILES` | `deleteProfile` |
| `GET` | `/api/media-acquisition/match-preferences` | `MEDIA_ACQUISITION_VIEW` | `listMatchPreferences` |
| `POST` | `/api/media-acquisition/match-preferences` | `MEDIA_ACQUISITION_MANAGE_PROFILES` | `createMatchPreference` |
| `PATCH` | `/api/media-acquisition/match-preferences/:id` | `MEDIA_ACQUISITION_MANAGE_PROFILES` | `updateMatchPreference` |
| `DELETE` | `/api/media-acquisition/match-preferences/:id` | `MEDIA_ACQUISITION_MANAGE_PROFILES` | `deleteMatchPreference` |
| `POST` | `/api/media-acquisition/evaluate` | `MEDIA_ACQUISITION_EVALUATE` | `evaluate` |
| `POST` | `/api/media-acquisition/simulate` | `MEDIA_ACQUISITION_VIEW` | `simulate` |
| `GET` | `/api/media-acquisition/evaluations` | `MEDIA_ACQUISITION_VIEW` | `listEvaluations` |
| `GET` | `/api/media-acquisition/evaluations/:id` | `MEDIA_ACQUISITION_VIEW` | `getEvaluation` |
| `GET` | `/api/media-acquisition/waiting` | `MEDIA_ACQUISITION_VIEW` | `waiting` |
| `GET` | `/api/media-acquisition/upgrades` | `MEDIA_ACQUISITION_VIEW` | `upgrades` |
| `GET` | `/api/media-acquisition/rejected` | `MEDIA_ACQUISITION_VIEW` | `rejected` |
| `GET` | `/api/media-acquisition/approval-queue` | `MEDIA_ACQUISITION_VIEW` | `approvalQueue` |
| `POST` | `/api/media-acquisition/evaluations/:id/approve` | `MEDIA_ACQUISITION_APPROVE` | `approve` |
| `POST` | `/api/media-acquisition/evaluations/:id/reject` | `MEDIA_ACQUISITION_REJECT` | `reject` |
| `POST` | `/api/media-acquisition/evaluations/:id/override` | `MEDIA_ACQUISITION_OVERRIDE` | `override` |
| `GET` | `/api/media-acquisition/missing-episodes` | `MEDIA_ACQUISITION_VIEW` | `missingEpisodesOverview` |
| `GET` | `/api/media-acquisition/missing-episodes/:watchlistItemId` | `MEDIA_ACQUISITION_VIEW` | `missingEpisodesForSeries` |
| `POST` | `/api/media-acquisition/missing-episodes/scan` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `scanMissingEpisodes` |
| `POST` | `/api/media-acquisition/missing-episodes/series/:watchlistItemId/search` | `MEDIA_ACQUISITION_EVALUATE` | `searchMissingEpisodesForSeries` |
| `POST` | `/api/media-acquisition/missing-episodes/:id/search` | `MEDIA_ACQUISITION_EVALUATE` | `searchMissingEpisode` |
| `POST` | `/api/media-acquisition/missing-episodes/:id/ignore` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `ignoreMissingEpisode` |
| `POST` | `/api/media-acquisition/missing-episodes/:id/unignore` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `unignoreMissingEpisode` |
| `GET` | `/api/media-acquisition/missing-episodes/:watchlistItemId/seasons` | `MEDIA_ACQUISITION_VIEW` | `missingSeasons` |
| `GET` | `/api/media-acquisition/missing-movies` | `MEDIA_ACQUISITION_VIEW` | `missingMoviesOverview` |
| `POST` | `/api/media-acquisition/missing-movies/scan` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `scanMissingMovies` |
| `POST` | `/api/media-acquisition/missing-movies/:id/ignore` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `ignoreMissingMovie` |
| `POST` | `/api/media-acquisition/missing-movies/:id/unignore` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | `unignoreMissingMovie` |
| `GET` | `/api/media-acquisition/history` | `MEDIA_ACQUISITION_HISTORY` | `history` |
| `GET` | `/api/media-acquisition/recommendations` | `MEDIA_ACQUISITION_VIEW` | `recommendations` |
| `GET` | `/api/media-acquisition/settings` | `MEDIA_ACQUISITION_SETTINGS` | `getSettings` |
| `PATCH` | `/api/media-acquisition/settings` | `MEDIA_ACQUISITION_SETTINGS` | `updateSettings` |
| `POST` | `/api/media-acquisition/export` | `MEDIA_ACQUISITION_EXPORT` | `export` |

## `/media-server-analytics`

From `MediaServerAnalyticsController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/media-server-analytics/dashboard` | `MEDIA_SERVER_ANALYTICS_VIEW` | `dashboard` |
| `GET` | `/api/media-server-analytics/live` | `MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY` | `live` |
| `POST` | `/api/media-server-analytics/live/poll` | `MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS` | `pollLive` |
| `GET` | `/api/media-server-analytics/live/:id/artwork` | `MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY` | `liveArtwork` |
| `GET` | `/api/media-server-analytics/watch-history` | `MEDIA_SERVER_ANALYTICS_VIEW_HISTORY` | `watchHistory` |
| `GET` | `/api/media-server-analytics/reports/usage` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportUsage` |
| `GET` | `/api/media-server-analytics/reports/users` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportUsers` |
| `GET` | `/api/media-server-analytics/reports/libraries` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportLibraries` |
| `GET` | `/api/media-server-analytics/reports/playback` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportPlayback` |
| `GET` | `/api/media-server-analytics/reports/top-media` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportTopMedia` |
| `GET` | `/api/media-server-analytics/reports/devices` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportDevices` |
| `GET` | `/api/media-server-analytics/reports/heatmap` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportHeatmap` |
| `GET` | `/api/media-server-analytics/reports/trends` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportTrends` |
| `GET` | `/api/media-server-analytics/reports/resolutions` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportResolutions` |
| `GET` | `/api/media-server-analytics/reports/library-growth` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportLibraryGrowth` |
| `GET` | `/api/media-server-analytics/reports/bandwidth` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `reportBandwidth` |
| `GET` | `/api/media-server-analytics/export/watch-history` | `MEDIA_SERVER_ANALYTICS_EXPORT` | `exportWatchHistory` |
| `GET` | `/api/media-server-analytics/meta/libraries` | `MEDIA_SERVER_ANALYTICS_VIEW` | `metaLibraries` |
| `GET` | `/api/media-server-analytics/meta/users` | `MEDIA_SERVER_ANALYTICS_VIEW` | `metaUsers` |
| `GET` | `/api/media-server-analytics/meta/sync-runs` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | `metaSyncRuns` |
| `POST` | `/api/media-server-analytics/meta/sync` | `MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS` | `runSync` |
| `GET` | `/api/media-server-analytics/users` | `MEDIA_SERVER_ANALYTICS_VIEW_USERS` | `users` |
| `GET` | `/api/media-server-analytics/recently-added` | `MEDIA_SERVER_ANALYTICS_VIEW` | `recentlyAdded` |
| `GET` | `/api/media-server-analytics/import-sources` | `MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS` | `listImportSources` |
| `POST` | `/api/media-server-analytics/import-sources` | `MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS` | `createImportSource` |
| `GET` | `/api/media-server-analytics/import-sources/:id` | `MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS` | `getImportSource` |
| `PATCH` | `/api/media-server-analytics/import-sources/:id` | `MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS` | `updateImportSource` |
| `DELETE` | `/api/media-server-analytics/import-sources/:id` | `MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS` | `deleteImportSource` |
| `POST` | `/api/media-server-analytics/import-sources/:id/test` | `MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS` | `testImportSource` |
| `POST` | `/api/media-server-analytics/import-sources/:id/preview` | `MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS` | `previewImport` |
| `POST` | `/api/media-server-analytics/import-sources/:id/import` | `MEDIA_SERVER_ANALYTICS_RUN_IMPORTS` | `runImport` |
| `GET` | `/api/media-server-analytics/import-jobs` | `MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS` | `listImportJobs` |
| `GET` | `/api/media-server-analytics/import-jobs/:id` | `MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS` | `getImportJob` |
| `GET` | `/api/media-server-analytics/newsletters` | `MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS` | `listNewsletters` |
| `POST` | `/api/media-server-analytics/newsletters` | `MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS` | `createNewsletter` |
| `GET` | `/api/media-server-analytics/newsletters/:id` | `MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS` | `getNewsletter` |
| `PATCH` | `/api/media-server-analytics/newsletters/:id` | `MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS` | `updateNewsletter` |
| `DELETE` | `/api/media-server-analytics/newsletters/:id` | `MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS` | `deleteNewsletter` |
| `POST` | `/api/media-server-analytics/newsletters/:id/preview` | `MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS` | `previewNewsletter` |
| `POST` | `/api/media-server-analytics/newsletters/:id/test-send` | `MEDIA_SERVER_ANALYTICS_SEND_NEWSLETTERS` | `testSendNewsletter` |
| `POST` | `/api/media-server-analytics/newsletters/:id/send-now` | `MEDIA_SERVER_ANALYTICS_SEND_NEWSLETTERS` | `sendNewsletter` |
| `GET` | `/api/media-server-analytics/newsletters/:id/deliveries` | `MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS` | `newsletterDeliveries` |
| `GET` | `/api/media-server-analytics/settings/email` | `MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS` | `getEmailSettings` |
| `PATCH` | `/api/media-server-analytics/settings/email` | `MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS` | `updateEmailSettings` |
| `POST` | `/api/media-server-analytics/settings/email/test` | `MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS` | `testEmail` |
| `GET` | `/api/media-server-analytics/settings/newsletter-images` | `MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS` | `getNewsletterImageSettings` |
| `PATCH` | `/api/media-server-analytics/settings/newsletter-images` | `MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS` | `updateNewsletterImageSettings` |
| `GET` | `/api/media-server-analytics/connections` | `MEDIA_SERVER_ANALYTICS_VIEW` | `listConnections` |
| `POST` | `/api/media-server-analytics/connections` | `MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS` | `createConnection` |
| `GET` | `/api/media-server-analytics/connections/:id` | `MEDIA_SERVER_ANALYTICS_VIEW` | `getConnection` |
| `PATCH` | `/api/media-server-analytics/connections/:id` | `MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS` | `updateConnection` |
| `DELETE` | `/api/media-server-analytics/connections/:id` | `MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS` | `deleteConnection` |
| `POST` | `/api/media-server-analytics/connections/:id/test` | `MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS` | `testConnection` |
| `POST` | `/api/media-server-analytics/connections/:id/sync` | `MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS` | `syncConnection` |
| `GET` | `/api/media-server-analytics/connections/:id/libraries` | `MEDIA_SERVER_ANALYTICS_VIEW` | `libraries` |

## `/media-server-analytics/nl-image`

From `NewsletterImageController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/media-server-analytics/nl-image/:id` | — | `serve` |

## `/modules`

From `ModuleRegistryController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/modules/enabled` | `MODULES_VIEW` | `enabled` |
| `GET` | `/api/modules/license` | `MODULES_VIEW` | `licenseStatus` |
| `GET` | `/api/modules` | `MODULES_VIEW` | `list` |
| `GET` | `/api/modules/:id` | `MODULES_VIEW` | `get` |
| `GET` | `/api/modules/:id/manifest` | `MODULES_VIEW` | `manifest` |
| `GET` | `/api/modules/:id/health` | `MODULES_VIEW` | `moduleHealth` |
| `POST` | `/api/modules/:id/enable` | `MODULES_MANAGE` | `enable` |
| `POST` | `/api/modules/:id/disable` | `MODULES_MANAGE` | `disable` |

## `/notifications`

From `NotificationCenterController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/notifications/dashboard` | `NOTIFICATIONS_VIEW` | `dashboard` |
| `GET` | `/api/notifications/providers` | `NOTIFICATIONS_VIEW` | `providers` |
| `GET` | `/api/notifications/channels` | `NOTIFICATIONS_VIEW` | `listChannels` |
| `POST` | `/api/notifications/channels` | `NOTIFICATIONS_MANAGE_CHANNELS` | `createChannel` |
| `GET` | `/api/notifications/channels/:id` | `NOTIFICATIONS_VIEW` | `getChannel` |
| `PATCH` | `/api/notifications/channels/:id` | `NOTIFICATIONS_MANAGE_CHANNELS` | `updateChannel` |
| `DELETE` | `/api/notifications/channels/:id` | `NOTIFICATIONS_MANAGE_CHANNELS` | `deleteChannel` |
| `POST` | `/api/notifications/channels/:id/test` | `NOTIFICATIONS_SEND_TEST` | `testChannel` |
| `GET` | `/api/notifications/recipients` | `NOTIFICATIONS_VIEW` | `listRecipients` |
| `POST` | `/api/notifications/recipients` | `NOTIFICATIONS_MANAGE_RECIPIENTS` | `createRecipient` |
| `PATCH` | `/api/notifications/recipients/:id` | `NOTIFICATIONS_MANAGE_RECIPIENTS` | `updateRecipient` |
| `DELETE` | `/api/notifications/recipients/:id` | `NOTIFICATIONS_MANAGE_RECIPIENTS` | `deleteRecipient` |
| `GET` | `/api/notifications/groups` | `NOTIFICATIONS_VIEW` | `listGroups` |
| `POST` | `/api/notifications/groups` | `NOTIFICATIONS_MANAGE_GROUPS` | `createGroup` |
| `DELETE` | `/api/notifications/groups/:id` | `NOTIFICATIONS_MANAGE_GROUPS` | `deleteGroup` |
| `PUT` | `/api/notifications/groups/:id/members` | `NOTIFICATIONS_MANAGE_GROUPS` | `setGroupMembers` |
| `GET` | `/api/notifications/templates` | `NOTIFICATIONS_VIEW` | `listTemplates` |
| `POST` | `/api/notifications/templates` | `NOTIFICATIONS_MANAGE_TEMPLATES` | `createTemplate` |
| `PATCH` | `/api/notifications/templates/:id` | `NOTIFICATIONS_MANAGE_TEMPLATES` | `updateTemplate` |
| `DELETE` | `/api/notifications/templates/:id` | `NOTIFICATIONS_MANAGE_TEMPLATES` | `deleteTemplate` |
| `POST` | `/api/notifications/templates/preview` | `NOTIFICATIONS_MANAGE_TEMPLATES` | `previewTemplate` |
| `GET` | `/api/notifications/rules` | `NOTIFICATIONS_VIEW` | `listRules` |
| `GET` | `/api/notifications/rules/:id` | `NOTIFICATIONS_VIEW` | `getRule` |
| `POST` | `/api/notifications/rules` | `NOTIFICATIONS_MANAGE_RULES` | `createRule` |
| `PATCH` | `/api/notifications/rules/:id` | `NOTIFICATIONS_MANAGE_RULES` | `updateRule` |
| `DELETE` | `/api/notifications/rules/:id` | `NOTIFICATIONS_MANAGE_RULES` | `deleteRule` |
| `GET` | `/api/notifications/history` | `NOTIFICATIONS_VIEW_HISTORY` | `history` |
| `GET` | `/api/notifications/queue` | `NOTIFICATIONS_VIEW_HISTORY` | `queue` |
| `POST` | `/api/notifications/history/:id/retry` | `NOTIFICATIONS_RETRY` | `retry` |
| `GET` | `/api/notifications/preferences/:recipientId` | `NOTIFICATIONS_VIEW` | `preferences` |
| `PUT` | `/api/notifications/preferences` | `NOTIFICATIONS_MANAGE_PREFERENCES` | `setPreference` |
| `GET` | `/api/notifications/settings` | `NOTIFICATIONS_MANAGE_SETTINGS` | `getSettings` |
| `PATCH` | `/api/notifications/settings` | `NOTIFICATIONS_MANAGE_SETTINGS` | `updateSettings` |
| `POST` | `/api/notifications/test` | `NOTIFICATIONS_SEND_TEST` | `test` |

## `/release-scoring`

From `ReleaseScoringController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `POST` | `/api/release-scoring/score` | `RELEASE_SCORING_VIEW` | `score` |
| `POST` | `/api/release-scoring/test-rule` | `RELEASE_SCORING_VIEW` | `testRule` |

## `/torrents`

From `TorrentsController`.

| Method | Path | Permission | Handler |
| --- | --- | --- | --- |
| `GET` | `/api/torrents/parking` | `TORRENTS_VIEW` | `listParked` |
| `GET` | `/api/torrents/parking/settings` | `TORRENTS_VIEW` | `getParkingRules` |
| `PATCH` | `/api/torrents/parking/settings` | `TORRENTS_PAUSE` | `updateParkingRules` |
| `POST` | `/api/torrents/parking/run` | `TORRENTS_PAUSE` | `runParkingSweep` |
| `POST` | `/api/torrents/parking/:hash/unpark` | `TORRENTS_RESUME` | `unpark` |
| `GET` | `/api/torrents` | `TORRENTS_VIEW` | `list` |
| `GET` | `/api/torrents/:hash` | `TORRENTS_VIEW` | `get` |
| `GET` | `/api/torrents/:hash/matched-rule` | `TORRENTS_VIEW` | `matchedRule` |
| `GET` | `/api/torrents/:hash/files` | `TORRENTS_VIEW` | `files` |
| `GET` | `/api/torrents/:hash/peers` | `TORRENTS_VIEW` | `peers` |
| `GET` | `/api/torrents/:hash/trackers` | `TORRENTS_VIEW` | `trackers` |
| `POST` | `/api/torrents` | `TORRENTS_ADD` | `add` |
| `POST` | `/api/torrents/upload` | `TORRENTS_ADD` | `upload` |
| `POST` | `/api/torrents/bulk` | `TORRENTS_VIEW` | `bulk` |
| `POST` | `/api/torrents/:hash/start` | `TORRENTS_START` | `start` |
| `POST` | `/api/torrents/:hash/stop` | `TORRENTS_STOP` | `stop` |
| `POST` | `/api/torrents/:hash/pause` | `TORRENTS_PAUSE` | `pause` |
| `POST` | `/api/torrents/:hash/resume` | `TORRENTS_RESUME` | `resume` |
| `POST` | `/api/torrents/:hash/recheck` | `TORRENTS_RECHECK` | `recheck` |
| `DELETE` | `/api/torrents/:hash` | `TORRENTS_DELETE` | `remove` |
| `DELETE` | `/api/torrents/:hash/data` | `TORRENTS_DELETE_DATA` | `removeData` |
| `POST` | `/api/torrents/:hash/move` | `TORRENTS_MOVE` | `move` |
| `POST` | `/api/torrents/:hash/limits/upload` | `TORRENTS_MANAGE_LIMITS` | `upLimit` |
| `POST` | `/api/torrents/:hash/limits/download` | `TORRENTS_MANAGE_LIMITS` | `downLimit` |
| `POST` | `/api/torrents/:hash/files/priority` | `TORRENTS_MANAGE_FILES` | `filePriority` |
| `POST` | `/api/torrents/:hash/trackers` | `TORRENTS_MANAGE_TRACKERS` | `addTracker` |
| `DELETE` | `/api/torrents/:hash/trackers` | `TORRENTS_MANAGE_TRACKERS` | `removeTracker` |

## See also

- [Permissions Reference](/reference/permissions) — what each guard requires
- [API Keys](/modules/api-keys) — non-interactive access
- [WebSocket events](/develop/websockets) — live updates instead of polling
