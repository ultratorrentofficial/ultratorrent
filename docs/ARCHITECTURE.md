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
| **ArtworkProvider** | Resolve an item's external id → downloadable artwork candidates (poster/fanart/logo/…) | **Implemented** — `TmdbArtworkProvider` (fanart.tv/TVDB planned); downloads share the upload magic-byte + size validation and a host allowlist |
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
  Smart Match Builder. Auto-download is deduped/deconflicted on three levels
  (all enforced in both polling and backfill): per feed item by `(feedId,
  itemGuid)`; per torrent by BitTorrent info-hash (btih parsed from the magnet)
  so the same release under a rotated guid, a re-post, or a second feed is never
  grabbed twice; and **per logical title** (`RssAcquisition`) so a rule with a
  preference list holds only one release per movie/episode — it grabs the
  best-available, *upgrades* to a strictly higher-priority release when one later
  appears (removing the superseded torrent + data), and skips equal-or-lower
  releases. Release identity (`releaseIdentity`) is parsed to
  `movie:<title>:<year>` / `ep:<title>:<season>:<episode>`; unparseable titles
  fall back to per-release behavior. **TV show airing-status awareness**
  (`rss/tv-show-status/`): a pluggable `TvShowStatusProvider` (TMDB → IMDb
  dataset → local, tried in confidence order) resolves a show's airing status,
  which `TvShowStatusService` normalizes (`continuing`/`returning`/`planned`/
  `on_hiatus`/`ended`/`canceled`/`unknown`) into a monitoring recommendation.
  `GET /rss/show-status/lookup` (+ `lookup-batch`) power a pre-save status panel;
  saving a TV rule for an ended/canceled show **requires**
  `allowInactiveShowMonitoring` (audited) — no provider-specific status rules
  live in `RssService`. The resolved snapshot is stored on the rule and cached in
  `tv_show_status`.
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
  season/episode) per item, sourced from operator upload or an online
  `ArtworkProvider` (`TmdbArtworkProvider` — resolves the item's TMDB id,
  downloads poster+fanart into the hard root through the shared image
  validation, and records provenance `source: 'tmdb'`). Custom uploads keep
  selection precedence over auto-imported art.
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
| 2026-07-06 | **RSS — TV show airing-status awareness (Phase 2, frontend rule flow).** Reusable `ShowStatusPanel` + `useShowStatusLookup` hook + `ShowStatusBadge` (`apps/frontend/src/components/rss/`) render the airing-status badge, recommendation banner, provider + confidence, next/last-episode dates, poster, warnings, and a refresh button from `GET /api/rss/show-status/lookup`. The RSS rule create/edit dialog (`RssPage.tsx` `RuleDialog`) gains a **Media type** selector; choosing TV/anime shows the live status panel keyed on the rule name, and **saving a rule for an ended/canceled show opens a confirmation modal** ("Create rule anyway") that sets `allowInactiveShowMonitoring` — the resolved snapshot (`showStatusProvider`/`showStatusProviderId`/`mediaType`) is sent to the backend, which persists + re-validates it. `api.rss.showStatusLookup` + `ShowStatusResult`/`RssShowStatus`/`RssShowRecommendation` types added; `rss.showStatus.*` i18n (en-US + es-PR, parity-tested). Tests: `ShowStatusPanel` render (ended→not-recommended+backfill, returning→recommended) + `showStatusIsInactive`. **Remaining Phase 2b/3: status badge on the Smart Match Builder / Match Preferences Builder / rule list + detail, automation triggers/actions, and the scheduled background refresh.** |
| 2026-07-06 | **RSS — TV show airing-status awareness (Phase 1, backend).** New pluggable `TvShowStatusProvider` layer (`apps/backend/src/modules/rss/tv-show-status/`): `TmdbTvShowStatusProvider` (status + next/last episode), `ImdbTvShowStatusProvider` (dataset `endYear`/`titleType`), `LocalNfoTvShowStatusProvider` fallback, aggregated by `TvShowStatusService` in confidence order. Pure `normalizeShowStatus()`/`recommendationFor()` map any provider's answer to a provider-agnostic status (`continuing`/`returning`/`planned`/`on_hiatus`/`ended`/`canceled`/`unknown`) and recommendation (`recommended`/`caution`/`not_recommended`/`unknown`) — no provider rules leak into `RssService`. Endpoints `GET /api/rss/show-status/lookup` + `POST …/lookup-batch` (perm `rss.show_status.lookup`). Creating/editing a TV rule (`mediaType ∈ tv/anime/episode/series`) captures a **status snapshot** on `RssRule` and **requires `allowInactiveShowMonitoring`** for ended/canceled shows (else 400) — override is audited (`rss.rule.created_for_inactive_show`) + emits a WS event; unknown status saves with a warning; active saves normally. New `tv_show_status` cache table (migration `20260706210000_rss_show_status`, validated no-drift). New perms `rss.show_status.{lookup,refresh,override}` (manifest + role grants); `rss.*` WS events scoped to `rss.view`. Tests: normalization/recommendation, service lookup + provider fallback, and save-validation (ended requires override, unknown warns, active saves, non-TV skips) — 91 RSS specs green. **Phase 2/3 (not in this change): frontend status panel/badges/confirm modal, automation triggers/actions, background status-refresh job, and RSS.md/MODULES.md docs.** |
| 2026-07-06 | **Media Server Analytics — equal-height newsletter card grid (Gmail-safe).** Two cards in a row rendered at their own content heights, so a show with a long overview left its paired card's amber panel visibly shorter/ragged. The card "panel" (background/border/padding) now lives on the grid **cell** (`CARD_PANEL` on the `.col` `<td>`) instead of a nested table — sibling cells in a table row are always drawn at equal height, which Gmail/Outlook honour (unlike `height:100%` on a nested table, which only browsers respect). `tvCard`/`movieCard` now return just the inner content; a shared `twoColGrid()` lays out panel-cell · gutter-cell (`.gut`, 14px) · panel-cell rows with 12px spacer rows between, and `MOBILE_STYLE` collapses `.col` to full width (keeping the panel padding) and hides `.gut`. `renderHtml`/`renderText` and all 23 render specs unchanged/green. |
| 2026-07-06 | **Media Items grouped TV browser — larger posters + smaller default page.** `SeriesGroupedList` show posters enlarged (`h-14 w-10` → `h-[7.5rem] w-20`, 2:3) and the default page size dropped 30 → 10 shows per page (`SERIES_PAGE_SIZE`). |
| 2026-07-06 | **Media Server Analytics — downscale newsletter poster attachments so they render.** Full-size library posters run 250KB–1MB+, but the inline size cap (`MAX_POSTER_BYTES`, 500KB) silently dropped anything larger — so after the grouping/artwork fix most cards *still* fell back to the gradient placeholder (a real test send showed 4 correct show cards but only 1 poster + 3 placeholders, because only one poster was under 500KB). `loadPoster()` now resizes each poster to a small JPEG (`POSTER_TARGET_WIDTH` 240px, via **sharp**) before attaching — the card slot is only ~84–120px, so a full-resolution poster was massive overkill. Real posters drop from 250KB–1.1MB to ~20KB, so every card gets its artwork and a full 30-poster email stays well under 1MB; a raw-input guard (`MAX_RAW_POSTER_BYTES` 12MB) protects sharp, and it falls back to the original image (if within the cap) when resizing fails. |
| 2026-07-06 | **Media Items — group TV shows when a TV-kind library is selected.** The grouped Show → Season → Episode view (`SeriesGroupedList` / `/media/series`) only triggered when the **media-type** filter was TV/anime, so browsing the **TV Shows library** (via the library filter) showed a flat episode list. `MediaItemsPage.isTvGrouped` now also turns on when the selected library's `kind` is `tv`/`anime` (unless an explicit non-TV type filter is active) — the flat query stays disabled in that mode and `series()` already honours the `libraryId` filter. |
| 2026-07-06 | **Media Server Analytics — fix TV newsletter grouping + artwork for unidentified episodes.** Episodes imported with a raw release title (`"Show - S02E01 - Name"`) and null `season`/`episode` were grouped by exact `title`, so each became its own one-episode "show" (blank ranges, no poster) — the TV section rendered as a wall of broken cards with almost all artwork missing (observed live in a real send: 9 junk cards, 1 poster, 8 gradient placeholders). `MediaServerNewsletterService.build()` now normalizes the show name + S/E from the title via the RSS `parseTorrentName` parser (TV media types only, only when a season/episode is parseable) so those episodes collapse into their real show, and a new `fetchShowPosters()` resolves each show's poster **from the whole library by (normalized) show title** — preferring `poster` → `season_poster` → `thumbnail` → `fanart`, selected-first — instead of the newest (often artwork-less) episode's own artwork; `assemblePosters()` now takes that show-poster map (falling back to the representative item, then movie-by-id) and emits index-based `nlposter-N` CIDs. Verified against real synoplex data: the 9-card/1-poster section became 4 correct show cards (Young Sheldon 27 eps S06–S07, Your Honor US 20 eps, ted 7 eps, House of the Dragon 6 eps S02–S03), each with its real poster. (Deeper cause — those episodes were imported unidentified, no S/E/IMDb/artwork — remains a scanner-identification follow-up.) |
| 2026-07-06 | **Media Server Analytics — edit newsletter campaigns.** The Newsletters page could create/delete campaigns and inline-edit only the content window + sections; a campaign's **name / frequency / recipients** couldn't be changed after creation. Added a per-campaign **Edit** (pencil) toggle that reveals those fields with Save/Cancel, persisting through the existing `updateNewsletter` (PATCH) endpoint. i18n en-US + es-PR. |
| 2026-07-06 | **Media Server Analytics — move Email/SMTP setup from Newsletters to Settings.** The SMTP config (host/port/secure/auth/from + test-send) was the `EmailSettingsCard` embedded in `NewslettersPage`; it's now extracted to its own `EmailSettingsCard.tsx` and rendered on the global **Settings** page, gated by `media_server_analytics.manage_settings` (the same permission its endpoints require), and removed from the Newsletters page. Self-contained — keeps its `mediaServerAnalytics` i18n namespace + API calls; no behavior change, just relocation. |
| 2026-07-06 | **Media artwork — display each artwork type at its natural aspect ratio.** The detail **Artwork tab** rendered every type in a `aspect-[2/3]` poster frame with `object-cover`, so wide **banners** (and fanart / transparent logos / clearart) were cropped to a vertical center slice and looked distorted. `MediaPoster` gained a `fit` prop (`'cover'` default / `'contain'`); the Artwork tab now frames posters/season posters 2:3, banners 16:3, fanart/thumbnails 16:9, and renders banners + logos + clearart with `object-contain` (whole image, no crop) via an `artworkFrame(type)` helper. |
| 2026-07-06 | **Media Server Analytics — newsletters split into per-content-type sections (Tautulli-style) + type scoping.** `newsletter-render.ts` replaced the fixed TV+Movies content model (`{shows, movies, episodeCount}`) with a generalized `{sections}` model: `buildContent()` iterates `NEWSLETTER_GROUPS` (tv/anime/episode → *TV Shows*, movie → *Movies*, music_video/music/concert → *Music & Concerts*, documentary → *Documentaries*, other_video/other → *Recently Added*) and emits **one section per content-type present**. Episodic groups collapse into show cards via `groupShows()` with an "N Shows / M Episodes" summary (never a flat per-episode list); the rest render as poster grids with an "N Movies"/"N Items" summary. Empty groups are omitted, order follows `NEWSLETTER_GROUPS`, and `renderHtml`/`renderText` loop the sections (per-type icon + amber count); `assemblePosters()` now walks `sections.flatMap(s => [...shows, ...movies])`. A newsletter can be **scoped to a subset of types** via `contentSections`: `mediaTypeFilter()` maps the selected group keys → `mediaType`s and constrains the `mediaItem` query (empty = all types), so a "TV Shows" newsletter contains only grouped shows, a "Movies" one only movies, etc. Frontend `NewslettersPage` gained a content-type toggle-chip selector on both the create form and each newsletter card (`newsletter.content.*`, en-US + es-PR); four render strings (`musicTitle`/`documentariesTitle`/`otherTitle`/`items`) added to both `newsletter-strings.ts` locales. `newsletter-render.spec.ts` reworked to the sections model + per-type coverage (18 specs); `MEDIA_SERVER_ANALYTICS.md` updated. |
| 2026-07-06 | **Media artwork — import show/season-level art from parent directories (TV).** `MediaArtworkService.importLocal` only scanned each media file's own directory, so a TV episode in `Show/Season 01/` never saw the show-level `poster.jpg`/`fanart.jpg`/`banner.jpg` that sit in the show root a level up — episodes ended up with just their per-episode `<episode>-thumb.jpg` screenshot, so the grouped TV browser showed no poster and the detail Artwork tab showed the episode still (the "unrecognized image"). `importLocal` now scans each file's directory **plus every ancestor up to the library root** (`artworkSearchDirs`, bounded so it never climbs past the library), and `classifySidecarArtwork` recognises `seasonNN-poster` as a `season_poster` with its season number. `MediaScannerService.importSidecars` now treats an item as "done" only when it has BOTH metadata AND a **poster** (not just any artwork), so thumbnail-only items get re-processed on the next scan and pick up the show poster. Test: TV episode importing show poster/fanart/banner + season poster from the show root while the episode thumbnail comes from the season dir. |
| 2026-07-06 | **Media Server Analytics — newsletter template rework (dark media digest).** Rebuilt `newsletter-render.ts` into an original, component-based dark email template (inspired by modern media-server digests; no third-party code/assets): a branded header (UT icon + `ULTRATORRENT NEWSLETTER` + server name + date range + amber divider), section headers with count summaries (amber numbers / gray labels), **poster-left TV show cards** (episodes grouped into shows via `groupShows()` — episode count, season/episode range, overview, metadata badges, **5-star rating**), a **movie poster grid**, and a **three-area footer** (unsubscribe · brand + tagline + instance URL · preferences). Amber accent `#f5a623`; 720px centered container with a mobile media query collapsing the two-column grids + footer to one column. `renderRating()` normalizes 0–10 ratings to 5 stars; all labels come from a new server-side `newsletter-strings.ts` (en-US + es-PR, parity-tested). Posters keep the CID-attachment pipeline (movies by id, shows by a representative episode) with a gradient-initial fallback; plain-text renderer updated. Preview inlines posters as data URIs, renders **sample content** when no new items exist, and the Newsletters page gained a **desktop/mobile preview toggle** + sample badge. Tests: grouping, rating normalization, badges, header/footer, escaping, sample, i18n parity (21 render specs). Security preserved (HTML-escaped, CID images, secrets redacted). Docs: `MEDIA_SERVER_ANALYTICS.md`. |
| 2026-07-06 | **Media artwork — cached poster thumbnails for fast grids.** Grid/card views fetched the **full-size** poster for every cell via a per-item authenticated blob fetch (posters run to several MB), so lists showed the stub placeholder while images slowly loaded. New `MediaArtworkService.thumbnail()` lazily generates a small WebP thumbnail (`THUMBNAIL_WIDTH` 400, via **sharp** — new dep) on first request, caches it under `.ultratorrent/media-artwork/thumbs/<artworkId>.webp` (a dot-dir the scanner ignores), regenerates when the source is newer, and falls back to the original if resizing fails (so a bad image still renders, never a stub). Served via `GET /media/artwork/:id/image?thumb=1`. Frontend `MediaPoster` gained a `size` prop defaulting to `'thumb'` (so every grid/card benefits with no page changes) with a `'full'` opt-out; `api.artworkImage(id, thumb)` appends the query. sharp installs as a prebuilt native binary and is copied into the runtime image like argon2. |
| 2026-07-06 | **Media artwork — fix posters reverting to the stub icon + provider fallback on scan.** Two causes of "everything shows a placeholder": **(1)** the frontend `api.media.artworkImage()` blob fetch (used by `MediaPoster` for every local poster) did a raw `fetch` that bypassed `request()`'s auth handling and never refreshed on 401 — so once the 15-minute access token expired, every local poster silently 401'd and fell back to the stub until a full page reload. It now refreshes + retries once, like every other call. **(2)** `MediaScannerService.importSidecars` now **always** imports local folder artwork (poster/fanart/folder/`<name>-poster` sidecars — Kodi/Jellyfin/tinyMediaManager), no longer gated behind the per-library artwork-fetch flag, and for items whose folder has **no** poster it falls back to `MediaArtworkService.importFromProvider` (new `needsProviderArtwork` guard). The provider fetch is self-limiting — `importFromProvider` no-ops without a configured TMDB key + a metadata external id, so an un-enriched scan issues no network calls; items still need a resolved TMDB id (from metadata enrichment) for provider art to actually download. (Local artwork was already served correctly — verified end-to-end; the stubs were the 401 bug + the ~2% of items with no art at all.) Thumbnail-cache for fast grid loading is a separate follow-up. |
| 2026-07-06 | **RSS — feed history filtering (status + title search + date range).** The feed-history view (`GET /rss/feeds/:id/history`, `RssService.history`) gained optional `status` (downloaded / matched-but-not-downloaded / seen — mutually exclusive buckets), a case-insensitive `search` on release title, and an inclusive `from`/`to` date range (date-only, UTC, whole-day `to`) on when the item was seen. The base filters (search + date range) scope **both** the paginated list and the summary count tiles; the status filter narrows only the list/pagination so the tiles keep the full breakdown and double as toggles. Response `counts` now includes `total` alongside the three buckets. Frontend `RssFeedHistoryPage`: clickable status tiles, a debounced search box, two date pickers, a clear-filters control, and a filtered-empty state (any filter change resets to page 1). New `rss-history-filter.spec.ts` covers status where-mapping, search+date scoping of list vs tiles, seen/total math, and open-ended/invalid date bounds. `RssHistoryQuery`/`counts` types updated; i18n en-US + es-PR. |
| 2026-07-06 | **Media Manager — grouped TV browser (Show → Season → Episode).** With TV episodes stored one MediaItem per episode (title = show name), a library of 24k episodes rendered 24k flat rows. Selecting a TV type on the Media Items page now shows a **collapsible Show → Season → Episode tree, paginated by show**. New `MediaItemService.series()` + `GET /media/series`: groups TV items (`mediaType in tv|anime|episode`) by title via Prisma `groupBy`, returns one paginated row per show (`{ title, year, episodeCount, seasonCount, lastAddedAt, poster }`) — season counts + a poster are fetched only for the page's shows. A show's episodes are lazy-loaded on expand via a new **exact `title` filter** on `list()` (`GET /media/items?title=…`), grouped into seasons client-side (Specials last); episodes link to the detail page. Frontend `SeriesGroupedList` (used by `MediaItemsPage` when the type filter is `tv`/`anime`; the flat query is disabled in that mode). On synoplex this collapses 23,956 TV items into **638 show rows** (~21 pages). i18n en-US/es-PR; tests cover series grouping (counts, poster fallback, TV-type/filter where-clause). |
| 2026-07-06 | **RSS — history match-test scans a larger window.** `testAgainstHistory` only evaluated the newest **200** feed-history rows, so on a busy feed a rule's real matches (a single episode yields ~6+ release variants) sat past row 200 and the test wrongly showed "no matches" — e.g. a MeGusta release at recency rank 253 of 985 EZTV rows was invisible. Bumped the scan to the newest **5000** rows (bounded worst case; the per-item evaluation is cheap string/regex work). Live polling is unaffected (it evaluates items as they arrive, not history). |
| 2026-07-06 | **Platform — paginate every growing result-page endpoint.** Established one convention (`apps/backend/src/common/pagination.ts`: `parsePage`/`pageOf`/`paginate` → `{ items, total, page, pageSize }`, page floored ≥1, pageSize capped 200) and a reusable frontend `<Pagination>` (`components/ui/pagination.tsx`) + `common.pagination.*` i18n (en-US/es-PR). Converted the unbounded/`take:N`-capped list endpoints to real pagination: `media-server-analytics/watch-history`, `users`, `media/duplicates` (was uncapped + deep nested include), `media-server-analytics/import-jobs`, `newsletters/:id/deliveries`, `meta/sync-runs`, `rss/rules/:id/match-history`, `automation/rules/:id/logs`, `media/history` (rename operations), and `notifications`. Each frontend consumer now pages with `keepPreviousData` (WatchHistory, Users, Duplicates, ImportAnalytics, RSS match-history panel, Automation logs dialog, Media renamer history); the Media-detail "related operations" widget requests a single large page to preserve its cross-page lookup. Small bounded config lists (libraries, engines, modules, roles, connections, feeds, newsletters) and aggregate report endpoints are intentionally left unpaginated. Reuses the pattern already shipped for audit, torrents, RSS feed-history and media items. Tests: pagination-helper spec (`parsePage`/`pageOf`/`paginate`). |
| 2026-07-06 | **RSS — history match-test returns matches only.** `testAgainstHistory` (rss.module.ts) evaluated the rule against the last 200 feed-history rows and returned **every** row with a matched/not-matched flag, so the Test tab listed a wall of non-matches. It now `.filter((r) => r.matched)`s the results — the test answers "what would this rule have grabbed", so non-matches are noise. `historyCount` still reports the full scanned total, preserving the empty-history fallback to manually-entered titles. |
| 2026-07-06 | **Media Manager — paginate the item browser (fixes multi-second Media Items loads).** `GET /media/items` fetched **every** matching item in one request — each with `files` + `metadata` + `externalIds` + poster `artwork` joined — then the page rendered them all (28k+ items on real libraries → tens of MB of JSON + 28k rich DOM rows + a poster component each). `MediaItemService.list()` is now paginated: `page`/`pageSize` (default 60, capped 200) with `skip`/`take` + a `count`, returning `{ items, total, page, pageSize }`, plus a case-insensitive `title` **search** filter. Controller parses `search`/`page`/`pageSize`; the row includes still narrow artwork to one poster. Frontend `MediaItemsPage` gains a debounced search box + prev/next pager (`keepPreviousData`, resets to page 1 on filter/search change); `MediaUnmatchedPage` (the other caller) paginated the same way — its "re-identify all" already uses the server-side bulk endpoint, so it needs no in-memory list. `api.listItems` now returns `MediaItemPage`. Measured on synoplex (28,480 items): the ordered id fetch alone dropped **38.7 ms → 0.23 ms** (~170×), with relations/payload/render now bounded to one page. i18n en-US + es-PR (`items.filter.search*`, `items.pagination.*`). New `media-item.service.spec.ts` covers paging math, pageSize cap, search, and shared count/find `where`. |
| 2026-07-06 | **Media Server Analytics — Tautulli-style newsletter overhaul + start-date selection.** The plain bulleted "added since" email became a rich, dark, poster-driven digest. `newsletter-render.ts` (still pure/unit-tested) rebuilt with a table/inline-style HTML template safe for email clients: gradient header (title + date-range subtitle + count badge), colour-accented sections, and per-title cards showing **poster artwork**, **★ rating / runtime / certification chips**, **genres**, and an **overview** — enriched from `MediaMetadata` + `MediaArtwork` in the service's `build()`. Posters are attached as **CID inline images** (`EmailAttachment` added to the email service; nodemailer `attachments`), so they render without public URLs; the in-app preview inlines them as data URIs. Item/poster counts are capped (60 items / 30 posters / 500 KB each) and artwork is best-effort (falls back to a gradient placeholder). **Start-date selection:** new `MediaServerNewsletter.startDate` column (migration `20260706040000_newsletter_start_date`) + `since_date` range mode; `since()` resolves `since_date` → fixed date, `since_last_send` → last send, `last_days` → rolling window (each falling back to `last_days`). Frontend `NewslettersPage`: a **Content window** selector (Since last send / Last N days / Since a date) with a date picker, on the create form and inline-editable per newsletter. i18n en-US + es-PR (`newsletter.window.*`). Tests: render (chips/poster-cid/escaping/empty), `since()` mode resolution, email-attachment plumbing. |
| 2026-07-06 | **Media Manager — identification edge cases: numeric-title/year collision + dot-folder scan skip.** Follow-ups to the unmatched-scan fix, from the six stragglers left on synoplex after the bulk re-identify (all movies). **(1) Numeric-title/year collision:** `parseTorrentName` (`torrent-name-parser.ts`) took the *first* 4-digit year match, so a movie titled with a year — `1917 (2019)`, `1992 (2024)` — parsed the leading number as the year and cut the title to empty (→ no title, `unmatched`). It now collects all year candidates and chooses deliberately: prefer a parenthesized `(YYYY)` release year, else the last candidate, and **never** treat a year at position 0 as the title boundary (a leading year is part of the title). `1917 (2019)` → title `1917`, year `2019`. **(2) Dot-folder scan skip:** `MediaScannerService.walk()` recursed into hidden/sidecar dirs, indexing phantom items — e.g. two files under tinyMediaManager's `.deletedByTMM` trash. New exported `isIgnoredScanDir()` skips dot-directories (`.deletedByTMM`, `.actors`, `.Trashes`) and Synology `@eaDir` thumbnail folders. Note: prevents *future* re-adds; pre-existing phantom `MediaItem` rows persist (scan has no prune step). Tests: parser collision cases + `media-scanner.service.spec.ts` (`isIgnoredScanDir`, `deriveFileTechInfo`). |
| 2026-07-06 | **Frontend navigation & app-shell re-engineering.** Reorganized the sidebar into logical, collapsible groups backed by a single declarative typed tree (`components/layout/navigation.ts`): `NavGroup`/`NavItem` gained nesting (`children`) and metadata (`id`, `to`/`action`, `permission`, `module`, `end`, `adminOnly`, `superAdminOnly`, `descriptionKey`). New IA: **Overview · Downloads · RSS & Acquisition · Media Management · Media Server Analytics · Automation · Files · Administration · Account** (every leaf maps to a real route; page-section sub-features documented in `docs/NAVIGATION.md`, no dead links). `visibleGroups(ctx)` now prunes by RBAC **and** module state with empty-parent/empty-group dropping, and shows disabled-module entries only to module managers (module state is never authorization — `ProtectedRoute`/`ModuleRoute` still enforce). New behaviors: collapsible top-level groups + collapsible sub-menus (both persisted in `localStorage`, auto-expanding the active branch), icon-rail tooltips, mobile drawer, nested/detail active-route highlighting, and tree-derived breadcrumbs (`Group › [Parent ›] Item [› Detail]`). New **command palette** (`CommandPalette.tsx`, Ctrl/Cmd+K + top-bar Search) searches only the already-filtered entries — RBAC/module-safe — with keyboard nav, empty state and full i18n. `nav` namespace rebuilt (`groups`/`items`/`descriptions`/`details`) with en-US + es-PR parity; new `shell.command.*` + `shell.nav.*` a11y strings. Tests: navigation tree filtering/pruning/active-match, breadcrumb trails, command-palette filtering, and i18n key-parity + nav-label coverage (46 frontend tests green). Docs: `docs/NAVIGATION.md` rewritten. |
| 2026-07-06 | **Media Manager — fix cleanly-organised TV libraries scanning as unmatched.** Auto-identification (`MediaIdentificationService`) parsed only the file's basename and scored `confidence` as the share of 8 equally-weighted fields — four of them scene artifacts (resolution/source/codec/group) — so a tidy personal episode (`The Office - S01E01.mkv`) resolved title+season+episode = 3/8 = 0.375 and fell below the 0.5 threshold; entire TV libraries scanned as `unmatched`. Two changes: **(1) folder-context parsing** — `parseFromPath()` recovers the series title from the first meaningful parent folder (skipping generic `Season N`/`Specials`/`Disc N` containers) and re-parses `<folder> <filename>` when the filename omits a title (`Show/Season 01/S01E01.mkv`), while season/episode still come from the file; **(2) identity-weighted confidence** — `scoreConfidence()` now gives 0.4 to a title and 0.4 to a primary identity signal (season+episode, absolute episode, air date, or movie year), with the scene tokens contributing only 0.05 each — so a title plus an episodic marker clears the threshold on its own and can never be gated by missing release junk. Full scene releases still score 1.0 (no regression). **Bulk recovery:** new `MediaIdentificationService.identifyBulk(filter)` + endpoint `POST /api/media/items/reidentify` (`media_manager.match`) re-runs auto-identification across a library (or all libraries), tracked as a `media_identification` job with WS progress and returning a `{ total, matched, unmatched, failed }` summary; per-item failures are isolated (counted, never abort the run) and `manual` matches are excluded by default so operator overrides survive — pass `matchStatus: 'unmatched'` to retry only failures. Frontend: the Unmatched page gains a **Re-identify all** button (scoped to unmatched items, reports matched/total via toast) and an `api.media.reidentifyItems()` client method; i18n en-US + es-PR. New `media-identification.service.spec.ts` covers folder-title recovery, generic-container skipping, clean filename, movie, scene-release regression, unidentifiable files, and the bulk pass (default non-manual scope, explicit filter, per-item failure isolation + progress). `docs/MEDIA_MANAGER.md` updated. |
| 2026-07-06 | **Media Server Analytics — explicit SMTP AUTH toggle.** The newsletter email settings gained a `Use authentication` switch (`EmailConfig.auth`). Previously AUTH was sent implicitly whenever a username was set, which breaks relays that reject AUTH (internal/localhost postfix, some corporate smart-hosts). `MediaServerEmailService.send()` now honors the flag — when off, no `auth` is passed to nodemailer regardless of a stored username; the form hides user/password when auth is off. Back-compat: configs with no explicit flag but a username still authenticate (`auth ?? Boolean(user)`). Unit tests cover on/off/back-compat; i18n (en-US + es-PR). |
| 2026-07-06 | **Media Server Analytics — real-time Live Activity redesign + now-playing artwork.** The Live Activity page no longer needs a manual reload: it subscribes to the poller's `media_server.session.started/ended` WebSocket events (added to the frontend `WsEventMap`) and refetches on push, plus an 8s interval; the backend session poll was lowered 30s→15s. **Artwork:** providers now surface a now-playing poster path (`ProviderSession.artPath` — Plex `grandparentThumb`/`thumb`; Jellyfin/Emby primary image), persisted on `MediaServerSession.artPath` (migration `20260706030000_session_art_path`). A new **auth-injected image proxy** `GET live/:id/artwork` (`MediaServerIntegrationService.fetchArtwork`) fetches the provider image with the connection's token/API-key server-side and streams it via `StreamableFile`, so credentials never reach the browser; the client passes only a session id (the path comes from trusted stored state, not user input). Frontend `LivePoster` bearer-fetches it as a blob with a media-type gradient fallback — verified end-to-end against real Plex. **UI:** summary KPI strip (streams/watchers/bandwidth/transcodes), a stream-mix proportion bar (reserved playback colors), and redesigned session cards — poster, colored playback-method pill, user-initial avatar, quality chips (resolution/codec/bitrate/container), and state-colored progress. Provider-parsing test extended; i18n (en-US + es-PR). |
| 2026-07-06 | **Fix — Tautulli analytics-import base URL scheme normalization.** The `TautulliAnalyticsImportProvider` built request URLs directly from the stored `baseUrl`, so a scheme-less address (e.g. `192.168.99.10:8181`, a natural way to enter a host) made Node `fetch` throw an opaque "Failed to parse URL" and the connection test failed before any I/O. New exported, unit-tested `normalizeBaseUrl` helper in `analytics-import-provider.ts` trims whitespace/trailing slashes and defaults the scheme to `http://` when absent (preserving an explicit `http`/`https`); `tautulliCmd` now routes through it. Regression tests cover scheme-less, explicit-scheme (case-insensitive), and trailing-slash/whitespace cases. |
| 2026-07-06 | **Media Server Analytics — normalization + sync overhaul (Phase 6e).** New normalized entities (migration `20260706010000_analytics_normalization`): `MediaServerLibrary` (synced per connection), `MediaServerUser` (distinct viewers), and `MediaProviderSyncRun` (run tracking); plus stream-detail columns (`container`, `bitrateKbps` on sessions; `audioCodec`, `container`, `bitrateKbps` on watch history). New `MediaServerSyncService`: pulls libraries from each connection's provider (capability-aware, reusing the integration layer's decryption; upsert + prune of vanished libraries) and derives users from durable watch history (provider-agnostic — works for Tautulli imports too), every run recorded in `MediaProviderSyncRun`, broadcasting `media_server.sync.completed`; runs hourly (`@Interval media_server_metadata_sync`) and on demand. Providers now parse `container` + overall `bitrateKbps` from Plex (`Media.bitrate` kbps) and Jellyfin/Emby (`MediaStreams.BitRate` bps→kbps); the session poller persists them onto sessions and completed history. `ReportFilter` gained **`connectionId` / `libraryName` / `userName`** dimensions (threaded through the shared `where`), unlocking the dashboard's server/library/user filters; new `bandwidth()` aggregation (avg kbps per day over plays that reported a bitrate). New endpoints: `reports/bandwidth`, `meta/libraries`, `meta/users`, `meta/sync-runs` (read), and `POST meta/sync` (MANAGE_CONNECTIONS). Frontend: filter bar gains Server/Library/User selectors (server-scoped library list, de-duped, persisted), a bandwidth-over-time area chart, and a **Sync** button on the provider-status panel. Tests: sync-service (library upsert/prune, partial run, user derivation, syncAll) + report filter-dimension + bandwidth specs (29 total in the module). i18n (en-US + es-PR). Completes the analytics overhaul (Phases 6a–6e). |
| 2026-07-06 | **Media Server Analytics — advanced visualizations + export (Phase 6d).** Five new report aggregations on `MediaServerReportService`, all honoring the shared `ReportFilter` (days/mediaType): `heatmap()` (play counts by day-of-week × hour, server-local, with peak for a single-hue sequential ramp), `trends()` (per-day playback-method breakdown — direct-play vs transcode load over time, spellings normalized to four buckets), `resolutions()` (quality distribution merged into canonical labels 4K/1080p/720p/480p/SD/Unknown, ordered high→low), `libraryGrowth()` (cumulative Media-Manager item count by month, baseline-correct under a date window), and `exportWatchHistoryCsv()` (RFC-4180 CSV, ≤50k rows). To make the quality chart **real data**, `MediaServerWatchHistory` gained `resolution` + `videoCodec` columns (migration `20260705200000_watch_history_stream_quality`), populated from the live session on close. New endpoints `reports/heatmap|trends|resolutions|library-growth` (VIEW_REPORTS) and `export/watch-history` (text/csv + Content-Disposition) gated by a new **`media_server_analytics.export`** permission (shared + manifest). Frontend: `ActivityHeatmap` (day×hour grid, dataviz single-hue sequential `heatColor`), `ProviderStatusPanel` (per-server health/version/platform/last-check from the dashboard connection summaries), a streaming-trend stacked area (reserved playback colors + legend), a resolution bar, and a cumulative library-growth area — all wired into the filter state + auto-refresh; an **Export CSV** button on the filter bar downloads the current filter. Tests: heatmap/trends/resolutions/library-growth/CSV specs (13 total). i18n (en-US + es-PR). Remaining overhaul phase: 6e (normalized-analytics DB + sync overhaul → unlocks server/library/user filters + bandwidth/stream-detail trends). |
| 2026-07-05 | **Media Server Analytics — artwork + filters (Phases 6b & 6c).** *Artwork (6b):* the Media Manager library is now the poster source for analytics — `MediaServerReportService.recentlyAdded()` includes the selected `poster` artwork inline (a lean `MediaArtworkRef` subset), and a new **Recently Added** strip (`RecentlyAddedStrip.tsx`) renders it via the reusable `MediaPoster` (remote CDN `url` or bearer-fetched local blob, lazy-loaded, with loading skeletons and a graceful icon fallback) so missing/broken artwork never blocks the dashboard; each card carries a media-type color dot. *Filters (6c):* a persistent filter bar (`MediaAnalyticsFilterBar.tsx` + `useAnalyticsFilters` hook, localStorage-backed) exposes date range (Today/7/30/90d/Year/All), media type (all/movie/TV/music/other), auto-refresh interval (off/15s/30s/1m/5m), and a manual refresh button. Filters are wired **end-to-end**: `ReportFilter` (`days`/`mediaType`) threads a shared `where` clause through every watch-history aggregation (`usage`/`users`/`libraries`/`playback`/`topMedia`/`devices`), exposed via optional `?days=&mediaType=` query params on the report endpoints; the frontend `api` report methods take a `MediaAnalyticsFilter`, keyed into react-query cache and driving refetch intervals. Tests: report-service filter (days/mediaType) + recently-added artwork-fallback specs. i18n (en-US + es-PR). |
| 2026-07-05 | **Media Server Analytics — premium dashboard overhaul (Phase 6a).** Reworked the analytics dashboard from a basic stat view into a polished, graph-rich experience. New centralized, **dataviz-validated** color system (`analytics-colors.ts`): reserved status hues for playback methods (Direct Play green / Direct Stream blue / Transcode orange / Unknown gray, always shipped with a label), categorical media-type hues, and a validated categorical series palette (CVD-checked; `foldTopN` caps to 8 + gray "Other", never cycled). Reusable `KpiTile` + `ChartCard` (built-in loading/empty). Backend: `dashboard()` now returns real KPIs (active streams, total plays, watch time, unique users, media items, added-7d, direct-play % / transcode %, active newsletters); new `reports/top-media` + `reports/devices` aggregations. Frontend dashboard: hero header with live server status, an 8-tile KPI grid, a real-time **Now Playing** panel (15s refresh, color-coded stream-type dots + progress), and Recharts graphs — plays-over-time area, playback-method donut (semantic colors + legend), top-users horizontal bar, device bar, and a most-watched list — all dark-theme-styled with recessive grid, 2px marks, and empty/loading/error states. i18n (en-US + es-PR). Later overhaul phases: artwork system + dominant colors, heatmaps + bandwidth/transcode trends, date-range/server/library/user filters, CSV export, provider-status panel, and normalized-analytics DB. |
| 2026-07-05 | **Media Server Analytics — scheduled newsletters (Phase 5).** A net-new email/newsletter subsystem (no email infra existed before). `MediaServerEmailService` sends via **nodemailer** (new dependency); SMTP config lives in the `Setting` store (`media_server_analytics.email`) with the password AES-256-GCM encrypted (`SecretCipher`) and redacted to `hasPassword`. Pure `newsletter-render.ts` builds "added-since" content from the Media Manager library (movies / TV episodes / other sections) and renders a responsive HTML email + plain-text alternative, HTML-escaping all titles. `MediaServerNewsletterService` does newsletter CRUD, preview (no send), test-send, `sendNow` (per-recipient delivery with `MediaServerNewsletterDelivery` tracking + WS `media_server.newsletter.generated/sent/failed`), and a 15-min `@Interval` dispatcher (`media_server_newsletter_dispatch`) that sends due scheduled newsletters (daily/weekly/monthly, computing `nextRunAt`). New models `MediaServerNewsletter` + `MediaServerNewsletterDelivery` (migration). Endpoints: newsletters CRUD + `/preview` `/test-send` `/send-now` `/deliveries`, and `settings/email` GET/PATCH + `/test`. Frontend: a **Newsletters** page (SMTP settings + test, campaign create/list, preview in an iframe, test/send, per-newsletter recipients), nav entry, route, i18n. `nodemailer` added. |
| 2026-07-05 | **Media Server Analytics — Tautulli analytics import (Phase 4).** A new `MediaAnalyticsImportProvider` abstraction (distinct from `MediaServerProvider`) with `TautulliAnalyticsImportProvider` (test via `arnold`, `getImportSourceInfo`, `getUsers`, paged `getWatchHistory`; pure `normalizeTautulliHistory`). `AnalyticsImportService` manages import sources (API key **encrypted at rest** via `SecretCipher`, redacted to `hasApiKey`), tests, previews, and runs a detached background `MediaAnalyticsImportJob` that streams Tautulli `get_history` in pages of 500 into `MediaServerWatchHistory` with `createMany({ skipDuplicates })` keyed on a new unique `(importSourceId, providerHistoryId)` — so duplicates never inflate stats and re-runs are safe — reporting progress on the job + over `media_server.import.started/progress/completed/failed`. Imported history immediately feeds the Phase-3 reports. New models `MediaAnalyticsImportSource` + `MediaAnalyticsImportJob` and a `providerHistoryId` column + unique index on `MediaServerWatchHistory` (migration `20260705183000_analytics_import`). Endpoints: import-source CRUD + `/test` `/preview` `/import`, `import-jobs` list/get. Frontend: an **Import Analytics** page (add source, test, preview counts, run import, live job progress), nav entry, route, i18n. `docs/TAUTULLI_IMPORT.md`. |
| 2026-07-05 | **Media Server Analytics — analytics & reports (Phase 3).** New `MediaServerReportService` computes reports on demand from the captured `MediaServerWatchHistory` (Prisma `groupBy`/`aggregate`): `usage` (total plays, watch seconds, unique users, per-day plays), `users` (per-user plays/watch-time/last-seen), `libraries` (per-library), and `playback` (playback-method + media-type distributions); `recentlyAdded` sources the newest `MediaItem`s from the Media Manager library (the primary source of truth). Endpoints `GET /api/media-server-analytics/reports/{usage,users,libraries,playback}`, `GET /users`, `GET /recently-added`. Frontend: an **Analytics Reports** page (tabbed Usage/Users/Libraries/Playback with widgets, tables, and distribution bars) and a **Recently Added** page, nav entries, routes, i18n (en-US + es-PR). No schema change (computed from existing tables). |
| 2026-07-05 | **Media Server Analytics — live activity & watch history (Phase 2).** The `MediaServerProvider` gained `getSessions` (Plex `/status/sessions`, Jellyfin/Emby `/Sessions` normalized to a common `ProviderSession`; Kodi throws `UnsupportedCapabilityError`), surfaced via `MediaServerIntegrationService.sessions(id)`. New `MediaServerSessionService` runs a 30s `@Interval` poller (`media_server_session_poll`, guarded by module-enabled + re-entrancy) that reconciles now-playing sessions into `MediaServerSession` rows and, when a session disappears, writes a `MediaServerWatchHistory` row (with `watchedSeconds`) — emitting `media_server.session.started/updated/ended`. New models `MediaServerSession` + `MediaServerWatchHistory` (migration `20260705180…_media_server_sessions`). Endpoints `GET /api/media-server-analytics/live`, `POST …/live/poll`, `GET …/watch-history`. Frontend: Live Activity page (auto-refreshing session cards with progress) + Watch History page (table), nav entries, routes, i18n (en-US + es-PR). |
| 2026-07-05 | **Media Server Analytics module — foundation (Phase 1).** New core module `media_server_analytics` (route `/api/media-server-analytics`, RBAC `media_server_analytics.*`), built by **extending Media Manager's existing media-server integration** rather than a parallel system. The existing `MediaServerProvider` (Plex/Jellyfin/Emby/Kodi, previously just `testConnection`/`refreshLibrary`) gained a **capability model** + `getServerInfo` + `getLibraries`; a provider that can't serve a capability (e.g. Kodi library listing) throws a typed `UnsupportedCapabilityError` surfaced as `{ supported: false }`. `MediaServerIntegrationService` gained `healthCheck(id)` (probe + persist status/version/platform/capabilities) and `libraries(id)`. The `MediaServerIntegration` model was extended with `isDefault`/`status`/`serverVersion`/`platform`/`capabilities`/`lastHealthCheckAt`/`notes` (additive migration `20260705174057_media_server_analytics`). New module wires a `MediaServerAnalyticsService` + controller (dashboard + connection CRUD/test/sync/libraries, reusing the integration store + `SecretCipher` encryption/redaction). 13 new permissions, manifest entry (menu, routes, 17 `media_server.*` websocket events), realtime gateway scoping for `media_server.*`. Frontend: Dashboard + Server Connections pages, nav entries, `mediaServerAnalytics` i18n namespace (en-US + es-PR). `docs/MEDIA_SERVER_ANALYTICS.md`. Later phases: live activity, watch history, analytics, newsletters (net-new SMTP), Tautulli import. |
| 2026-07-05 | **Smart Download — documentation (Phase 6).** New `docs/SMART_DOWNLOAD.md` documents the whole engine (decision pipeline, decisions, acquisition profiles + wait policy, multi-dimensional upgrade intelligence, waiting/upgrade queues, missing-media detection, execution, decision simulator, dashboard, API, data model, and what's not-yet-done). `docs/API.md` gained the new endpoints (`simulate`, `waiting`/`upgrades`/`rejected`, `missing-movies*`, `missing-episodes/:id/seasons`) and its "never performs file operations" note was corrected — Smart Download now executes decisions. Cross-links added from `MEDIA_ACQUISITION_INTELLIGENCE.md`, `MEDIA_MANAGER.md`, and `README.md`. Docs only. |
| 2026-07-05 | **Smart Download — dashboard + queue views (Phase 5a).** Surfaces the Phase 1–4 engine in the UI. `MediaAcquisitionService.overview()` extended with the full metric set (approved / pending-approval / rejected counts, `waiting` and `upgrade`/`replace` decision counts, and `missing.episodes`/`missing.movies` from the wanted tables); new `GET /api/media-acquisition/rejected` (rejected or skipped evaluations) alongside the existing `waiting`/`upgrades`. Frontend: a new **Smart Download** dashboard page — a widget grid (Approved, Pending approval, Waiting, Pending upgrades, Rejected, Missing episodes/movies, Watchlist), a Recent-decisions list, and Waiting/Upgrades/Rejected queue tabs — with `api.mediaAcquisition.{waiting,upgrades,rejected}`, route + nav entry (`media_acquisition_intelligence`), en-US + es-PR copy. No schema change. Remaining in Phase 5: automation workflow triggers + user notifications on decision events. |
| 2026-07-05 | **Smart Download — Decision Simulator + visual pipeline (Phase 4).** The evaluator's signal-gathering was extracted into a side-effect-free `gather()` shared by `evaluate()` (persists + executes) and a new `simulate()` (explains only). `AcquisitionEvaluatorService.simulate()` runs the full pipeline for a release and returns the decision plus a clickable, stage-by-stage breakdown (`identify → matching → scoring → library → upgrade → decision`, each with status + summary + a `detail` payload) and the raw decision trace — **without** persisting an evaluation, recording an action, or downloading. New `POST /api/media-acquisition/simulate` (view-gated — read-only). Frontend: a `Decision Simulator` page (release-name input → decision banner + a clickable visual pipeline where each stage expands its detail), `api.mediaAcquisition.simulate`, route + nav entry (`media_acquisition_intelligence`), en-US + es-PR copy. No schema change. |
| 2026-07-05 | **Smart Download — waiting/upgrade queues + multi-dimensional upgrade comparison (Phase 3).** Upgrade decisions are now genuinely quality-aware. New pure `quality-compare.ts` (`scoreQuality`/`compareQuality`) ranks a candidate against the owned release across resolution, source (Remux>BluRay>WEB-DL>WEBRip>HDTV), HDR (Dolby Vision>HDR10+>HDR10>HLG>SDR), audio (Atmos/DTS:X>lossless>lossy) and channels, with a codec efficiency tiebreak that never *alone* triggers an upgrade (x264→x265 at the same quality is not a re-download). It replaces the evaluator's resolution-only `newIsBetter` — `libraryState` now compares the candidate title against the owned `TorrentSnapshot` name and surfaces the winning dimensions in the decision reason. New `wait` decision: a `waitForBetter`/`waitUntilScore` acquisition-profile policy (read from `qualityRules`) holds an acceptable-but-mediocre fresh release (score ≥ minimum but < the wait cutoff) instead of grabbing it, recording the evaluation with `approvalStatus: waiting` and emitting `media_acquisition.waiting`. Two queue views: `GET /api/media-acquisition/waiting` (held releases) and `GET /api/media-acquisition/upgrades` (upgrade/replace decisions annotated with `upgradeStatus` pending/completed from their actions). No schema change. |
| 2026-07-05 | **Smart Download — missing movie & season detection (Phase 2).** Extends missing-media detection beyond episodes. New `MissingMoviesService` scans `movie` watchlist items that carry an IMDb id: it resolves the movie's title/year from the local `imdb_titles` catalogue (falling back to the watchlist item), decides ownership via the structured IMDb external-id link (`MediaExternalId` provider `imdb` → a `movie` `MediaItem`) with a case-insensitive title+year fallback, and upserts a `WantedMovie` row classified `owned`/`missing`/`unaired` (future/unknown year) / `ignored` (user opt-out survives rescans). Missing-season detection is a `WantedEpisode` rollup — `MissingEpisodesService.listSeasons()` groups the episode rows per season and marks a season `complete` when it has no missing episodes (no extra storage). New `WantedMovie` model + migration `20260705164721_wanted_movies` (additive); watchlist delete now also cascades `WantedMovie`. Endpoints `GET /api/media-acquisition/missing-movies`, `POST …/missing-movies/scan` (`{watchlistItemId?}` → one or all), `POST …/missing-movies/:id/ignore|unignore`, and `GET …/missing-episodes/:watchlistItemId/seasons`; WS `media_acquisition.missing_movies.scan.completed`. Detection surfaces candidates; the watchlist item itself still feeds the evaluator's `needed` logic. Backend-only (UI lands with the Phase 5 dashboard). |
| 2026-07-05 | **Smart Download — execution engine (Phase 1).** First phase of evolving Media Acquisition into "Smart Download": decisions now actually acquire. Previously `AcquisitionEvaluatorService.evaluate()` produced an explainable decision and recorded a `download_torrent` action with `status: pending` that *nothing ever executed*. New `SmartDownloadExecutorService` closes that gap — it turns a pending action into a real acquisition via the engine (`EngineRegistryService.getDefault()` → `addMagnet`/`addTorrentURL`), and on an `upgrade_existing`/`replace_existing` decision removes the superseded torrent + data (`removeTorrentAndData`); it is idempotent per action (a non-pending action is a no-op). The evaluator now records the action for every download-intent decision (`download`/`upgrade_existing`/`replace_existing`/`hold_for_approval`) carrying the full payload (`downloadUrl`, `savePath`, `supersedeHash` — the owned torrent's hash captured from `TorrentSnapshot` for upgrades) and **executes inline** when no approval is required and a `downloadUrl` is present. `AcquisitionApprovalService.approve()`/`override()` now *execute* the held action through the executor instead of re-recording a dead pending one. `EvaluateReleaseDto`/`EvaluateInput` gained `downloadUrl`/`savePath`, so `POST /api/media-acquisition/evaluate` is a real acquisition entry point. New WS events `media_acquisition.download.started`/`.download.failed`/`.upgrade.completed`; execution audited (`media_acquisition.download.executed`/`.upgrade.executed`/`.download.failed`) + history. No schema change (the `MediaAcquisitionAction` model already had `status`/`payload`/`result`/`completedAt`/`errorMessage`). Later phases: missing movie/season detection, waiting/upgrade queues, richer upgrade comparison, decision simulator, dashboard pages. |
| 2026-07-05 | **Missing Episodes — Sonarr-style gap detection (Media Acquisition).** A monitored series (a `series`/`season` watchlist item carrying an IMDb id in `externalIds`) can now be diffed against the local IMDb episode catalogue to find episodes the library lacks. New `MissingEpisodesService.scanSeries/scanAll` enumerates `imdb_episodes` by `parentTitleId` (joined to `imdb_titles` for episode title + air year), computes the owned set from `MediaItem` (primary: new structured `MediaItem.seriesImdbId` link populated at identify time; fallback: case-insensitive title match), and upserts one `WantedEpisode` row per catalogue episode classified `owned`/`missing`/`unaired`/`ignored` (season 0 specials excluded; user `ignored` overrides survive rescans). Endpoints `GET /api/media-acquisition/missing-episodes[/:watchlistItemId]`, `POST …/scan`, `POST …/:id/ignore|unignore` (view = `media_acquisition.view`, mutate = `media_acquisition.manage_watchlist`). New `WantedEpisode` model + `MediaItem.seriesImdbId` column/index (migration `20260705144118_missing_episodes`, additive). Watchlist delete now cascades its `WantedEpisode` rows. Realtime gateway scoped `media_acquisition.*` events to `perm:media_acquisition.view` (they previously leaked to every authenticated socket). Frontend: a `Missing Episodes` page (per-series progress + season/episode grid with ignore/unignore), an IMDb-ID field on the watchlist dialog, `api.mediaAcquisition.missingEpisodes*`, en-US + es-PR copy. Detect-only — no auto-acquisition or active search yet; `docs/MISSING_EPISODES.md`. |
| 2026-07-05 | **Dashboard "Recent activity" now renders audit entries.** `GET /api/dashboard/activity` (`DashboardService.recentActivity`) previously returned raw `AuditLog` rows (`action`/`createdAt`/`result`), but the frontend `ActivityItem` expects `message`/`at`/`level`/`type` — so the card showed either the empty state (no rows) or blank rows (rows present). The service now maps each row via a `toActivityItem` humanizer: bare verbs get their `objectType` prefixed (`added` + `torrent` → "Torrent added"), namespaced actions are de-dotted with acronym fixups (`media.imdb.dataset.import.completed` → "Media IMDb dataset import completed"), an optional `metadata` name/title/path and the actor username are appended, `level` derives from `result`/action keywords (failure→error, completed/created/added/import→success, else info), and `at` is the ISO `createdAt`. Backend-only, no schema change. |
| 2026-07-05 | **Optimized IMDb import can include TV series & episodes (toggle).** A new `importTvShows` IMDb setting (default off — movies stay the default) widens the optimized import: when on, `optimizedTitleSkipReason(row, minYear, includeTv)` also accepts `tvSeries`/`tvMiniSeries`/`tvEpisode`, and the plan adds `title.episode` (imported referentially on the episode's own tconst so only imported episodes are kept). `title.principals` is now the only *always-skipped* dataset (`ALWAYS_SKIPPED_DATASETS`); `title.episode` moves out of the skip set when TV is on. The referential importer was generalized with an `idOf` extractor (ratings/akas/crew key on `titleId`, episodes on `episodeTitleId`). Wired through `ImdbSettings`/patch/defaults, `api.ts`, and the admin panel (an "Import TV series & episodes" toggle, with the selected/skipped-datasets chips + warning now reflecting it). `docs/IMDB_IMPORT.md` updated; en-US + es-PR copy. Note: episodes with a null/pre-minimum-year `startYear` are still filtered out (lower the minimum year for older episodes). |
| 2026-07-05 | **rtorrent Compose service re-adds SETUID/SETGID capabilities.** `docker-compose.yml` now sets `cap_add: ["SETUID", "SETGID"]` on the `rtorrent` service. Both capabilities are in Docker's default set, but some hosts (Synology DSM) strip them, which breaks the entrypoint's `gosu` privilege drop to `PUID:PGID` and leaves rtorrent running as root (files then root-owned, unreadable to the backend's `node` user on the shared `downloads` volume). Re-adding them restores the default so the root→chown→drop-to-PUID flow works. Runtime-only flag — `docker compose up -d rtorrent`, no rebuild. Complements the entrypoint's graceful fallback. |
| 2026-07-05 | **Bundled rtorrent entrypoint no longer crash-loops when it can't drop privileges.** `deploy/rtorrent/entrypoint.sh` used to unconditionally `exec gosu "$PUID:$PGID" rtorrent`, which dies with `failed switching to "…": operation not permitted` on hosts (notably Synology DSM) that start the container non-root or strip `CAP_SETUID`/`CAP_SETGID`. It now branches: started non-root → run rtorrent as the current user (skip the switch, with a note if PUID differs); root with a working privilege drop (pre-checked via `gosu … true`) → the normal drop to `PUID:PGID`; root but caps stripped → warn and run as root instead of looping. Early `mkdir`/`rm` on the session dir are best-effort so a non-root start on a root-owned volume doesn't abort under `set -e`. For Synology where the drop is blocked, the recommended config is `user: "<uid>:<gid>"` on the rtorrent service (now works because the entrypoint skips gosu when non-root) plus a `/downloads` writable by that uid. |
| 2026-07-05 | **IMDb "Danger zone" — wipe all imported data.** The IMDb Settings page gained a destructive Danger Zone card with a "Wipe IMDb data" button (confirm-gated, shows the current title count) for when the wrong dataset was imported. It calls the existing `POST /api/media/providers/imdb/dataset/reset` with `reimport:false` (`ImdbService.resetData` → TRUNCATE of every `imdb_*` table, refused while an import runs, audited `media.imdb.dataset.reset`) — i.e. wipe-only, distinct from the optimized panel's "Reset & reimport". `danger.*` copy (en-US + es-PR); gated on `media_manager.imdb.import_dataset`. |
| 2026-07-05 | **Optimized IMDb movie import (default strategy).** The IMDb importer no longer blindly imports every dataset. A new `imdb_import_strategy` setting (`optimized_movies` default, `full` = legacy) drives `ImdbDatasetImporterService.runImport`, which delegates the default to the new `ImdbOptimizedImportService`. The optimized strategy imports `title.basics` filtered to movie-like (`movie`/`tvMovie`/`video`), non-adult titles from a configurable minimum year (default 1970, env `IMDB_MIN_YEAR`), then `title.ratings` and (toggleable) `title.akas`/`title.crew`/`name.basics` **only for imported titles** (referential integrity via batched existence checks); it NEVER imports `title.principals` (~90M rows) or `title.episode`. Streaming (shared `imdb-stream.ts` generator, never loads a file whole), batched (`IMDB_IMPORT_BATCH_SIZE`, default 5000), idempotent (natural-key dedup — new `imdb_akas (titleId, ordering)` unique key), resumable, with full `ImportStats` (rows scanned/imported + each skip bucket + errors + duration) persisted on `imdb_dataset_imports.stats`/`strategy` and clear per-dataset/skip logging. New indexes on `imdb_titles (titleType, startYear)`, `isAdult`, GIN `genres`, and `imdb_akas.title` back year/genre filtering + AKA release-name matching. `ImdbMetadataProvider.searchTitle` ranks primary/original/AKA title + exact-year confidence → vote count → rating (adult excluded). New settings (`minImportYear`, `importAkas`/`importCrew`/`importPeople`), `POST /api/media/providers/imdb/dataset/reset` (wipe + optional reimport), an "Import strategy" admin panel (strategy, datasets, principals-skipped warning, latest stats, run/validate/reset), and `docs/IMDB_IMPORT.md`. Migrations `20260705120000_imdb_optimized_import` + `20260705120001_imdb_aka_unique_ordering` (both additive/backward-compatible). |
| 2026-07-05 | **Stop button for a running IMDb dataset import.** A dataset import runs as a detached in-process worker; it can now be cancelled cooperatively. New `POST /api/media/providers/imdb/dataset/import/stop` (`ImdbService.stopImport` → `ImdbDatasetImporterService.stopImport`, perm `media_manager.imdb.import_dataset`) flags the active `pending`/`running` run in an in-memory `cancelRequested` set (404 if none is running) and emits a `stopping` progress nudge. Both import strategies poll the flag at batch boundaries and between dataset files and unwind via a shared `ImportCancelledError` (`imdb-cancel.ts`): the legacy `full` importer checks it in `runImport`/`importFile`; the default `optimized_movies` importer (`ImdbOptimizedImportService`) receives a `shouldCancel` predicate and checks it after each batch flush and between plan steps. On stop the row is set to a new terminal `cancelled` status (records already committed are kept — the import is resumable) and an `imdb.dataset.import.cancelled` WS event is broadcast. Frontend: a red Stop button on the IMDb Settings dataset panel (shown only while an import — not the download phase — is active), `api.media.stopImdbImport()`, a `cancelled`-aware terminal-state helper + badge variant, the new WS handler, and `dataset.stop*` copy (en-US + es-PR). |
| 2026-07-05 | **"Test TMDB key" button in Media Settings.** The Metadata Providers settings card gained a Test button beside Save that validates the TMDB API key against the live service before (or without) saving. `TmdbMetadataProvider.verify()` makes one lightweight `GET /3/authentication` call and distinguishes a valid key (200), a rejected key (401), an unexpected status, and an unreachable/timed-out service. `MediaService.testTmdbKey(apiKey?, ctx)` tests the supplied (possibly unsaved) value when given, else the saved `media.tmdbApiKey` / `TMDB_API_KEY` env, never echoes the key, and audits `media.tmdb.key_tested`. New route `POST /api/media/providers/tmdb/test` (`settings.manage`, matching who can edit the key). Frontend: `api.media.testTmdbKey`, a Test button (disabled while saving) that toasts the pass/fail result, `settings.metadata.testKey`/`testOkTitle`/`testFailTitle` copy (en-US + es-PR). |
| 2026-07-05 | **RSS preference list becomes a per-title acquisition policy (grab-best, upgrade + replace).** A ranked preference list previously only broke ties *within a single feed item*, so separate releases of the same movie/episode (e.g. the BluRay and the WEBRip, arriving as distinct items) each downloaded — the ranking never chose between them. Now `RssService.grabWithDedup` (shared by `processFeed` and `backfillHistory`) tracks what each rule holds per logical release in a new `RssAcquisition` table (`@@unique([rssRuleId, identity])`, migration `20260705035121_rss_acquisitions`), keyed by `releaseIdentity(title)` → `movie:<title>:<year>` / `ep:<title>:<season>:<episode>` / `anime:…` / `daily:…` (parsed via `parseTorrentName`; unparseable titles fall back to per-release behavior). A rule now grabs the best-available release for an identity once; a **strictly higher-priority** candidate that arrives later is an *upgrade* — it downloads and the superseded torrent **and its data** are removed via `TorrentEngineProvider.removeTorrentAndData` (`removeSupersededTorrent`, best-effort); an **equal-or-lower** candidate for an already-held identity is skipped as `skipped_duplicate`. Applies only to rules with a match-candidate preference list; legacy include/exclude rules and unidentifiable titles keep prior behavior (info-hash dedup still applies). |
| 2026-07-05 | **Per-feed RSS rule export.** Alongside the global Import/Export of the whole rule set, each feed row now has an Export button that downloads a bundle scoped to just that feed's rules. `RssService.exportRules(feedId?)` gained an optional feed filter (validates the feed exists → 404 otherwise, filters `rssRule.findMany` by `feedId`); new route `GET /api/rss/feeds/:id/rules-export` (`rss.view`). The bundle shape is identical to the full export, so it re-imports through the existing `POST /rss/rules-import` (all modes) unchanged. Frontend: `api.rss.exportFeedRules(feedId)`, a shared `saveBundle` download helper, a `slugify`'d per-feed filename (`ultratorrent-rss-<feed>.json`), and a Download icon-button per feed (disabled while any feed export is in flight or the feed has no rules) with `feeds.exportFeed` copy (en-US + es-PR). |
| 2026-07-05 | **RSS auto-download deduped by torrent info-hash, not just feed guid.** `RssService.processFeed` and `backfillHistory` now extract the BitTorrent info-hash (btih) from each item's magnet (`extractInfoHash`) and skip the grab when that hash was already downloaded — checked both in-run (a per-pass `Set`) and persisted (`hashAlreadyDownloaded` → `rss_history.downloaded=true`). Previously dedup was solely the `rss_history` `(feedId, itemGuid)` uniqueness, so the same release re-appearing under a rotated guid/link, a re-post, or a second feed downloaded again (observed: a movie grabbed twice). New nullable `RssHistory.infoHash` column (indexed, migration `20260705032819_rss_history_info_hash`) stores the key; poll writes it on create, backfill backfills it onto matched legacy rows. Deduped grabs record `actionTaken: 'skipped_duplicate'`. Note: this is content identity — distinct quality variants (different info-hashes) still each download; collapsing those remains a filter-level concern (add a resolution rule). |
| 2026-07-05 | **Create-folder failures report an actionable error instead of a raw 500.** `FilePathService.ensureDirectory` now catches `mkdir` failures and translates the errno into a clean HTTP error (`translateMkdirError`): EACCES/EPERM → 403 "Permission denied creating …; check ownership or point FILE_MANAGER_ROOTS at a writable dir", EROFS → read-only filesystem, ENOSPC → disk full, ENOTDIR → a parent segment is a file, ENAMETOOLONG → path too long, else a logged 400 carrying the underlying message. Previously the raw fs error escaped as an opaque 500 "Internal server error" — hit when the storage root is the default `/downloads` (`FILE_MANAGER_ROOTS` unset) and the non-root server user can't create it, so the frontend "create this folder?" confirmation failed with no explanation. The translated message flows through to the `useEnsureDirectory()` toast. |
| 2026-07-04 | **Library scans import existing sidecar artwork + NFO metadata.** After reconciling video files, `MediaScannerService.scanLibrary` now imports metadata and artwork that already sit next to the media. `MediaArtworkService.importLocal(itemId)` detects Kodi/Jellyfin sidecar images (`poster.jpg`/`folder.jpg`/`fanart.jpg`/`banner`/`logo`/`clearart`/`landscape`/`thumb` and `<video-name>-poster.jpg`-style suffixes), referencing them in place (`source: 'local'`, `localPath` = the on-disk file, one auto-selected per type) exactly like subtitle sidecars — no copy. `MediaMetadataService.importLocalNfo(itemId)` parses an adjacent `<basename>.nfo` / `movie.nfo` / `tvshow.nfo` (title, overview, year, runtime, rating, genres, studios, certification, original title, directors, writers, cast) and external ids (`<imdbid>`/`<tmdbid>`/`<tvdbid>` or Kodi `<uniqueid>`), filling metadata gaps without clobbering provider values and recording a `MediaNfoFile`. `parseNfoXml` was extended for cast/crew/ids. The scanner runs both per item at the end of a scan, skips already-enriched items (has metadata + artwork) so re-scans stay cheap, is idempotent, and reports `artworkImported`/`metadataImported` in `ScanSummary` + the scan toast. Artwork import honours `library.artworkEnabled`. |
| 2026-07-04 | **No overlapping IMDb dataset imports.** `ImdbDatasetImporterService.startImport` is now the single choke point that refuses to spawn a second worker while one is pending/running (returns the in-flight import), covering Import-now, Update-now, and the scheduler. `ImdbService` additionally guards the download+import combo with an in-flight flag + DB active-import check, and on startup marks any import left `running` (orphaned by a restart, since the worker is in-process) as `failed` so it can't wedge future runs. The IMDb settings page disables Update-now while an import is active and shows a message when a duplicate is rejected. |
| 2026-07-04 | **IMDb import panel survives a missed completion event.** A long dataset import (`title.principals` ≈ 90M rows) emits no WS progress events for minutes and can outlast a socket reconnect, so the terminal `imdb.dataset.import.completed` event could be missed and the history/status never refresh. The settings page now polls the imports + provider-status queries every 4s while an import is active — driven by the live panel *or* the newest history row, so a page reload mid-import keeps tracking — and reconciles the live panel to completed/failed from the polled history, so the result and updated status always appear regardless of WS delivery. |
| 2026-07-04 | **IMDb auto-download works without a pre-configured path.** The dataset path is a *download destination*, not a pre-existing source, so `runDatasetUpdate`/`triggerDatasetUpdate` no longer require `datasetPath` to be set: `ImdbService.resolveDatasetDir()` falls back to a managed default (`<storage-root>/.ultratorrent/imdb-datasets`), creates it on download, and persists it so validate/import/history point there. The scheduler no longer skips when no path is configured, and the "Update now" button is no longer gated on a path. |
| 2026-07-04 | **In-app update check.** The About dialog now reports whether a newer release is available and how to apply it. New `SystemUpdateService` (in `SystemModule`) makes one read-only call to the GitHub tags API for `damirabal/ultratorrent-core` (repo overridable via `ULTRATORRENT_UPDATE_REPO`), picks the highest `vX.Y.Z` tag, and compares it to the running version. It detects the deployment — Docker vs bare-metal via `/.dockerenv` + `/proc/1/cgroup` (overridable with `ULTRATORRENT_DEPLOYMENT`) — and returns the matching apply command, because the app **never self-applies**: in Docker a container can't replace the image it runs from, and updates rebuild from source, so it surfaces `docker compose up -d --build` (Docker) or `git pull` + build + restart (bare-metal) rather than pretending to auto-update. The check runs daily in the background (on by default, toggleable) plus on demand. Endpoints: `GET /api/system/update` and `POST /api/system/update/check` (`system.view`), `PATCH /api/system/update/settings` (`system.manage`, super-admin — the first live use of that permission). The check can be disabled entirely (setting `system.updateCheck`); failures are recorded, never thrown. |
| 2026-07-04 | **Scheduled auto-download + import of IMDb datasets.** When the IMDb dataset feature is enabled, the datasets can now be fetched and imported automatically instead of the operator manually placing `.tsv.gz` files. New IMDb settings: `autoDownloadEnabled`, `datasetBaseUrl` (defaults to the official `https://datasets.imdbws.com/`, operator-configurable to a mirror; validated as http(s)), and `autoUpdateIntervalHours` (default 168 = weekly). A new `ImdbDatasetScheduler` (`@Interval`, hourly tick) runs a download-then-import at most once per interval when `mode` is `dataset`/`hybrid`, auto-download is on, and a `datasetPath` is set — "due" is derived from the latest import plus an in-memory attempt clock, serialised so transfers never overlap. `ImdbDatasetImporterService.downloadDataset()` streams the seven files to disk (temp `.part` → atomic rename) strictly inside the hard roots and emits `imdb.dataset.download.{started,progress,completed,failed}` WS events (added to `@ultratorrent/shared`). Manual `POST /api/media/providers/imdb/dataset/update-now` (`media_manager.imdb.import_dataset`) kicks off a detached download+import. **Compliance:** this is the subsystem's only network access — it fetches the official non-commercial dataset files from their sanctioned distribution host; NO imdb.com HTML scraping, browser automation, or web-page parsing (still forbidden). The IMDb settings page replaces the previously-inert cron field with auto-download controls (toggle, base URL, interval, "Update now") and live download+import progress. |
| 2026-07-04 | **Media Detail artwork uses the shared poster component.** The Media Detail artwork tab now renders each tile through `MediaPoster` instead of a raw `<img src={url ?? localPath}>`, so locally-stored artwork (custom uploads / on-disk provider imports) displays via the authenticated `GET /api/media/artwork/:artworkId/image` endpoint rather than showing a broken image; remote provider art still loads from its `url`. |
| 2026-07-04 | **Rich, poster-forward Media list.** The Media Manager media browser (`MediaItemsPage`) was rebuilt from a sparse table into a metadata-dense list: each row renders the poster artwork plus title/year, rating (★/10), media-type + match badges, season/episode, certification, runtime, a 2-line overview, genre chips, technical specs pulled from the largest file (resolution/codec/HDR/audio/size/container), and IMDb/TMDB external-id links; poster and title link to the item detail page. `MediaItemService.list()` now eagerly loads `metadata`, `externalIds`, and the poster `artwork` (selected first, `take: 1`) instead of only `files`. Artwork rendering is handled by a reusable `MediaPoster` component that shows remote provider art directly from its `url` and, for locally-stored art (custom uploads / on-disk imports), fetches bytes through the new `GET /api/media/artwork/:artworkId/image` endpoint (`MEDIA_MANAGER_VIEW`, `MediaArtworkService.readImage` → `StreamableFile`, path re-asserted inside the hard roots) as a bearer-authenticated blob — filesystem paths aren't reachable from an `<img>` tag. |
| 2026-07-04 | **Validate-and-create directory flow for path saves.** Saving a filesystem path now validates it against the ops hard roots (`FILE_MANAGER_ROOTS`) and offers to create it when it's allowed but missing. New `GET /api/files/inspect?path=` reports `{ path, withinHardRoots, isSystemDir, exists, isDirectory, writable }` without throwing (`FilePathService.inspect`, perm `files.view`); new `POST /api/files/ensure-dir` recursively creates a directory strictly inside the hard roots and is audited (`FilePathService.ensureDirectory`, perm `files.create_folder`). A reusable frontend `useEnsureDirectory()` hook (`components/path/EnsureDirectory.tsx`) runs the check at the top of a form's submit handler — rejecting out-of-root paths, prompting a "create this folder?" modal for allowed-but-missing ones, and failing open if inspection is unavailable (en-US + es-PR). It is wired into every destination-path save form: Media Manager library create/edit, Add Torrent save path, RSS rule save path, Automation move/rename destinations, and the Settings default root path; pure read-source inputs (rename source, scan/dry-run library, rename preview source) are deliberately excluded. `MediaLibraryService.create/update` now also `assertWithinHardRoots` the library path server-side (previously unvalidated). |
| 2026-07-04 | **RSS rules import gains merge modes.** `POST /api/rss/rules-import?mode=skip\|overwrite\|merge` now controls how an imported bundle reconciles with existing rules: **skip** (default) leaves any same-name rule on the same feed untouched; **overwrite** updates the matched rule's fields and replaces its entire match-candidate set; **merge** keeps the rule and appends only non-duplicate candidates (dedup key `matchType\|pattern\|name`, new candidates ordered after the current max). Feeds are always matched and reused by URL — never renamed. Candidates with an unknown `matchType` are dropped and counted. The summary now reports `{ mode, feedsCreated, rulesCreated, rulesOverwritten, rulesMerged, rulesSkipped, candidatesCreated, candidatesSkipped }`, and the import UI adds a mode-selection dialog (en-US + es-PR). |
| 2026-07-04 | **Git tag in the version display.** `GET /api/system/version` now returns `gitTag` — the exact `git describe` tag when passed at build time via the new `GIT_TAG` build arg (Dockerfile + both compose files), otherwise falling back to `v<VERSION>` (every commit is tagged `vX.Y.Z`, so this matches the release). The About dialog gains a **Tag** row (en-US + es-PR) next to Version. `.git` is excluded from the Docker build context, so the real describe must be supplied: `GIT_TAG=$(git describe --tags --always --dirty) docker compose up -d --build`. |
| 2026-07-04 | **Fix backend boot crash on fresh builds (module DI cycle).** `MediaModule` and `AutomationModule` form a cycle — `AutomationModule` imports `MediaService`/`MediaAutomationActions`, while `ImdbService` and `MediaProcessingService` (in `MediaModule`) needed `AutomationEngine`. On a clean build Nest instantiated `MediaModule` first and threw "can't resolve dependencies … circular import," crash-looping the backend (502 on login). Both consumers now resolve `AutomationEngine` lazily via `ModuleRef.get(…, { strict: false })` at call time (both uses are fire-and-forget `.evaluate()` triggers), so it's no longer a construction-time dependency. |
| 2026-07-04 | **Online artwork provider (TMDB).** New `ArtworkProvider` seam (`artwork-provider.ts`) with `TmdbArtworkProvider` — resolves an item's `tmdb` `MediaExternalId`, lists `/images`, and imports the best poster+fanart. `MediaArtworkService.importFromProvider()` downloads through the same magic-byte + 10 MB validation as uploads, enforces an `image.tmdb.org` host allowlist (SSRF guard), stores under the hard root with provenance `source: 'tmdb'`, is idempotent per url, and auto-selects only when no art of that type exists (custom uploads keep precedence). The `media_fetch_artwork` automation action now fetches instead of only reporting the gap; it still falls back to `detectMissing()` when no TMDB key/external id is configured. Operators can also trigger it manually via `POST /api/media/items/:id/artwork/import` (permission `media_manager.manage_artwork`), tracked as a `MediaProcessingJob` with WS progress, and from the Media Detail artwork panel's "Fetch from provider" button (en-US + es-PR). Pure mapping/ranking/host-guard helpers are unit-tested. |
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
