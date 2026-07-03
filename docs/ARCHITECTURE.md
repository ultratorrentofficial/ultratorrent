# Architecture

This document describes the architecture of **UltraTorrent** — the open-source,
self-hosted torrent management platform in this repository. UltraTorrent is a
single, community product: there is no separate commercial edition or private
overlay, and everything the application ships is covered here.

## Overview

UltraTorrent is a management layer in front of existing BitTorrent engines. The
browser never talks to an engine directly — it talks to the UltraTorrent API,
which translates requests into the engine's native protocol and returns
**normalized**, engine-agnostic data. Live updates are pushed over WebSocket.

```
        React SPA  ── REST /api ──▶  NestJS API  ── XML-RPC/SCGI ──▶  rTorrent
             ▲         WS /ws           │
             └──────── live events ─────┘         PostgreSQL (Prisma) · Redis
```

## Clean Architecture layers

Dependencies point inward; the domain knows nothing about HTTP, Prisma, or any
specific engine.

| Layer | Responsibility | Examples |
|-------|----------------|----------|
| **API** | HTTP controllers, DTOs/validation, guards, WebSocket gateway | `*.controller.ts`, `RealtimeGateway` |
| **Application** | Orchestrates use cases, RBAC, auditing | `TorrentsService`, `EngineRegistryService`, `TorrentSyncService` |
| **Domain** | Engine-agnostic contracts — *the seam* | `TorrentEngineProvider` interface, `Normalized*` types |
| **Infrastructure** | Concrete adapters | `RTorrentProvider`, XML-RPC/SCGI client, `PrismaService` |

### The engine seam

`TorrentEngineProvider` is the single interface every engine implements
(add/remove/start/stop/recheck/move, file priorities, trackers, rate limits,
stats). The current Core ships a complete **rTorrent** provider (XML-RPC over
SCGI/HTTP); adding another engine means implementing this interface — no UI or
business-logic changes. A background `TorrentSyncService` polls each engine and
fans normalized torrent lists, global stats, and engine status out over the
WebSocket gateway.

## Backend modules (Core)

NestJS modules, each RBAC-guarded and audited where it mutates state:

- **auth** — login (+ optional 2FA), JWT access tokens, rotating/hashed refresh
  tokens with reuse detection, logout, change-password.
- **users / RBAC** — users, system roles, and a dot-namespaced permission
  catalog (in `@ultratorrent/shared`).
- **two-factor** — TOTP enrolment/verification, encrypted secrets, recovery codes.
- **torrents** — add (magnet / file / URL), lifecycle actions, bulk actions,
  trackers, file priorities, limits, move.
- **engine** — provider factory + `EngineRegistryService` (resolve engines).
- **files** — path-safe file manager (browse/preview/download/rename/move/copy/
  mkdir/delete-to-trash/cleanup) confined to configured roots.
- **rss** — feeds + include/exclude rules + a match-preference engine and Smart
  Match Builder.
- **automation** — condition/action rules triggered by events. Beyond the
  torrent triggers (`torrent.completed`, `ratio.reached`) and actions
  (stop/delete/move/notify/webhook/`rename_for_media`), the engine registers
  Media Manager triggers (`media.detected|matched|unmatched|missing_artwork|
  missing_subtitles|rename_completed|server_refresh_failed`) and actions
  (`media_scan_library`, `media_match`, `media_fetch_metadata`,
  `media_fetch_artwork`, `media_generate_nfo`, `media_rename`, `media_move`,
  `media_notify`, `media_server_refresh`) — the latter delegated to
  `MediaAutomationActions` (media module) so the engine has no engine-provider
  dependency for media work. Catalog exposed at `GET /api/automation/catalog`.
  A `MediaProcessingService` subscribes to `torrent.completed` and, for downloads
  landing inside an opted-in library, runs an opt-in best-effort post-download
  pipeline (scan → identify → rename/move per `library.mode` → metadata → artwork
  → subtitles → NFO → media-server refresh), firing the `media.*` triggers.
- **taxonomy** — categories & tags.
- **notifications** — in-app + webhook/Discord/Slack/Telegram fan-out.
- **media-manager** — media libraries: scan → identify (parse release names →
  type/title/year/season/episode), metadata/artwork/subtitles, NFO, duplicate
  detection, media-server integration, and the rename engine (preset/preview/
  apply/history). Long-running operations run through an in-process
  `MediaProcessingQueueService` that persists each as a `MediaProcessingJob` row
  and streams `media_manager.job.{started,progress,completed,failed}` lifecycle
  events over the RealtimeGateway. Endpoints under `/api/media`; `media_manager.*`
  permissions.
- **dashboard**, **search**, **settings**, **apikeys**, **audit**, **system**
  (health/liveness/version), **realtime**, **module-registry**.

## Security model (Core)

- **AuthN:** Argon2id password hashing; short-lived JWT access tokens (HS256,
  algorithm-pinned); refresh tokens rotated on use, stored hashed, with reuse
  detection; production boot refuses unset/weak/default secrets.
- **AuthZ (RBAC):** every protected route carries `JwtAuthGuard` +
  `PermissionsGuard` + `@RequirePermissions(...)`. The UI hides what a user
  can't use; the server always enforces.
- **Path safety:** all file/torrent paths are canonicalized (realpath) and
  confined to `FILE_MANAGER_ROOTS`; traversal, symlink-escape, absolute-escape,
  and system directories are rejected. An admin-set Default Root Path can only
  narrow within that boundary.
