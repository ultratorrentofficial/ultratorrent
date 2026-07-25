---
id: modules
title: Module Reference
sidebar_position: 3
description: Every UltraTorrent module, its tier, dependencies, permissions and routes.
keywords: [modules, registry, manifest, dependencies, core, community]
---

# Module Reference

:::info Auto-generated
This page is generated from `apps/backend/src/modules/module-registry/manifests.ts` at build time. **Do not edit it by hand** — change the source and rebuild. This guarantees the reference always matches the code that ships.
:::

UltraTorrent is built as a **module registry**. Each module declares a manifest — its id,
tier, dependencies, the permissions it introduces and the API routes it owns. The registry
resolves the dependency graph at boot and refuses to start on an unknown or circular
dependency, so a broken module can never half-load.

- **23 modules** across tiers: `core`, `community`
- **Core** modules are always on. **Community/optional** modules can be toggled.

## Dependency graph

```mermaid
graph LR
  auth["auth"] --> rbac["rbac"]
  auth["auth"] --> account["account"]
  auth["auth"] --> users["users"]
  rbac["rbac"] --> users["users"]
  auth["auth"] --> engine["engine"]
  auth["auth"] --> dashboard["dashboard"]
  engine["engine"] --> dashboard["dashboard"]
  auth["auth"] --> torrents["torrents"]
  engine["engine"] --> torrents["torrents"]
  auth["auth"] --> search["search"]
  auth["auth"] --> taxonomy["taxonomy"]
  auth["auth"] --> rss["rss"]
  engine["engine"] --> rss["rss"]
  auth["auth"] --> automation["automation"]
  engine["engine"] --> automation["automation"]
  auth["auth"] --> files["files"]
  auth["auth"] --> api_keys["api_keys"]
  auth["auth"] --> audit["audit"]
  auth["auth"] --> settings["settings"]
  auth["auth"] --> module_registry["module_registry"]
  rbac["rbac"] --> module_registry["module_registry"]
  auth["auth"] --> media_manager["media_manager"]
  files["files"] --> media_manager["media_manager"]
  auth["auth"] --> release_scoring["release_scoring"]
  rss["rss"] --> release_scoring["release_scoring"]
  auth["auth"] --> media_acquisition_intelligence["media_acquisition_intelligence"]
  rbac["rbac"] --> media_acquisition_intelligence["media_acquisition_intelligence"]
  module_registry["module_registry"] --> media_acquisition_intelligence["media_acquisition_intelligence"]
  audit["audit"] --> media_acquisition_intelligence["media_acquisition_intelligence"]
  settings["settings"] --> media_acquisition_intelligence["media_acquisition_intelligence"]
  rss["rss"] --> media_acquisition_intelligence["media_acquisition_intelligence"]
  automation["automation"] --> media_acquisition_intelligence["media_acquisition_intelligence"]
  release_scoring["release_scoring"] --> media_acquisition_intelligence["media_acquisition_intelligence"]
  auth["auth"] --> media_server_analytics["media_server_analytics"]
  rbac["rbac"] --> media_server_analytics["media_server_analytics"]
  module_registry["module_registry"] --> media_server_analytics["media_server_analytics"]
  audit["audit"] --> media_server_analytics["media_server_analytics"]
  settings["settings"] --> media_server_analytics["media_server_analytics"]
  media_manager["media_manager"] --> media_server_analytics["media_server_analytics"]
  automation["automation"] --> media_server_analytics["media_server_analytics"]
  auth["auth"] --> subtitle_intelligence["subtitle_intelligence"]
  rbac["rbac"] --> subtitle_intelligence["subtitle_intelligence"]
  files["files"] --> subtitle_intelligence["subtitle_intelligence"]
  audit["audit"] --> subtitle_intelligence["subtitle_intelligence"]
  settings["settings"] --> subtitle_intelligence["subtitle_intelligence"]
  media_manager["media_manager"] --> subtitle_intelligence["subtitle_intelligence"]
  auth["auth"] --> library_cleanup["library_cleanup"]
  rbac["rbac"] --> library_cleanup["library_cleanup"]
  files["files"] --> library_cleanup["library_cleanup"]
  audit["audit"] --> library_cleanup["library_cleanup"]
  settings["settings"] --> library_cleanup["library_cleanup"]
  media_manager["media_manager"] --> library_cleanup["library_cleanup"]
```

