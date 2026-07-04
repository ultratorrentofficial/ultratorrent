# Architecture

This document is the canonical architecture reference for **UltraTorrent** — a
modern, self-hosted **Media Acquisition & Management Platform**. UltraTorrent is
a single, open-source community product: there is no separate commercial
edition, no private overlay, and no licensing tier. Everything the application
ships is covered here, and every feature is available in this one repository —
access is controlled **only** by role-based access control (RBAC).

## Introduction

UltraTorrent is far more than a BitTorrent downloader. It is an end-to-end
platform for **acquiring**, **organizing**, and **managing** media, combining
in a single, cohesive system:

- **BitTorrent downloading** — a management layer in front of one or more
  existing engines (rTorrent today) via a pluggable provider seam.
- **RSS automation** — feeds with include/exclude rules and a ranked
  match-preference engine (Smart Match Builder).
- **Media organization** — libraries, release-name identification, and a
  template rename engine.
- **Metadata, artwork & subtitle management** — enrichment from local sidecars
  and external providers.
- **NFO generation** — Kodi-style sidecars for media-server consumption.
- **File management** — a path-safe, root-confined file manager.
- **Automation** — an event-driven condition/action rules engine.
- **Media-server integrations** — library refreshes to Plex, Jellyfin, Emby,
  and Kodi.
- **Multi-user administration** — users, roles, granular permissions, 2FA,
  API keys, and a full audit trail.
- **REST APIs and WebSockets** — a documented HTTP surface plus real-time
  push over Socket.IO.
- **Docker deployment** — a first-class container deployment story.

Where a traditional torrent client stops at "download this file", UltraTorrent
continues: it identifies the release, enriches it with metadata, artwork, and
subtitles, renames and files it into the right library, generates NFO sidecars,
refreshes the media server, and notifies the operator — all governed by RBAC and
observable in real time.

### How it differs from a torrent client

A conventional BitTorrent application is a single-user desktop tool whose job
ends when a download completes. UltraTorrent is a **server-side platform**: it
never has the browser talk to an engine directly. The React SPA talks to the
UltraTorrent API, which translates requests into each engine's native protocol
and returns **normalized**, engine-agnostic data; live updates are pushed over
WebSocket. Around that core it layers media acquisition intelligence, media
management, automation, multi-user RBAC, auditing, and integrations that a
desktop client does not attempt.

```
        React SPA  ── REST /api ──▶  NestJS API  ── XML-RPC/SCGI ──▶  rTorrent
             ▲         WS /ws           │                            (engine seam)
             └──────── live events ─────┘         PostgreSQL (Prisma) · Redis
```

## Core Principles

The platform is built to a consistent set of engineering principles:

- **Open Source** — AGPL-3.0-or-later, developed in the open; no closed
  components and no feature paywalls.
- **API First** — every capability is a documented REST endpoint (OpenAPI /
  Swagger); the SPA is just one client of that API.
- **Docker Native** — designed to run as containers; Compose brings up the full
  stack (database, cache, backend, frontend) with no insecure defaults.
- **Secure by Default** — Argon2id hashing, algorithm-pinned JWTs, refresh-token
  rotation with reuse detection, path safety, transport hardening, and a boot
  that refuses weak/default secrets in production.
- **Provider-Based Architecture** — external services are reached only through
  provider abstractions, so the core is isolated from any specific vendor or
  engine.
- **Event-Driven Processing** — modules react to domain events rather than
  calling each other directly, keeping them loosely coupled.
- **Modular Design** — each capability is a self-contained NestJS module with a
  manifest, dependency graph, and permission block.
- **Automation First** — acquisition and post-download work is expressed as
  triggers and actions, not manual steps.
- **Real-Time Updates** — state changes are pushed to clients over a
  permission-scoped WebSocket gateway.
- **Cross-Platform** — runs on Linux PCs and NAS devices (QNAP, Synology) via
  Docker, and from source on any Node.js ≥ 20 host.
- **Extensible by Design** — new engines, metadata sources, and integrations are
  added as providers/modules without touching business logic.
- **Enterprise Quality** — "enterprise" here denotes an **engineering quality
  bar** (security, auditing, RBAC, testing, operability), **not** a commercial
  edition. There are no editions to buy.

## Clean Architecture layers

UltraTorrent follows Clean Architecture. Dependencies point inward; the domain
knows nothing about HTTP, Prisma, or any specific engine.

