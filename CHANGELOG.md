# Changelog

All notable changes to UltraTorrent are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The Community + Enterprise editions (Milestones 1–7) and the repository/versioning
foundation. A single canonical version spans all editions: the root `package.json`
is the source of truth (managed with [Changesets](https://github.com/changesets/changesets)),
and `ops/scripts/sync-versions.js` mirrors it into `version.json` / `VERSION` and
the workspace packages. Release tags are `vX.Y.Z`. See
[docs/VERSIONING.md](docs/VERSIONING.md) and [docs/BUILD.md](docs/BUILD.md).

### Added
- **Module Registry + UPLM licensing.** Tiered module manifests
  (core/community/premium/enterprise), runtime-swappable `LicenseProvider`, and a
  private UPLM overlay (Ed25519 signed module catalog + fail-closed entitlement
  verification, `uplm:*` CLI).
- **Node Agent + Fleet Management**, **Customers / Provisioning / Billing**,
  premium modules (**Media Renamer Pro, Multi-Server, Library Awareness, Release
  Scoring, Advanced Analytics**), and the enterprise release modules (**White
  Label, Central Backups, Central Updates**) — all UPLM-gated overlays in
  `packages/enterprise`.
- **Editions & packaging**: `build:community`/`build:enterprise`,
  `test:*`/`package:*` scripts, enterprise Dockerfile,
  `docker-compose.{community,enterprise,central,node}.yml`, CI workflows
  (`core-ci` + `guard-no-enterprise`, `enterprise-ci`, `security`).
- **Repository strategy tooling**: `edition.config.json` (authoritative
  public/private path manifest), `scripts/check-edition-boundary.sh`,
  `scripts/publish-community.sh` (clean public mirror of the Community subset),
  `scripts/setup-enterprise-submodule.sh`; `docs/BUILD.md`.
- **Versioning foundation**: `VERSION` + `version.json` (product + edition
  tracks); `scripts/version.mjs` (`version:show|check|sync|bump`);
  `scripts/release.sh` (`release:community`/`release:enterprise` — validate,
  build/test, version Docker tags, git tag); **`GET /api/system/version`** (public,
  reports product/version/edition/apiVersion/gitSha/buildTime).

### Notes
- Community contains no proprietary code; Community never imports Enterprise
  (CI-enforced). Premium/enterprise modules ship as locked manifest placeholders
  in Core and unlock only with the overlay + a UPLM entitlement.

---

## [0.16.0] - 2026-07-05

### Added
- Smart Download execution engine (Phase 1): acquisition decisions now actually download — a new SmartDownloadExecutorService turns a download/upgrade decision into a real torrent add (and removes the superseded torrent on an upgrade), wired into evaluate/approve/override; closes the gap where a 'download' decision recorded a pending action that nothing executed
- Smart Download Phase 2: missing movie & season detection — MissingMoviesService scans movie watchlist items (owned via IMDb link or title+year) into WantedMovie rows; MissingEpisodesService.listSeasons rolls up per-season missing status; new endpoints + WantedMovie model
- Smart Download Phase 3: multi-dimensional upgrade comparison (resolution/source/HDR/audio, codec as tiebreak) replacing resolution-only logic; a wait-for-better decision + policy; and waiting/upgrade queue endpoints
- Smart Download Phase 4: Decision Simulator — a dry-run POST /simulate endpoint (no side effects) returning the decision plus a clickable stage-by-stage pipeline explanation, and a Decision Simulator UI page with the visual pipeline
- Smart Download Phase 5a: a Smart Download dashboard page (widget grid + recent decisions + Waiting/Upgrades/Rejected queue tabs) backed by an extended overview() and a new /rejected endpoint
- Media Server Analytics module (Phase 1): new core module extending the existing Plex/Jellyfin/Emby/Kodi integration with capability-aware getServerInfo/getLibraries, health checks, a dashboard, and secure multi-server connection management; Dashboard + Connections UI, RBAC, i18n
- Media Server Analytics Phase 2: live activity + watch history — provider getSessions (Plex/Jellyfin/Emby; Kodi unsupported), a 30s reconciliation poller feeding MediaServerSession + MediaServerWatchHistory, /live and /watch-history endpoints, and Live Activity + Watch History UI pages
- Media Server Analytics Phase 3: analytics & reports — usage/users/libraries/playback aggregations from watch history + recently-added from Media Manager, with Analytics Reports (tabbed) and Recently Added UI pages
- Media Server Analytics Phase 4: Tautulli analytics import — a MediaAnalyticsImportProvider + background import job streaming Tautulli watch history into UltraTorrent (encrypted API key, preview, duplicate-safe dedup, progress), with an Import Analytics UI page
- Media Server Analytics Phase 5: scheduled newsletters — a net-new SMTP email service (nodemailer, encrypted config) + newsletter campaigns of recently-added media with responsive HTML/text rendering, preview, test/send, delivery tracking, and a dispatch scheduler; Newsletters UI page with SMTP settings

### Fixed
- Smart Download Phase 6 docs: new docs/SMART_DOWNLOAD.md (full engine documentation), API.md endpoint additions + boundary correction, and cross-links from acquisition/media-manager/README

## [0.15.0] - 2026-07-05

### Added
- feat(media): optional TV series & episodes in the optimized IMDb import (importTvShows toggle) — also imports tvSeries/tvMiniSeries/tvEpisode + title.episode; principals still always skipped
- Missing Episodes — detect which episodes of a monitored TV series are absent from the library by diffing the local IMDb episode catalogue, with a per-series view and season/episode grid

### Fixed
- Dashboard Recent Activity now renders audit-log entries (map AuditLog rows to the ActivityItem shape the UI expects)
- feat(rss): treat a rule's match-preference list as a per-title acquisition policy — hold one release per movie/episode, upgrade to a strictly higher-priority release when it appears (removing the superseded torrent), and skip equal-or-lower releases, so a movie is no longer grabbed once per quality variant
- fix(rss): dedupe auto-downloads by torrent info-hash so a release re-posted under a rotated guid or seen on a second feed is never grabbed twice (poll + backfill)

## [0.14.0] - 2026-07-05

### Added
- feat(media): add a "Test TMDB key" button in Media Settings that validates the key against TMDB before saving
- feat(media): optimized IMDb movie import — import a lean movie-focused subset (title.basics/ratings/akas, filtered by type/adult/min-year) with referential integrity, stats, idempotency; skip title.principals/episode; add reset + admin strategy panel + docs

### Fixed
- feat(media): add a Stop button to cancel a running IMDb dataset import — cooperative cancellation across both the optimized and full import strategies, marking the run 'cancelled' (already-imported records are kept) with a stop endpoint, WS event, and UI button
- feat(media): IMDb Danger Zone — wipe all imported IMDb data (wipe-only) for when the wrong dataset was imported
- fix(docker): rtorrent entrypoint no longer crash-loops when it cannot drop privileges (Synology/non-root/cap-stripped hosts)
- fix(docker): re-add SETUID/SETGID caps to the rtorrent service so gosu can drop to PUID:PGID on hosts (Synology) that strip them

## [0.13.1] - 2026-07-05

### Fixed
- fix(files): translate mkdir failures (EACCES/EROFS/ENOSPC/…) into actionable errors instead of an opaque 500 when creating a directory
- feat(rss): per-feed rule export — download a bundle scoped to a single feed

## [0.13.0] - 2026-07-05

### Added
- Add an in-app update check. The About dialog now shows whether a newer UltraTorrent release is available (compared against the GitHub release tags), with a Check now button, release-notes link, and the exact deployment-specific commands to apply it. New endpoints: GET /api/system/update (status), POST /api/system/update/check (force check, system.view), PATCH /api/system/update/settings (toggle, system.manage). SystemUpdateService detects Docker vs bare-metal (/.dockerenv + cgroups, overridable via ULTRATORRENT_DEPLOYMENT) and runs a daily background check (on by default, toggleable) plus on demand. Note: the app never auto-applies updates — in Docker a container can't replace its own image, and updates rebuild from source — so it surfaces the right command instead (docker compose up -d --build vs git pull + build + restart).
- Library scans now import existing sidecar artwork and metadata. When a scanned media directory already contains Kodi/Jellyfin-style artwork (poster.jpg, fanart.jpg, folder.jpg, banner, logo, clearart, landscape/thumb, and <name>-poster.jpg style suffixes) the files are imported in place (referenced, not copied; source 'local', auto-selected one per type). Adjacent .nfo files (<basename>.nfo, movie.nfo, tvshow.nfo) are parsed for title/overview/year/runtime/rating/genres/studios/certification/original-title/directors/writers/cast and external ids (imdbid/tmdbid/tvdbid or Kodi <uniqueid>), filling metadata gaps without clobbering provider data and recording external ids + a MediaNfoFile. Runs per item at the end of a scan, skips already-enriched items, is idempotent, and reports artworkImported/metadataImported counts in the scan summary + toast.

### Fixed
- Fix: the IMDb dataset auto-download no longer requires a dataset path to be configured first. The path is a download destination, not a pre-existing source, so when none is set the download+import now falls back to a managed default (<storage-root>/.ultratorrent/imdb-datasets), creates it, and persists it. 'Update now' works out of the box and the scheduler no longer skips when no path is configured.
- Fix: the IMDb dataset import panel now refreshes when a long import finishes even if the WebSocket completion event is missed. A long import (title.principals is ~90M rows) emits no progress events for minutes and can outlast a socket reconnect, so the terminal event could be lost and the history/status never updated. The settings page now polls the imports + provider status every 4s while an import is active (from the live panel or the newest history row, so a page reload mid-import still tracks it) and reconciles the live panel to completed/failed from the polled history.
- Prevent overlapping IMDb dataset imports. ImdbDatasetImporterService.startImport now refuses to spawn a second worker while one is pending/running (returns the in-flight import instead) — the single choke point for Import-now, Update-now, and the scheduler. ImdbService guards download+import with an in-flight flag + DB active-import check, and marks any import left running after a restart as failed on startup so a dead job can't wedge future runs. The frontend disables Update-now while an import is active and surfaces a friendly message when a duplicate is rejected.

## [0.12.0] - 2026-07-04

### Added
- The **Media Manager** can now fetch artwork online. A new `ArtworkProvider` seam ships with a `TmdbArtworkProvider` that resolves an item's TMDB id and imports the best **poster** and **fanart** from TMDB. Downloads reuse the same magic-byte + 10 MB validation as custom uploads, are restricted to the TMDB image host (SSRF guard), record provenance (`source: 'tmdb'`), and are idempotent per image. Auto-imported art only auto-selects when the item has no art of that type yet, so operator uploads keep precedence. The `media_fetch_artwork` automation action now performs the fetch (falling back to reporting missing art when no TMDB key or match is configured), operators can trigger it manually via `POST /api/media/items/:id/artwork/import`, and the Media Detail artwork panel gains a **Fetch from provider** button (en-US + es-PR).
- The **Media Manager** gains its full enrichment backend. Scanned files now carry technical details (codec, resolution, HDR, audio, release group, quality) parsed from their filenames. Items can fetch rich **metadata** (overview, genres, cast/crew, ratings) from a local `.nfo` sidecar and — when a TMDB key is configured — from TMDB, with manual edits supported. New capabilities: **artwork** management (list/select per type, custom image upload validated to PNG/JPG/WEBP under 10 MB), **subtitle** discovery (scans for sidecar `.srt/.ass/.sub/.vtt` files, detecting language, forced, and SDH flags), Kodi-style **NFO** generation (movie/tvshow/season/episode, per-library toggle), **duplicate** detection (by external id, show/season/episode, title+year, or similar filename, with a quality comparison to pick the copy to keep), and **media-server integrations** for Plex, Jellyfin, Emby, and Kodi (test connection + trigger a library refresh; credentials are encrypted at rest). All filesystem access stays inside the configured storage roots and sensitive actions are audited.
- When the IMDb dataset feature is enabled, a scheduled job now downloads the official IMDb dataset files and imports them automatically. New IMDb settings — autoDownloadEnabled, datasetBaseUrl (defaults to the official https://datasets.imdbws.com/, operator-configurable), and autoUpdateIntervalHours (default 168 = weekly). An hourly ImdbDatasetScheduler tick runs the download+import at most once per interval when mode is dataset/hybrid and a dataset path is set. ImdbDatasetImporterService.downloadDataset streams the seven .tsv.gz files to disk (temp .part + atomic rename) inside the hard roots, emitting imdb.dataset.download.* WS events. New POST /api/media/providers/imdb/dataset/update-now triggers a manual download+import. The IMDb settings page replaces the unused cron field with auto-download controls (toggle, base URL, interval, Update now) with live download+import progress.

### Fixed
- Fix backend crash-loop on fresh build: break the MediaModule ⇄ AutomationModule DI cycle (ImdbService + MediaProcessingService now resolve AutomationEngine lazily via ModuleRef).
- Show the git tag in the version display: /api/system/version returns gitTag (GIT_TAG build arg or v<VERSION> fallback) and the About dialog shows a Tag row.
- RSS rules import now supports three merge modes: skip (default — leave existing rules), overwrite (replace matched rules' fields and their whole candidate set), and merge (append only non-duplicate match candidates to existing rules). Feeds are always reused by URL, never renamed. The import UI adds a mode-selection dialog and the summary reports overwritten/merged/skipped counts.
- Saving a directory path now validates it against the hard storage roots (FILE_MANAGER_ROOTS) and, when the path is allowed but doesn't exist yet, prompts to create it. New GET /api/files/inspect (containment + on-disk state) and POST /api/files/ensure-dir (recursive mkdir inside the roots, audited) back a reusable useEnsureDirectory() hook. It is wired into every destination-path save form: Media Manager library create/edit, Add Torrent save path, RSS rule save path, Automation move/rename destinations, and the Settings default root path. Media library create/update now also asserts the path is within the hard roots server-side. Pure read-source inputs (rename-from source, scan/dry-run library, rename preview source) are intentionally left out, since creating an empty folder there is meaningless.
- The Media Manager media list is now a rich, poster-forward view instead of a bare table. Each row shows the poster artwork, title/year, rating, media type + match badges, season/episode, certification, runtime, overview, genres, technical specs from the primary file (resolution/codec/HDR/audio/size/container), and IMDb/TMDB external-id links; rows link to the item detail page. Backed by the list endpoint now eagerly loading metadata/artwork(poster)/externalIds relations, and a new GET /api/media/artwork/:artworkId/image endpoint (MEDIA_MANAGER_VIEW) that streams locally-stored artwork so it renders in the browser (remote provider artwork still loads from its url).
- The Media Detail artwork tab now renders posters through the shared MediaPoster component, so locally-stored artwork (custom uploads / on-disk provider imports) displays correctly instead of showing a broken image — it fetches those bytes through the authenticated artwork image endpoint, while remote provider art still loads from its url.

## [0.11.5] - 2026-07-03

### Fixed
- RSS rules and their match filters can now be **exported and imported** as a JSON file, to move your setup from one install to another. The RSS page header gains **Export** (downloads all rules + candidates) and **Import** (upload a bundle) buttons. Rules are keyed to their feed by URL, so importing recreates any missing feed and skips a rule that already exists under that feed (safe to re-import).

## [0.11.4] - 2026-07-03

### Fixed
- In a rule's Test tab, the per-result **Download** button now only appears when the item actually has a magnet — matching the feed-history page. Matched items without a magnet (which couldn't be reliably grabbed and would fail on a dead direct link) no longer show a Download button.

## [0.11.3] - 2026-07-03

### Fixed
- The RSS **Feed History** is now a full, wide page instead of a cramped popup. It shows colored summary tiles (Downloaded / Matched / Seen) for the whole feed, a clean table with a humanized colored status on every release, and pagination (25 per page by default, with a rows-per-page selector). Any release that hasn't matched a rule yet gets a **Create rule** button: it pre-analyzes the release (name, season/episode, quality, and suggested match filters are all filled in for you), so one confirmation creates the rule and immediately grabs that release plus any other matching items in history. The raw download URL is no longer shown in the history list.

## [0.11.2] - 2026-07-03

### Fixed
- RSS "Test against history" results are now actionable, not just a preview. Each matched row has a **Download** button that actually grabs the release (showing real success/failure — e.g. a dead tracker link surfaces as "Download failed: 404" instead of silently doing nothing), and shows a "Downloaded" badge once grabbed. Misleading labels were fixed: a matched history row reads "Matches — click Download to grab it", while a manual torrent-name test reads "Matches — would download on the next poll" (it was previously labelled "Download triggered" even though nothing was downloaded).
- RSS UI polish: the feed **History** browser now shows each item's download link (magnet URI or `.torrent` URL) beneath its title — clickable when it's a safe link. And in a rule's **Test** tab, results now list matches first, so a long history or title list leads with the items that actually match instead of burying them.
- RSS downloads now use the **magnet link** instead of the direct `.torrent` URL. Feed items expose both a `.torrent` enclosure (a single host that can 404 or expire — e.g. EZTV's zoink.ch links) and a magnet URI that resolves through DHT and trackers. UltraTorrent now captures the magnet from the feed, stores it in history, and prefers it for every download (auto-download, backfill, and the manual Download button), so grabs no longer fail on a dead direct link. Items already in history without a stored magnet have it re-resolved from the live feed when you click Download.

## [0.11.1] - 2026-07-03

### Fixed
- RSS feed scope now works end-to-end: a match candidate's Feed scope extends its rule to the selected feeds — the rule is polled against and listed under each feed it targets (shown read-only on non-owner feeds), and rules within a feed are sorted alphabetically.
- RSS "Contains text" match candidates now match on **all words**, not one contiguous phrase. The title must contain every word of the pattern (in any order), so a filter like `Agent Kim Reactivated XviD-AFG` correctly matches `Agent Kim Reactivated S01E03 XviD-AFG` — the episode number in the middle no longer breaks the match. When it doesn't match, the result names the missing word(s). (An empty pattern now matches nothing rather than everything.)
- RSS match preferences are now tested against real feed data, and seen items can be grabbed on demand. A rule's Test tab runs the whole preference list against the feed's stored **history** by default (reporting what would download); when there's no history yet, you can paste a torrent name to check the settings instead. Adding **or editing** a match preference (or applying Smart Build, or toggling the rule's auto-download) re-evaluates the existing history and immediately downloads any not-yet-grabbed item it matches — instead of waiting for the next poll — gated on the rule's auto-download setting. This matters because the poll never revisits an item once it's in history, so widening a preference later would otherwise never pick up releases that already arrived. The feed **History** browser gains a per-item **Download** button to grab any seen release directly, and each feed gets a **Fetch now** button that polls it immediately (rather than waiting up to the refresh interval) — handy right after adding a feed, so its history populates at once.

## [0.11.0] - 2026-07-02

### Added
- Show the matching RSS automation rule in the torrent detail drawer (GET /torrents/:hash/matched-rule)

### Fixed
- RSS: a rule with no candidates and no include/exclude regex no longer auto-downloads the entire feed

## [0.1.0] — Initial MVP

The first release: a working, secure, multi-user management layer over rTorrent,
built on a Clean Architecture core designed for additional engines.

### Added

- **Monorepo & shared core.** npm-workspaces layout (`apps/backend`,
  `apps/frontend`, `packages/shared`). The `@ultratorrent/shared` package is the
  single source of truth for normalized torrent types, the RBAC permission
  catalog, and the WebSocket event contract — consumed by both backend and
  frontend.
- **Clean Architecture backend (NestJS).** Strict layering — API → Application →
  Domain → Infrastructure — with dependencies pointing inward.
- **Engine provider abstraction.** The `TorrentEngineProvider` interface is the
  single seam between business logic and any torrent engine; an
  `EngineProviderFactory` and `EngineRegistryService` manage live provider
  instances. qBittorrent / Transmission / Deluge are recognized kinds, reserved
  for future implementation.
- **rTorrent provider.** Full implementation over XML-RPC, with a hand-rolled
  XML-RPC codec, an SCGI transport (TCP and Unix socket) plus an HTTP transport,
  and a bencode reader for computing info-hashes. Supports list/get, files,
  peers, trackers, global & session stats, add (magnet / file / URL), remove
  (with optional data deletion), start/stop/pause/resume/recheck/force-start,
  move storage, file & torrent priorities, rate limits, and tracker management.
  All data is normalized to engine-agnostic DTOs.
- **Authentication & RBAC.** Argon2id password hashing, short-lived JWT access
  tokens, and rotating refresh tokens with reuse detection (token-family
  revocation). Permission-based authorization with five seeded system roles
  (`SUPER_ADMIN` … `READ_ONLY`) and a granular, dot-namespaced permission
  catalog enforced by `JwtAuthGuard` + `PermissionsGuard`.
- **Auth API** — login (rate-limited), refresh, logout, `me`, change-password.
- **Torrents API** — paginated list with filter/search/sort, per-torrent reads
  (files/peers/trackers), add via magnet/upload/URL, bulk actions, full
  state-transition and mutation endpoints, each gated by a specific permission.
- **Dashboard API** — aggregated summary (totals, rates, state breakdown, ratio,
  engine online status) and a recent-activity feed sourced from the audit log.
- **Engines API** — list (with secrets stripped), health check, and
  create/update/delete that hot-reload the provider registry.
- **Audit API** — paginated, filterable audit-log query.
- **Real-time sync.** A background `TorrentSyncService` polls each engine every
  ~2 s, persists lightweight torrent snapshots, and fans live torrent lists,
  global stats, and engine status out to clients via an authenticated Socket.IO
  gateway at `/ws`.
- **Audit logging.** Authentication events and all destructive torrent actions
  are recorded with actor, IP, user agent, result, and metadata.
- **Persistence (Prisma / PostgreSQL).** Data model covering users, roles &
  permissions, refresh tokens, API keys, torrent engines & snapshots, categories
  & tags, RSS feeds/rules/history, automation rules & logs, download paths,
  settings, notifications, audit logs, and system events. Seed script provisions
  permissions, roles, the bootstrap super admin, and default settings.
- **Security hardening.** Helmet, CORS restricted to a configured origin,
  `@nestjs/throttler` rate limiting on auth endpoints, `class-validator` DTO
  validation on all input, an allow-list (`FILE_MANAGER_ROOTS`) for file-manager
  paths, env-based secrets, and refresh tokens stored only as hashes.
- **OpenAPI / Swagger** documentation served at `/api/docs`.
- **Frontend scaffold (React + Vite).** Workspace configured with React 18,
  React Router, TanStack Query, Tailwind CSS, Recharts, and a Socket.IO client,
  with the dev server proxying `/api` and `/ws` to the backend.
- **Docker** deployment design — Compose stack (frontend, backend, postgres,
  redis, optional rtorrent, optional reverse proxy) with volumes, health checks,
  and env wiring (see `docs/DOCKER.md`).
- **Documentation set** — README plus architecture, install, API, Docker,
  security, development, and contributing guides.

### Security

- Default development JWT secrets and the seeded admin password
  (`admin` / `changeme123!`) are intended for first boot only and **must** be
  changed for any shared or production deployment.

[Unreleased]: https://github.com/your-org/ultratorrent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/your-org/ultratorrent/releases/tag/v0.1.0
</content>