## All modules

| Module | Id | Tier | On by default | Depends on |
| --- | --- | --- | :---: | --- |
| **Authentication** | `auth` | core | ✅ | — |
| **Access control (RBAC)** | `rbac` | core | ✅ | `auth` |
| **Account & security** | `account` | core | ✅ | `auth` |
| **Users** | `users` | core | ✅ | `auth`, `rbac` |
| **Torrent engine** | `engine` | core | ✅ | `auth` |
| **Dashboard** | `dashboard` | core | ✅ | `auth`, `engine` |
| **Torrents** | `torrents` | core | ✅ | `auth`, `engine` |
| **Search** | `search` | core | ✅ | `auth` |
| **Categories & tags** | `taxonomy` | core | ✅ | `auth` |
| **RSS automation** | `rss` | core | ✅ | `auth`, `engine` |
| **Automation** | `automation` | core | ✅ | `auth`, `engine` |
| **File manager** | `files` | core | ✅ | `auth` |
| **API keys** | `api_keys` | core | ✅ | `auth` |
| **Audit log** | `audit` | core | ✅ | `auth` |
| **System health** | `system` | core | ✅ | — |
| **Settings** | `settings` | core | ✅ | `auth` |
| **Module registry** | `module_registry` | core | ✅ | `auth`, `rbac` |
| **Media Manager** | `media_manager` | community | ✅ | `auth`, `files` |
| **Release Scoring** | `release_scoring` | community | ✅ | `auth`, `rss` |
| **Media Acquisition Intelligence** | `media_acquisition_intelligence` | community | ✅ | `auth`, `rbac`, `module_registry`, `audit`, `settings`, `rss`, `automation`, `release_scoring` |
| **Media Server Analytics** | `media_server_analytics` | core | ✅ | `auth`, `rbac`, `module_registry`, `audit`, `settings`, `media_manager`, `automation` |
| **Subtitle Intelligence** | `subtitle_intelligence` | core | ✅ | `auth`, `rbac`, `files`, `audit`, `settings`, `media_manager` |
| **Library Cleanup Center** | `library_cleanup` | core | ✅ | `auth`, `rbac`, `files`, `audit`, `settings`, `media_manager` |

## Authentication

`auth` · tier `core` · enabled by default

Login, sessions, refresh-token rotation.

**Owns routes:** `/api/auth`

## Access control (RBAC)

`rbac` · tier `core` · enabled by default

Roles, permissions, and route guards.

**Depends on:** `auth`

**Introduces permissions:** `roles.manage`

## Account & security

`account` · tier `core` · enabled by default

Self-service profile, password, and 2FA.

**Depends on:** `auth`

**Owns routes:** `/api/account`

## Users

`users` · tier `core` · enabled by default

User management and role assignment.

**Depends on:** `auth`, `rbac`

**Introduces permissions:** `users.view`, `users.manage`

**Owns routes:** `/api/users`

## Torrent engine

`engine` · tier `core` · enabled by default

Engine provider abstraction (rTorrent) + registry.

**Depends on:** `auth`

**Introduces permissions:** `system.view`, `engines.manage`

**Owns routes:** `/api/engines`

## Dashboard

`dashboard` · tier `core` · enabled by default

Aggregated stats and recent activity.

**Depends on:** `auth`, `engine`

**Introduces permissions:** `torrents.view`

**Owns routes:** `/api/dashboard`

## Torrents

`torrents` · tier `core` · enabled by default

Torrent list, detail, lifecycle, bulk actions.

**Depends on:** `auth`, `engine`

