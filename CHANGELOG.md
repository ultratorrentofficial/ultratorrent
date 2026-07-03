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