- **Input/transport:** global `ValidationPipe` (`whitelist` +
  `forbidNonWhitelisted`), Helmet, throttling (with stricter login/refresh
  limits), pagination caps, SSRF-guarded remote-torrent fetch, and a global
  exception filter (no stack-trace leakage).
- **WebSocket:** JWT-authenticated handshake; each socket only joins the
  permission-scoped feeds it may read.
- **Audit:** destructive/security-relevant actions are recorded with actor, IP,
  user agent, and result.

To report a vulnerability, see the **Security** section of the
[README](../README.md#security).

## Data & caching

**PostgreSQL** via **Prisma** is the store (users/roles/permissions, torrent
snapshots, categories/tags, RSS, automation, notifications, API keys, audit log,
settings). **Redis** backs caching and background jobs. Migrations live in
`apps/backend/prisma/migrations`; the seed provisions permissions, system roles,
the bootstrap admin, and default settings (idempotent).

## Frontend

React 18 + Vite + TypeScript + Tailwind, React Router, TanStack Query, and a
Socket.IO client. The app shell has a grouped, collapsible sidebar whose items
are filtered by permission + module state; a top bar with breadcrumbs, live
transfer rates, and connection status; and route-level `ProtectedRoute` /
`ModuleRoute` guards. See [NAVIGATION.md](NAVIGATION.md) for the nav model.

## Repository layout (Community)

```
apps/backend      NestJS API (@ultratorrent/backend)
apps/frontend     React + Vite SPA (@ultratorrent/frontend)
packages/shared   @ultratorrent/shared — types, permission catalog, event contracts
docs/             this documentation set
```

## Further reading

[INSTALL.md](INSTALL.md) · [DOCKER.md](DOCKER.md) ·
[DEVELOPMENT.md](DEVELOPMENT.md) · [NAVIGATION.md](NAVIGATION.md) ·
[FILE_MANAGER.md](FILE_MANAGER.md) · [MEDIA_MANAGER.md](MEDIA_MANAGER.md) ·
[MODULES.md](MODULES.md)

## Change Log

This is the canonical architecture doc for the single-tier Community repo. When a
component is added or changed, update the relevant section above **and** append a
dated row here.

| Date | Change |
|------|--------|
| 2026-07-03 | **Removed dead Enterprise/Pro/licensing scaffolding (single-tier cleanup).** With the product fully single-tier community, the leftover gating/tiering machinery is being purged: the `'premium'`/`'enterprise'` `ModuleTier`/`Edition` values, `requiredLicenseModule`, the `PREMIUM_MANIFESTS`/`ENTERPRISE_MANIFESTS` + placeholder manifests, the now-unused `ModuleGuard`/`RequiresModule`/`LicenseProvider` module-gating layer, `media_renamer_pro` remnants, and the remaining "overlay/premium/enterprise/UPLM" comments across `packages/shared`, `apps/backend`, `apps/frontend`, and `docs/`. Modules are Core, gated only by RBAC (+ an optional enable/disable flag). |
| 2026-07-03 | **Media Manager automation + post-download workflow + job queue.** Automation engine gains Media Manager triggers (`media.detected|matched|unmatched|missing_artwork|missing_subtitles|rename_completed|server_refresh_failed`) and actions (`media_scan_library`/`media_match`/`media_fetch_metadata`/`media_fetch_artwork`/`media_generate_nfo`/`media_rename`/`media_move`/`media_notify`/`media_server_refresh`) delegated to `MediaAutomationActions`; a trigger/action catalog is exposed at `GET /api/automation/catalog`. New `MediaProcessingService` runs an opt-in best-effort post-download pipeline off `torrent.completed` (scan → identify → rename/move per `library.mode` → metadata → artwork → subtitles → NFO → media-server refresh) for downloads inside a covering library. New in-process `MediaProcessingQueueService` persists long-running operations as `MediaProcessingJob` rows (queued/running/completed/failed + progress) and streams their lifecycle over the RealtimeGateway. Added WS events `media_manager.job.{started,progress,completed,failed}` and the `MediaJobEventPayload` contract in `@ultratorrent/shared`; the gateway scopes the `media_manager.*` channel to `MEDIA_MANAGER_VIEW`. |
| 2026-07-03 | **Media Manager core module.** New `media_manager` module evolved from the core renamer. Prisma models `MediaItem`/`MediaFile`/`MediaMetadata`/`MediaArtwork`/`MediaSubtitle`/`MediaExternalId`/`MediaCollection`/`MediaCollectionItem`/`MediaRenameTemplate`/`MediaProcessingJob` (+ duplicate-group, media-server-integration, NFO) via the `media_manager_models` migration. Backend services: library/scanner/identification/item/health, plus metadata/artwork/subtitle/NFO/duplicate/media-server-integration, and the retained rename engine. Endpoints under `/api/media`; `media_manager.*` permission block. Frontend: Media Dashboard/Items/Libraries pages + routing/nav + `api.mediaManager`. |
| 2026-07-03 | **Single-tier community conversion.** The product was consolidated from a dual community/enterprise split into one community platform in this repo: the enterprise overlay and its modules (licensing/UPLM, Fleet, Customers, Provisioning, Billing, Central Backups/Updates, Analytics, White-Label, Multi-Server, Node Agent) were removed, Release Scoring + Media Acquisition Intelligence were relocated into core, and the versioning/publish tooling was de-editioned. This doc is now the canonical architecture reference. |