**Introduces permissions:** `torrents.view`, `torrents.add`, `torrents.delete`

**Owns routes:** `/api/torrents`

## Search

`search` · tier `core` · enabled by default

Search persisted torrent snapshots.

**Depends on:** `auth`

**Introduces permissions:** `torrents.view`

**Owns routes:** `/api/search`

## Categories & tags

`taxonomy` · tier `core` · enabled by default

Organise torrents with categories and tags.

**Depends on:** `auth`

**Introduces permissions:** `categories.manage`, `tags.manage`

**Owns routes:** `/api/categories`, `/api/tags`

## RSS automation

`rss` · tier `core` · enabled by default

Feeds, ranked match candidates, and the Smart Match Builder.

**Depends on:** `auth`, `engine`

**Introduces permissions:** `rss.view`, `rss.manage`, `rss.show_status.lookup`, `rss.show_status.refresh`, `rss.show_status.override`

**Owns routes:** `/api/rss`

## Automation

`automation` · tier `core` · enabled by default

Trigger/condition/action rule engine.

**Depends on:** `auth`, `engine`

**Introduces permissions:** `automation.view`, `automation.manage`

**Owns routes:** `/api/automation`

## File manager

`files` · tier `core` · enabled by default

Path-safe browsing and file operations.

**Depends on:** `auth`

**Introduces permissions:** `files.view`, `files.manage`

**Owns routes:** `/api/files`

## API keys

`api_keys` · tier `core` · enabled by default

Personal API key issue/list/revoke.

**Depends on:** `auth`

**Introduces permissions:** `apikeys.manage`

**Owns routes:** `/api/api-keys`

## Audit log

`audit` · tier `core` · enabled by default

Append-only audit trail of sensitive actions.

**Depends on:** `auth`

**Introduces permissions:** `audit.view`

**Owns routes:** `/api/audit`

## System health

`system` · tier `core` · enabled by default

Liveness/readiness probes and health reporting.

**Introduces permissions:** `system.view`

**Owns routes:** `/api/system`

## Settings

`settings` · tier `core` · enabled by default

Key/value application settings.

**Depends on:** `auth`

**Introduces permissions:** `settings.view`, `settings.manage`

**Owns routes:** `/api/settings`

## Module registry

`module_registry` · tier `core` · enabled by default

Enable/disable optional modules.

**Depends on:** `auth`, `rbac`

**Introduces permissions:** `modules.view`, `modules.manage`

**Owns routes:** `/api/modules`

## Media Manager

`media_manager` · tier `community` · enabled by default

Scan, identify, enrich, and organise your media libraries: library scanning, filename identification, metadata/artwork/subtitles, duplicate detection, NFO generation, rename/move for media servers, and a health dashboard.

**Depends on:** `auth`, `files`

**Introduces permissions:** `media_manager.view`, `media_manager.manage_libraries`, `media_manager.scan`, `media_manager.match`, `media_manager.edit_metadata`, `media_manager.manage_artwork`, `media_manager.manage_subtitles`, `media_manager.rename`, `media_manager.move_files`, `media_manager.generate_nfo`, `media_manager.manage_integrations`, `media_manager.delete`, `media_manager.admin`, `media_manager.imdb.view`, `media_manager.imdb.configure`, `media_manager.imdb.import_dataset`, `media_manager.imdb.search`, `media_manager.imdb.match`

**Owns routes:** `/api/media`

## Release Scoring

`release_scoring` · tier `community` · enabled by default

Explainable 0–100 scoring of RSS releases with reasons, warnings, and a recommendation.

**Depends on:** `auth`, `rss`

**Introduces permissions:** `release_scoring.view`, `release_scoring.manage`

**Owns routes:** `/api/release-scoring`

## Media Acquisition Intelligence

`media_acquisition_intelligence` · tier `community` · enabled by default

Decides what media to acquire from library gaps, release quality, duplicate risk, watchlists, acquisition profiles, and automation context — explainable decisions, never direct file operations.

