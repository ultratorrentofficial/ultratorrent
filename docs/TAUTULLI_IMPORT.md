# Tautulli Analytics Import

UltraTorrent can migrate historical analytics from **Tautulli** into the Media
Server Analytics module. Tautulli is treated as an **analytics import source**, not
a media server — it sits behind the `MediaAnalyticsImportProvider` abstraction,
separate from the `MediaServerProvider` used for Plex/Jellyfin/Emby/Kodi.

> No Tautulli code, UI, templates, or assets are copied — this is original
> UltraTorrent functionality that reads Tautulli's public API.

## What it imports (Phase 1 of import)

- **Watch history** — streamed from Tautulli's `get_history` API, normalized
  (`normalizeTautulliHistory`) into `MediaServerWatchHistory` rows (user, title,
  library, device, started/stopped, watched seconds, percent complete, playback
  method), tagged `importSource: 'tautulli'`. These immediately light up the
  [analytics reports](MEDIA_SERVER_ANALYTICS.md).

Later phases add users, libraries, playback/device/transcode statistics,
newsletter configuration + history, mapping, and incremental sync.

## How it works

1. **Add a source** — Tautulli URL + API key. The key is **encrypted at rest**
   (`SecretCipher`) and redacted from every API response (`hasApiKey` only).
2. **Test** — `cmd=arnold` proves the API key works.
3. **Preview** — `getImportSourceInfo` reports the total history + user counts
   without importing anything.
4. **Import** — a background `MediaAnalyticsImportJob` streams `get_history` in
   pages of 500, writing rows with `createMany({ skipDuplicates })` keyed on the
   unique `(importSourceId, providerHistoryId)` — so **duplicates never inflate
   statistics** and a re-run is safe. Progress (`processed/imported/skipped`,
   percent) is persisted on the job and streamed over WebSocket
   (`media_server.import.started/progress/completed/failed`).
5. **Summary** — the job row carries the final counts; jobs are listed in the UI.

## Security

- API keys AES-256-GCM encrypted at rest; never returned or logged.
- Import writes are scoped to the source's own rows via the dedup key — an import
  can't overwrite unrelated (e.g. live-captured) history.
- All import actions are audited (`media_server_analytics.import*`).
- Endpoints require `media_server_analytics.manage_imports` (source management,
  preview) or `…run_imports` (starting an import).

## API

Under `/api/media-server-analytics`:

| Method + path | Permission |
|---|---|
| `GET/POST /import-sources`, `GET/PATCH/DELETE /import-sources/:id` | `…manage_imports` |
| `POST /import-sources/:id/test` · `/preview` | `…manage_imports` |
| `POST /import-sources/:id/import` | `…run_imports` |
| `GET /import-jobs` · `/import-jobs/:id` | `…manage_imports` |

## Retirement

After a successful import, UltraTorrent provides unified media acquisition, media
server analytics, watch history, and (coming) newsletters. UltraTorrent does not
uninstall or disable Tautulli for you — it simply reports the migration complete.