| Layer | Responsibility | Examples |
|-------|----------------|----------|
| **API** | HTTP controllers, DTOs/validation, guards, WebSocket gateway | `*.controller.ts`, `RealtimeGateway` |
| **Application** | Orchestrates use cases, RBAC, auditing | `TorrentsService`, `EngineRegistryService`, `TorrentSyncService`, `MediaProcessingService` |
| **Domain** | Engine- and provider-agnostic contracts — *the seams* | `TorrentEngineProvider`, `MediaMetadataProvider`, `Normalized*` types |
| **Infrastructure** | Concrete adapters | `RTorrentProvider`, XML-RPC/SCGI client, `TmdbMetadataProvider`, `PrismaService` |

### The engine seam

`TorrentEngineProvider` is the single interface every engine implements
(add/remove/start/stop/recheck/move, file priorities, trackers, rate limits,
stats). The current product ships a complete **rTorrent** provider (XML-RPC over
SCGI/HTTP); adding another engine means implementing this interface — no UI or
business-logic changes. A background `TorrentSyncService` polls each engine and
fans normalized torrent lists, global stats, and engine status out over the
WebSocket gateway. This engine seam is one instance of the broader
[Provider Architecture](#provider-architecture) described next.

## Provider Architecture

Providers are the platform's primary extensibility mechanism. A **provider** is
an interface in the domain layer that isolates an external service (a torrent
engine, a metadata source, a media server, a notifier, …) from the business
logic that uses it. Application services depend on the interface, never on a
concrete vendor client. This keeps the core stable, makes external services
swappable, and makes each integration independently testable.

**Rule of extension:** future integrations MUST be added as new providers (new
implementations of a provider interface, wired through a factory/registry),
**not** by modifying core modules. A new metadata source, engine, or media
server should require zero changes to the services that consume it.

The provider interfaces below define the platform's integration surface. Some
ship today; others are defined/planned as the ecosystem grows:

| Provider interface | Purpose | Status |
|--------------------|---------|--------|
| **TorrentEngineProvider** | Control a BitTorrent engine (add/remove/lifecycle/files/trackers/limits/stats) | **Implemented** — `RTorrentProvider` |
| **MediaMetadataProvider** | Resolve titles → metadata (overview, cast, genres, external IDs) | **Implemented** — `LocalMetadataProvider`, `TmdbMetadataProvider`, `ImdbMetadataProvider` (compliant: user datasets / licensed API, no scraping) |
| **MediaServerProvider** | Trigger library refreshes on a media server | **Implemented** — Plex, Jellyfin, Emby, Kodi connectors |
| **NotificationProvider** | Deliver notifications to external channels | **Implemented** — in-app, webhook, Discord, Slack, Telegram fan-out |
| **ArtworkProvider** | Fetch typed artwork (poster/fanart/logo/…) | **Partial** — artwork is fetched/uploaded/selected today; a dedicated remote artwork provider is a planned extraction |
| **SubtitleProvider** | Discover and fetch subtitles | **Partial** — sidecar discovery ships today; remote subtitle download (e.g. OpenSubtitles) is planned |
| **RSSProvider** | Poll and parse feeds into candidate releases | **Implemented** — the RSS module's polling/parse layer |
| **AuthenticationProvider** | Verify credentials / issue identity | **Implemented (internal)** — local Argon2id + JWT; external IdP (OIDC/LDAP) is a planned provider |
| **StorageProvider** | Read/write files behind a path-safe boundary | **Implemented (local)** — root-confined local filesystem; cloud/object storage is planned |

**Future provider interfaces.** As the platform grows, additional seams are
anticipated — e.g. indexer providers, transcode/processing providers, and cloud
storage providers. Each will follow the same contract-first pattern so the core
never learns about a specific vendor.

## Backend modules (Core)

Every capability is a NestJS module, each RBAC-guarded and audited where it
mutates state. All modules are **core** to this single product; navigation
grouping mirrors [NAVIGATION.md](NAVIGATION.md):

- **auth** — login (+ optional 2FA), JWT access tokens, rotating/hashed refresh
  tokens with reuse detection, logout, change-password.
- **users / RBAC** — users, system roles, and a dot-namespaced permission
  catalog (in `@ultratorrent/shared`).
- **two-factor** — TOTP enrolment/verification, encrypted secrets, recovery
  codes.
- **torrents** — add (magnet / file / URL), lifecycle actions, bulk actions,
  trackers, file priorities, limits, move.
- **engine** — provider factory + `EngineRegistryService` (resolve engines).
- **files** — path-safe file manager (browse/preview/download/rename/move/copy/
  mkdir/delete-to-trash/cleanup) confined to configured roots.
- **rss** — feeds + include/exclude rules + a ranked match-preference engine and
  Smart Match Builder.
- **automation** — condition/action rules triggered by events. Torrent triggers
  (`torrent.completed`, `ratio.reached`) and actions
  (stop/delete/move/notify/webhook/`rename_for_media`) plus the Media Manager
  triggers (`media.detected|matched|unmatched|missing_artwork|
  missing_subtitles|rename_completed|server_refresh_failed`) and actions
  (`media_scan_library`, `media_match`, `media_fetch_metadata`,
  `media_fetch_artwork`, `media_generate_nfo`, `media_rename`, `media_move`,
  `media_notify`, `media_server_refresh`). Media actions are delegated to
  `MediaAutomationActions` (media module) so the engine keeps no engine-provider
  dependency. Catalog exposed at `GET /api/automation/catalog`.
- **media-manager** — the media-organization subsystem (see
  [Media Manager](#media-manager) below). Libraries, identification,
  metadata/artwork/subtitles, NFO, duplicate detection, rename engine,
  media-server integration, and the post-download workflow, all under
  `/api/media` and the `media_manager.*` permission block.
- **media-acquisition-intelligence** — a core module that decides **what** to
  acquire by orchestrating RSS, scoring, and automation into an explainable
  acquisition decision (watchlist, acquisition profiles, approval queue). RBAC
  `media_acquisition.*`. See
  [MEDIA_ACQUISITION_INTELLIGENCE.md](MEDIA_ACQUISITION_INTELLIGENCE.md).
- **release-scoring** — a core module that scores a parsed release (0–100) and
  returns an accept/reject decision with reasons and warnings; consumed by RSS
  and acquisition intelligence.
- **taxonomy** — categories & tags.
- **notifications** — in-app + webhook/Discord/Slack/Telegram fan-out.
- **dashboard**, **search**, **settings**, **apikeys**, **audit**, **system**
  (health/liveness/version), **realtime**, **module-registry**.

Release Scoring and Media Acquisition Intelligence are **core** modules, not
add-ons; they are available in this repository and gated only by RBAC.

## Media Manager

Media Manager (id `media_manager`, route `/api/media`, menu group **Media**) is
a first-class core subsystem that turns completed downloads into clean,
media-server-ready libraries. It is where "download a torrent" becomes "a
correctly named, enriched, filed, and server-visible piece of media." Full
detail is in [MEDIA_MANAGER.md](MEDIA_MANAGER.md); the key capabilities:

- **Libraries** — a `MediaLibrary` points the subsystem at a folder and declares
  its `kind` (tv/anime/movie/music/audiobook/general), naming `preset`
  (plex/jellyfin/emby/kodi/custom), `template`, and rename `mode`
  (preview/rename-in-place/rename-move/copy/hardlink/symlink). Scanning is
  confined to the file manager's hard roots (`FILE_MANAGER_ROOTS`).
- **Media identification** — scanning discovers files and creates a `MediaItem`
  per title; release-name parsing derives type/title/year/season/episode with a
  confidence score and a `matchStatus` (`unmatched`/`matched`/`manual`).
- **Metadata** — resolved through the `MediaMetadataProvider` abstraction
  (`local` NFO sidecars always available; `tmdb` when a key is configured;
  `imdb` from user-provided IMDb datasets and/or a licensed IMDb API — never
  HTML scraping — with root-path-confined dataset import and an encrypted key).
  External IDs (tmdb/tvdb/imdb/omdb/anilist) are recorded per item.
- **Artwork** — typed artwork (poster/fanart/logo/clearart/banner/thumbnail/
  season/episode) fetched, uploaded, and selected per item.
- **Subtitle management** — sidecar discovery with language/forced/SDH flags and
  missing-language detection.
- **NFO generation** — Kodi-style movie/tvshow/season/episode sidecars, written
  only inside the hard roots.
- **Duplicate detection** — `MediaDuplicateGroup`s formed by reason
  (title+year, show+season+episode, external ID, file hash, similar filename).
- **Rename engine** — a token-based template renderer with per-library presets,
  preview/dry-run, apply, and history; every path segment is sanitized.
- **Library health** — a dashboard surfacing unmatched items, missing
  artwork/subtitles, and duplicates.
- **Media-server refresh** — pushes library refreshes to Plex/Jellyfin/Emby/Kodi
  via `MediaServerIntegration` (secrets AES-GCM encrypted at rest, redacted in
  responses).
- **Post-download processing** — see below.
- **Processing queues** — long-running work is dispatched to an in-process
  `MediaProcessingQueueService` that persists each unit as a
  `MediaProcessingJob` and streams progress over WebSocket.

### Integration with Torrent Management

`MediaProcessingService` subscribes to the **`torrent.completed`** event and runs
an **opt-in, best-effort** pipeline. It fires **only** for enabled libraries
whose root `path` contains the torrent's save path — arbitrary downloads are
never auto-organized. Each stage is isolated (a failure never aborts the rest),
and the handler never throws (protecting the sync loop):

```
scan ─▶ identify ─▶ rename/move (per library.mode) ─▶ metadata ─▶ artwork
                                                                      │
                                            subtitles ─▶ NFO ─▶ media-server refresh
```

### Integration with Automation

Each pipeline stage fires a `media.*` **trigger** consumed by the automation
engine, and the engine exposes `media_*` **actions** that let operators build
their own condition/action rules (e.g. "on `media.missing_subtitles`, notify").
This makes the whole media workflow both automatic (the post-download pipeline)
and user-programmable (automation rules) over the same event surface.

## Event-Driven Architecture

Modules communicate through **domain events**, not tight coupling: a module
emits an event when something happens, and interested modules react. This keeps
producers unaware of consumers and lets new behavior subscribe without editing
the producer. In the current implementation this is realized by three
cooperating mechanisms:

1. The **WebSocket gateway** (`RealtimeGateway`) pushes state-change events to
   permission-scoped client rooms (e.g. `media_manager.job.*` reaches only
   `perm:media_manager.view`).
2. The **automation engine's triggers/actions** carry domain events into
   user-defined condition/action rules (`GET /api/automation/catalog`).
3. The **`MediaProcessingJob` queue** turns long-running reactions into tracked
   background jobs whose lifecycle is itself emitted as events.

Representative platform events across the domain (some are live automation
triggers / WS events today, others describe the intended event vocabulary as the
system grows):

| Event | Emitted when… |
|-------|---------------|
| `TorrentAdded` | A torrent is added. |
| `TorrentStarted` | A torrent starts. |
| `TorrentCompleted` | A download completes (live: `torrent.completed`). |
| `TorrentRemoved` | A torrent is removed. |
| `MetadataMatched` | An item is matched (live: `media.matched`). |
| `ArtworkDownloaded` | Artwork is fetched for an item. |
| `SubtitleDetected` | A sidecar subtitle is discovered. |
| `LibraryScanned` | A library scan completes (live: `media.detected` per file). |
| `MediaRenamed` | A rename/move completes (live: `media.rename_completed`). |
| `DuplicateDetected` | A duplicate group is formed. |
| `AutomationTriggered` | An automation rule's trigger fires. |
| `AutomationCompleted` | An automation rule's actions finish. |
| `NotificationQueued` | A notification is enqueued for delivery. |
| `NotificationSent` | A notification is delivered. |
| `MediaServerRefreshRequested` | A media-server refresh is requested. |
| `MediaServerRefreshCompleted` | A media-server refresh succeeds (failure: `media.server_refresh_failed`). |
| `SettingsChanged` | A platform setting changes. |
| `UserCreated` | A user is created. |
| `RoleUpdated` | A role's permissions change. |
| `PermissionChanged` | A permission grant changes. |

## Background Workers

Long-running work must **never block an HTTP request**. Acquisition, scanning,
enrichment, renaming, and delivery all run asynchronously as background jobs, so
the API stays responsive and failures are isolated and observable. The current
implementation uses an **in-process `MediaProcessingQueueService`** (persisting
each unit as a `MediaProcessingJob` with queued/running/completed/failed +
progress) together with **`@nestjs/schedule`** intervals and **Redis** for
caching/coordination — no external broker is required, and the design leaves room
to move to a distributed queue later without changing callers.

Representative background workloads:

| Worker | Cadence / trigger |
|--------|-------------------|
| RSS polling | scheduled interval |
| Torrent synchronization | short polling interval → normalized fan-out |
| Metadata retrieval | queued job |
| Artwork downloads | queued job |
| Subtitle scanning | queued job |
| Library scanning | queued job / scheduled per-library interval |
| Duplicate detection | queued job |
| Rename execution | queued job |
| NFO generation | queued job |
| Media-server refresh | queued job |
| Notification delivery | async fan-out |
| Cleanup jobs | scheduled / on demand |

## Security model

UltraTorrent controls a service that can move and delete files on disk, so
security is a first-class concern. Authorization is **RBAC-only**: every feature
is included in the product, and administrators grant access with roles and
permissions. There is **no licensing, edition, or feature gating** — the only
access decision is "does this user hold the required permission?"

- **AuthN:** Argon2id password hashing; short-lived JWT access tokens (HS256,
  algorithm-pinned); refresh tokens rotated on use, stored hashed, with reuse
  detection; production boot refuses unset/weak/default secrets.
- **AuthZ (RBAC):** every protected route carries `JwtAuthGuard` +
  `PermissionsGuard` + `@RequirePermissions(...)`. The UI hides what a user
  can't use; the server always enforces. Module enable/disable state is a UI/
  routing convenience only — it never substitutes for the RBAC check.
- **Path safety:** all file/torrent/media paths are canonicalized (realpath) and
  confined to `FILE_MANAGER_ROOTS`; traversal, symlink-escape, absolute-escape,
  and system directories are rejected. An admin-set Default Root Path can only
  narrow within that boundary.
- **Input/transport:** global `ValidationPipe` (`whitelist` +
  `forbidNonWhitelisted`), Helmet, throttling (with stricter login/refresh
  limits), pagination caps, SSRF-guarded remote-torrent fetch, and a global
  exception filter (no stack-trace leakage).
- **Secrets:** integration secrets (media-server tokens/keys/passwords) are
  AES-GCM encrypted at rest and redacted in API responses; secrets are never
  logged or returned to clients.
- **WebSocket:** JWT-authenticated handshake; each socket only joins the
  permission-scoped feeds it may read.
- **Audit:** destructive/security-relevant actions are recorded with actor, IP,
  user agent, and result.

To report a vulnerability, see the **Security** section of the
[README](../README.md#security) and [SECURITY.md](SECURITY.md).

## Data & caching

**PostgreSQL** via **Prisma** is the store (users/roles/permissions, torrent
snapshots, categories/tags, RSS, automation, notifications, API keys, audit log,
settings, and the full Media Manager model set). **Redis** backs caching and
background-job coordination. Migrations live in
`apps/backend/prisma/migrations`; the seed provisions permissions, system roles,
the bootstrap admin, and default settings (idempotent).

## Frontend & Navigation

React 18 + Vite + TypeScript + Tailwind, React Router, TanStack Query, and a
Socket.IO client. The app shell has a grouped, collapsible sidebar whose items
are filtered by permission + module state; a top bar with breadcrumbs, live
transfer rates, and connection status; and route-level `ProtectedRoute` /
`ModuleRoute` guards. Navigation is **code-defined** (`navigation.ts`), grouped
into Overview, Torrents, Automation, Files & Media, Infrastructure,
Administration, and System. See [NAVIGATION.md](NAVIGATION.md) for the nav model.

### Internationalization (i18n)

The UI is fully localizable via **i18next + react-i18next**, shipping two
languages out of the box: **en-US** (default and fallback) and **es-PR**
(Spanish). Translations are **static, typed, namespaced JSON** under
`src/i18n/locales/<lng>/<namespace>.json` (namespaces split by surface —
`common`, `nav`, `auth`, `shell`, `media`, `imdb`, …), so nothing loads over the
network and `t()` keys are type-checked (`i18next.d.ts`). Components read strings
through `useTranslation(namespace)`; dynamic values use interpolation and counts
use i18next pluralization. A **language switcher** in the app-shell top bar lets
each user pick their language; the choice is detected/persisted in
`localStorage` (`ultratorrent.lang`) and Spanish browser variants (`es`,
`es-ES`, `es-419`) resolve to es-PR. New surfaces add their namespace + both
language files; page migration to `t()` is rolling out across the app — the
Media Manager and IMDb surfaces (namespaces `media` / `imdb`) were translated
first, followed by RSS/Torrents/Files/Automation and the core admin/account
pages (Dashboard, Settings, Users, Modules, Engines, Audit, Account, System),
with the remaining pages to follow.

## Deployment (Docker)

UltraTorrent is Docker-native. Compose brings up the database, cache, backend,
and frontend together; the backend runs `prisma migrate deploy` on start. There
are **no insecure defaults** — Compose refuses to start without
`POSTGRES_PASSWORD`/`ADMIN_PASSWORD`, and in production the backend refuses to
boot unless `JWT_ACCESS_SECRET` and `ENCRYPTION_KEY` are set, ≥32 chars, and
distinct. Public `/api/system/live` and `/api/system/ready` probes support
container/orchestrator health checks. See [DOCKER.md](DOCKER.md) and
[INSTALL.md](INSTALL.md) for the full service reference and NAS install guides.

## External Integrations

All external services are reached through the [provider
abstractions](#provider-architecture) — the core never embeds a vendor client
directly. This is the platform's current and planned integration surface:

| Category | Integrations |
|----------|-------------|
| **Torrent engines** | rTorrent (implemented); qBittorrent, Transmission, Deluge (planned) |
| **Metadata** | TMDB, IMDb (implemented — IMDb via user-provided datasets or a licensed IMDb API, **never** HTML scraping); OMDb, TVDB, AniList (planned) |
| **Subtitles** | OpenSubtitles (planned; sidecar discovery ships today) |
| **Media servers** | Plex, Jellyfin, Emby, Kodi (implemented) |
| **Notifications** | Discord, Slack, Telegram, Email, Webhooks (webhook/Discord/Slack/Telegram implemented; email planned) |
| **Future** | Indexers, cloud storage, transcode/processing services, external identity providers |

Each integration is (or will be) a provider implementation, added without
modifying the modules that consume it.

## Future Vision

UltraTorrent is evolving into a complete **media acquisition & management
ecosystem** that reaches well beyond BitTorrent. The provider- and event-based
architecture is the foundation for:

- **Additional torrent engines** — qBittorrent, Transmission, Deluge behind the
  same `TorrentEngineProvider`.
- **Additional metadata providers** — TVDB, AniList, IMDb datasets, OMDb.
- **A plugin system** — third-party providers/modules loaded without forking.
- **Cloud storage providers** — object/cloud backends behind `StorageProvider`.
- **Media processing pipelines** — transcoding, remuxing, and quality
  normalization as background workers.
- **AI-assisted metadata matching** — smarter identification of ambiguous
  releases.
- **OCR** — extracting text (e.g. from images/subtitles) to aid identification.
- **Automatic quality analysis** — scoring and upgrade decisions on acquired
  media.
- **Distributed processing & multi-node deployments** — moving background work
  to a shared queue across nodes.
- **Advanced analytics** — acquisition, library-health, and usage insights.
- **Workflow automation expansion** — a richer trigger/action/condition
  vocabulary across every module.

## Repository layout

```
apps/backend      NestJS API (@ultratorrent/backend)
apps/frontend     React + Vite SPA (@ultratorrent/frontend)
packages/shared   @ultratorrent/shared — types, permission catalog, event contracts
docs/             this documentation set
```

## Further reading

[README](../README.md) · [INSTALL.md](INSTALL.md) · [DOCKER.md](DOCKER.md) ·
[DEVELOPMENT.md](DEVELOPMENT.md) · [NAVIGATION.md](NAVIGATION.md) ·
[MODULES.md](MODULES.md) · [FILE_MANAGER.md](FILE_MANAGER.md) ·
[MEDIA_MANAGER.md](MEDIA_MANAGER.md) ·
[MEDIA_ACQUISITION_INTELLIGENCE.md](MEDIA_ACQUISITION_INTELLIGENCE.md) ·
[API.md](API.md) · [SECURITY.md](SECURITY.md)

## Change Log

This is the canonical architecture doc for the single-tier community repository.
When a component is added or changed, update the relevant section above **and**
append a dated row here.

| Date | Change |
|------|--------|
| 2026-07-04 | **i18n coverage: core admin/account pages.** Migrated Dashboard, Settings, Users, Modules, Engines, Audit, Account (Profile), and System (NotFound/ErrorBoundary/LockedModule) surfaces to `t()` under eight new namespaces — `dashboard` (27 keys), `settings` (33), `users` (43), `modules` (42), `engines` (51), `audit` (16), `account` (53), `system` (8) — each shipping en-US + es-PR with exact key parity; shared UI chrome (dialog, drawer, toast, language switcher) also localized. Final sweep migrated the remaining MediaAcquisition + ReleaseScoring pages into the `media`/`rss` namespaces. |
| 2026-07-04 | **i18n coverage: RSS, Torrents, Files, Automation.** Migrated these surfaces to `t()` under four new namespaces — `rss` (350 keys), `torrents` (157), `files` (194), `automation` (75) — each shipping en-US + es-PR with exact key parity; enum/status labels resolve via render-time helpers. |
| 2026-07-04 | **Internationalization (i18next).** The frontend gains an i18n framework (`i18next` + `react-i18next` + language detector) with two shipped languages — **en-US** (default/fallback) and **es-PR** — as static, typed, namespaced JSON under `src/i18n/locales/`. A **language switcher** in the app-shell top bar persists the choice in `localStorage` (`ultratorrent.lang`); Spanish browser variants resolve to es-PR. Core surfaces (navigation, login, app-shell chrome, common UI, feedback) are translated; page migration to `t()` (Media Manager/IMDb, then the rest) is rolling out. Nav/breadcrumbs translate at render so structure tests stay stable. |
| 2026-07-04 | **Added a compliant IMDb metadata provider.** New `ImdbMetadataProvider` (`imdb`) resolves metadata from **user-provided IMDb datasets** (seven `.tsv.gz` files streamed into eight Prisma models — `IMDbTitle`/`IMDbAka`/`IMDbCrew`/`IMDbEpisode`/`IMDbPrincipal`/`IMDbPerson`/`IMDbRating`/`IMDbDatasetImport`) and/or an **optional licensed IMDb REST API** — **never** HTML scraping of imdb.com. Settings live under `media.imdb` (mode `disabled`/`dataset`/`official_api`/`hybrid`, dataset path confined to `FILE_MANAGER_ROOTS` via `FilePathService`, AES-GCM-encrypted API key). Resumable, detached gz-TSV importer streams progress over `imdb.dataset.validate.*`/`imdb.dataset.import.*` WS events; manual match (`imdb.match.completed`) stores the IMDb id as a `MediaExternalId` and drives cross-provider enrichment (TMDB `/find` + OMDb, separate licensed keys; `imdb.enrichment.completed`). Endpoints under `/api/media/providers/imdb/*` + `POST /api/media/items/:id/match/imdb`; new `media_manager.imdb.{view,configure,import_dataset,search,match}` permissions (added to the `media_manager` manifest); settings/dataset/match/api-test are audited. Frontend `/media/settings/imdb` page + Media Detail IMDb panel + Unmatched IMDb suggestions. |
| 2026-07-03 | **Repositioned as a Media Acquisition & Management Platform.** Reframed the introduction and terminology from "torrent management platform / torrent client" to a self-hosted media acquisition & management platform that combines BitTorrent downloading, RSS automation, media organization, metadata/artwork/subtitle management, NFO generation, file management, automation, media-server integrations, multi-user administration, REST/WebSocket APIs, and Docker deployment. |
| 2026-07-03 | **Removed all licensing/edition concepts from the architecture.** Purged every architectural reference to editions, license tiers, and feature/module licensing/gating. Access is RBAC-only; every feature is included in the single community product. Only the open-source AGPL license and explicit "no editions/licensing" statements remain. |
| 2026-07-03 | **Added Core Principles.** Documented the platform's engineering principles (Open Source, API First, Docker Native, Secure by Default, Provider-Based, Event-Driven, Modular, Automation First, Real-Time, Cross-Platform, Extensible, Enterprise-Quality as a quality bar). |
| 2026-07-03 | **Added Provider Architecture.** Dedicated section documenting the provider seam pattern and the TorrentEngine/MediaMetadata/Artwork/Subtitle/MediaServer/Notification/RSS/Authentication/Storage provider interfaces (implemented vs planned) and the rule that new integrations are added as providers, not core edits. |
| 2026-07-03 | **Expanded Media Manager as a first-class subsystem.** Documented libraries, identification, metadata/artwork/subtitles, NFO, duplicate detection, rename engine, library health, media-server refresh, processing queues, and its integration with Torrent Management (post-download off `torrent.completed`) and Automation (`media.*` triggers / `media_*` actions). |
| 2026-07-03 | **Added Event-Driven Architecture.** Described inter-module communication via domain events (WebSocket gateway + automation triggers + `MediaProcessingJob` queue) with a representative event vocabulary. |
| 2026-07-03 | **Added Background Workers.** Documented asynchronous processing (in-process `MediaProcessingQueueService` + `@nestjs/schedule` + Redis) and the representative worker workloads that must never block HTTP requests. |
| 2026-07-03 | **Added External Integrations.** Consolidated current and planned external services (torrent engines, TMDB/IMDb/OMDb/TVDB/AniList, OpenSubtitles, Plex/Jellyfin/Emby/Kodi, Discord/Slack/Telegram/Email/Webhooks) reached through provider abstractions. |
| 2026-07-03 | **Added Future Vision.** Outlined the platform's evolution toward a complete media acquisition & management ecosystem (more engines/providers, plugin system, cloud storage, processing pipelines, AI-assisted matching, OCR, quality analysis, distributed/multi-node processing, analytics, expanded automation). |
| 2026-07-03 | **Removed dead Enterprise/Pro/licensing scaffolding (single-tier cleanup).** With the product fully single-tier community, the leftover gating/tiering machinery was purged: the `'premium'`/`'enterprise'` `ModuleTier`/`Edition` values, `requiredLicenseModule`, the `PREMIUM_MANIFESTS`/`ENTERPRISE_MANIFESTS` + placeholder manifests, the unused module-gating layer, `media_renamer_pro` remnants, and the remaining overlay comments across `packages/shared`, `apps/backend`, `apps/frontend`, and `docs/`. Modules are Core, gated only by RBAC (+ an optional enable/disable flag). |
| 2026-07-03 | **Media Manager automation + post-download workflow + job queue.** Automation engine gained Media Manager triggers (`media.detected|matched|unmatched|missing_artwork|missing_subtitles|rename_completed|server_refresh_failed`) and actions (`media_scan_library`/`media_match`/`media_fetch_metadata`/`media_fetch_artwork`/`media_generate_nfo`/`media_rename`/`media_move`/`media_notify`/`media_server_refresh`) delegated to `MediaAutomationActions`; a trigger/action catalog is exposed at `GET /api/automation/catalog`. New `MediaProcessingService` runs an opt-in best-effort post-download pipeline off `torrent.completed` (scan → identify → rename/move per `library.mode` → metadata → artwork → subtitles → NFO → media-server refresh) for downloads inside a covering library. New in-process `MediaProcessingQueueService` persists long-running operations as `MediaProcessingJob` rows (queued/running/completed/failed + progress) and streams their lifecycle over the RealtimeGateway. Added WS events `media_manager.job.{started,progress,completed,failed}` and the `MediaJobEventPayload` contract in `@ultratorrent/shared`; the gateway scopes the `media_manager.*` channel to `MEDIA_MANAGER_VIEW`. |
| 2026-07-03 | **Media Manager core module.** New `media_manager` module evolved from the core renamer. Prisma models `MediaItem`/`MediaFile`/`MediaMetadata`/`MediaArtwork`/`MediaSubtitle`/`MediaExternalId`/`MediaCollection`/`MediaCollectionItem`/`MediaRenameTemplate`/`MediaProcessingJob` (+ duplicate-group, media-server-integration, NFO) via the `media_manager_models` migration. Backend services: library/scanner/identification/item/health, plus metadata/artwork/subtitle/NFO/duplicate/media-server-integration, and the retained rename engine. Endpoints under `/api/media`; `media_manager.*` permission block. Frontend: Media Dashboard/Items/Libraries pages + routing/nav + `api.mediaManager`. |
| 2026-07-03 | **Single-tier community conversion.** The product was consolidated from a dual community/enterprise split into one community platform in this repo: the enterprise overlay and its modules (Fleet, Customers, Provisioning, Billing, Central Backups/Updates, Analytics, White-Label, Multi-Server, Node Agent) were removed, Release Scoring + Media Acquisition Intelligence were relocated into core, and the versioning/publish tooling was de-editioned. This doc is now the canonical architecture reference. |
</content>