**Depends on:** `auth`, `rbac`, `module_registry`, `audit`, `settings`, `rss`, `automation`, `release_scoring`

**Introduces permissions:** `media_acquisition.view`, `media_acquisition.manage_watchlist`, `media_acquisition.manage_profiles`, `media_acquisition.evaluate`, `media_acquisition.approve`, `media_acquisition.reject`, `media_acquisition.override`, `media_acquisition.history`, `media_acquisition.export`, `media_acquisition.settings`

**Owns routes:** `/api/media-acquisition`

## Media Server Analytics

`media_server_analytics` · tier `core` · enabled by default

Media server monitoring, analytics, recently-added, watch history, live activity, user/library statistics, scheduled newsletters, and Tautulli analytics import — across Plex, Jellyfin, Emby, and Kodi.

**Depends on:** `auth`, `rbac`, `module_registry`, `audit`, `settings`, `media_manager`, `automation`

**Introduces permissions:** `media_server_analytics.view`, `media_server_analytics.manage_connections`, `media_server_analytics.manage_mappings`, `media_server_analytics.view_live_activity`, `media_server_analytics.view_users`, `media_server_analytics.view_history`, `media_server_analytics.view_reports`, `media_server_analytics.export`, `media_server_analytics.manage_newsletters`, `media_server_analytics.send_newsletters`, `media_server_analytics.manage_imports`, `media_server_analytics.run_imports`, `media_server_analytics.manage_settings`, `media_server_analytics.admin`

**Owns routes:** `/api/media-server-analytics`

## Subtitle Intelligence

`subtitle_intelligence` · tier `core` · enabled by default

The definitive subtitle engine: fingerprints every media file (movie hash + technical metadata), searches multiple providers with a progressively-relaxed strategy (hash → release → external id → title), scores and validates each candidate, installs the best as a media-server-correct sidecar (never overwriting an original), and can synchronize it to the audio. Per-library language policy, automation, and background monitoring.

**Depends on:** `auth`, `rbac`, `files`, `audit`, `settings`, `media_manager`

**Introduces permissions:** `subtitle_intelligence.view`, `subtitle_intelligence.search`, `subtitle_intelligence.download`, `subtitle_intelligence.synchronize`, `subtitle_intelligence.manage`, `subtitle_intelligence.providers`, `subtitle_intelligence.settings`, `subtitle_intelligence.admin`

**Owns routes:** `/api/subtitle-intelligence`

## Library Cleanup Center

`library_cleanup` · tier `core` · enabled by default

Policy-driven reclamation of library storage. Users build versioned cleanup policies from a catalogue of metadata, playback, technical, storage and safety conditions; a run turns matches into CANDIDATES, never deletions. Nothing is removed except through a persisted, approved plan whose per-file fingerprints still match the world, and protected, locked, actively-playing, in-flight, ambiguous or unmeasured files are refused server-side. Removal goes to quarantine or Trash through the existing path-safe file services; permanent deletion is a manual, separately-permissioned operation.

**Depends on:** `auth`, `rbac`, `files`, `audit`, `settings`, `media_manager`

**Introduces permissions:** `library_cleanup.view`, `library_cleanup.policy.create`, `library_cleanup.policy.edit`, `library_cleanup.policy.publish`, `library_cleanup.policy.enable`, `library_cleanup.policy.delete`, `library_cleanup.run`, `library_cleanup.simulate`, `library_cleanup.approve`, `library_cleanup.cancel`, `library_cleanup.protection.view`, `library_cleanup.protection.create`, `library_cleanup.protection.revoke`, `library_cleanup.protection.legal_hold`, `library_cleanup.trash`, `library_cleanup.restore`, `library_cleanup.permanent_delete`, `library_cleanup.settings`, `library_cleanup.audit`

**Owns routes:** `/api/media/cleanup`

## See also

- [Permissions Reference](/reference/permissions)
- [REST API Reference](/reference/api)
- [Writing a module](/develop/creating-modules)
