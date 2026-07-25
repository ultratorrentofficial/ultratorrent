---
id: permissions
title: Permissions Reference
sidebar_position: 2
description: Every RBAC permission in UltraTorrent and which built-in role holds it.
keywords: [permissions, rbac, roles, access control, authorization, security]
---

# Permissions Reference

:::info Auto-generated
This page is generated from `packages/shared/src/permissions.ts` at build time. **Do not edit it by hand** — change the source and rebuild. This guarantees the reference always matches the code that ships.
:::

UltraTorrent uses **granular, dot-namespaced permissions** (`domain.action`). Roles are
just named sets of them. Both the backend route guards (`@RequirePermissions`) and the
frontend capability checks read this same catalogue, so what you see here is exactly what
is enforced.

- **152 permissions** across **25 domains**
- **5 built-in roles**

## How to read this

- A **✅** means the role holds that permission out of the box.
- Roles are cumulative in practice but **not** by inheritance — each role's set is explicit,
  so you can always see precisely what it can do.
- Custom roles are built from the same catalogue. See [Access Control](/develop/rbac).

## Role summary

| Role | Permissions held |
| --- | --- |
| `SUPER_ADMIN` | 152 of 152 |
| `ADMINISTRATOR` | 149 of 152 |
| `POWER_USER` | 74 of 152 |
| `USER` | 20 of 152 |
| `READ_ONLY` | 11 of 152 |

## `apikeys`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `apikeys.manage` | `APIKEYS_MANAGE` | ✅ | ✅ | — | — | — |

## `audit`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `audit.view` | `AUDIT_VIEW` | ✅ | ✅ | — | — | — |

## `automation`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `automation.view` | `AUTOMATION_VIEW` | ✅ | ✅ | ✅ | — | ✅ |
| `automation.manage` | `AUTOMATION_MANAGE` | ✅ | ✅ | ✅ | — | — |

## `categories`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `categories.manage` | `CATEGORIES_MANAGE` | ✅ | ✅ | ✅ | ✅ | — |

## `engines`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `engines.manage` | `ENGINES_MANAGE` | ✅ | ✅ | — | — | — |

## `files`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `files.view` | `FILES_VIEW` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `files.manage` | `FILES_MANAGE` | ✅ | ✅ | ✅ | — | — |
| `files.preview` | `FILES_PREVIEW` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `files.download` | `FILES_DOWNLOAD` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `files.create_folder` | `FILES_CREATE_FOLDER` | ✅ | ✅ | ✅ | — | — |
| `files.rename` | `FILES_RENAME` | ✅ | ✅ | ✅ | — | — |
| `files.move` | `FILES_MOVE` | ✅ | ✅ | ✅ | — | — |
| `files.copy` | `FILES_COPY` | ✅ | ✅ | ✅ | — | — |
| `files.delete` | `FILES_DELETE` | ✅ | ✅ | ✅ | — | — |
| `files.bulk_actions` | `FILES_BULK_ACTIONS` | ✅ | ✅ | ✅ | — | — |
| `files.cleanup` | `FILES_CLEANUP` | ✅ | ✅ | ✅ | — | — |

## `indexers`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `indexers.view` | `INDEXERS_VIEW` | ✅ | ✅ | ✅ | — | — |
| `indexers.manage` | `INDEXERS_MANAGE` | ✅ | ✅ | ✅ | — | — |
| `indexers.test` | `INDEXERS_TEST` | ✅ | ✅ | ✅ | — | — |

## `integrations`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `integrations.prowlarr.view` | `INTEGRATIONS_PROWLARR_VIEW` | ✅ | ✅ | ✅ | — | — |
| `integrations.prowlarr.manage` | `INTEGRATIONS_PROWLARR_MANAGE` | ✅ | ✅ | ✅ | — | — |
| `integrations.prowlarr.test` | `INTEGRATIONS_PROWLARR_TEST` | ✅ | ✅ | ✅ | — | — |
| `integrations.prowlarr.open` | `INTEGRATIONS_PROWLARR_OPEN` | ✅ | ✅ | ✅ | — | — |

## `jobs`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `jobs.view` | `JOBS_VIEW` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `jobs.view_all` | `JOBS_VIEW_ALL` | ✅ | ✅ | — | — | — |
| `jobs.view_events` | `JOBS_VIEW_EVENTS` | ✅ | ✅ | ✅ | ✅ | — |
| `jobs.view_diagnostics` | `JOBS_VIEW_DIAGNOSTICS` | ✅ | ✅ | — | — | — |
| `jobs.cancel` | `JOBS_CANCEL` | ✅ | ✅ | ✅ | — | — |
| `jobs.pause` | `JOBS_PAUSE` | ✅ | ✅ | — | — | — |
| `jobs.resume` | `JOBS_RESUME` | ✅ | ✅ | — | — | — |
| `jobs.retry` | `JOBS_RETRY` | ✅ | ✅ | ✅ | — | — |
| `jobs.rerun` | `JOBS_RERUN` | ✅ | ✅ | ✅ | — | — |
| `jobs.bulk_manage` | `JOBS_BULK_MANAGE` | ✅ | ✅ | — | — | — |
| `jobs.manage_schedules` | `JOBS_MANAGE_SCHEDULES` | ✅ | ✅ | — | — | — |
| `jobs.run_schedules` | `JOBS_RUN_SCHEDULES` | ✅ | ✅ | — | — | — |
| `jobs.view_workers` | `JOBS_VIEW_WORKERS` | ✅ | ✅ | ✅ | — | — |
| `jobs.manage_settings` | `JOBS_MANAGE_SETTINGS` | ✅ | ✅ | — | — | — |
| `jobs.admin` | `JOBS_ADMIN` | ✅ | ✅ | — | — | — |

## `library_cleanup`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `library_cleanup.view` | `LIBRARY_CLEANUP_VIEW` | ✅ | ✅ | ✅ | — | — |
| `library_cleanup.policy.create` | `LIBRARY_CLEANUP_POLICY_CREATE` | ✅ | ✅ | — | — | — |
| `library_cleanup.policy.edit` | `LIBRARY_CLEANUP_POLICY_EDIT` | ✅ | ✅ | — | — | — |
| `library_cleanup.policy.publish` | `LIBRARY_CLEANUP_POLICY_PUBLISH` | ✅ | ✅ | — | — | — |
| `library_cleanup.policy.enable` | `LIBRARY_CLEANUP_POLICY_ENABLE` | ✅ | ✅ | — | — | — |
| `library_cleanup.policy.delete` | `LIBRARY_CLEANUP_POLICY_DELETE` | ✅ | ✅ | — | — | — |
| `library_cleanup.run` | `LIBRARY_CLEANUP_RUN` | ✅ | ✅ | — | — | — |
| `library_cleanup.simulate` | `LIBRARY_CLEANUP_SIMULATE` | ✅ | ✅ | ✅ | — | — |
| `library_cleanup.approve` | `LIBRARY_CLEANUP_APPROVE` | ✅ | ✅ | — | — | — |
| `library_cleanup.cancel` | `LIBRARY_CLEANUP_CANCEL` | ✅ | ✅ | — | — | — |
| `library_cleanup.protection.view` | `LIBRARY_CLEANUP_PROTECTION_VIEW` | ✅ | ✅ | ✅ | — | — |
| `library_cleanup.protection.create` | `LIBRARY_CLEANUP_PROTECTION_CREATE` | ✅ | ✅ | — | — | — |
| `library_cleanup.protection.revoke` | `LIBRARY_CLEANUP_PROTECTION_REVOKE` | ✅ | ✅ | — | — | — |
| `library_cleanup.protection.legal_hold` | `LIBRARY_CLEANUP_PROTECTION_LEGAL_HOLD` | ✅ | — | — | — | — |
| `library_cleanup.trash` | `LIBRARY_CLEANUP_TRASH` | ✅ | ✅ | — | — | — |
| `library_cleanup.restore` | `LIBRARY_CLEANUP_RESTORE` | ✅ | ✅ | — | — | — |
| `library_cleanup.permanent_delete` | `LIBRARY_CLEANUP_PERMANENT_DELETE` | ✅ | — | — | — | — |
| `library_cleanup.settings` | `LIBRARY_CLEANUP_SETTINGS` | ✅ | ✅ | — | — | — |
| `library_cleanup.audit` | `LIBRARY_CLEANUP_AUDIT` | ✅ | ✅ | — | — | — |

## `media_acquisition`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `media_acquisition.view` | `MEDIA_ACQUISITION_VIEW` | ✅ | ✅ | — | — | — |
| `media_acquisition.manage_watchlist` | `MEDIA_ACQUISITION_MANAGE_WATCHLIST` | ✅ | ✅ | — | — | — |
| `media_acquisition.manage_profiles` | `MEDIA_ACQUISITION_MANAGE_PROFILES` | ✅ | ✅ | — | — | — |
| `media_acquisition.evaluate` | `MEDIA_ACQUISITION_EVALUATE` | ✅ | ✅ | — | — | — |
| `media_acquisition.approve` | `MEDIA_ACQUISITION_APPROVE` | ✅ | ✅ | — | — | — |
| `media_acquisition.reject` | `MEDIA_ACQUISITION_REJECT` | ✅ | ✅ | — | — | — |
| `media_acquisition.override` | `MEDIA_ACQUISITION_OVERRIDE` | ✅ | ✅ | — | — | — |
| `media_acquisition.history` | `MEDIA_ACQUISITION_HISTORY` | ✅ | ✅ | — | — | — |
| `media_acquisition.export` | `MEDIA_ACQUISITION_EXPORT` | ✅ | ✅ | — | — | — |
| `media_acquisition.settings` | `MEDIA_ACQUISITION_SETTINGS` | ✅ | ✅ | — | — | — |

## `media_manager`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `media_manager.view` | `MEDIA_MANAGER_VIEW` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `media_manager.manage_libraries` | `MEDIA_MANAGER_MANAGE_LIBRARIES` | ✅ | ✅ | ✅ | — | — |
| `media_manager.scan` | `MEDIA_MANAGER_SCAN` | ✅ | ✅ | ✅ | — | — |
| `media_manager.match` | `MEDIA_MANAGER_MATCH` | ✅ | ✅ | ✅ | — | — |
| `media_manager.edit_metadata` | `MEDIA_MANAGER_EDIT_METADATA` | ✅ | ✅ | ✅ | — | — |
| `media_manager.manage_artwork` | `MEDIA_MANAGER_MANAGE_ARTWORK` | ✅ | ✅ | ✅ | — | — |
| `media_manager.manage_subtitles` | `MEDIA_MANAGER_MANAGE_SUBTITLES` | ✅ | ✅ | ✅ | — | — |
| `media_manager.rename` | `MEDIA_MANAGER_RENAME` | ✅ | ✅ | ✅ | — | — |
| `media_manager.move_files` | `MEDIA_MANAGER_MOVE_FILES` | ✅ | ✅ | ✅ | — | — |
| `media_manager.generate_nfo` | `MEDIA_MANAGER_GENERATE_NFO` | ✅ | ✅ | ✅ | — | — |
| `media_manager.manage_integrations` | `MEDIA_MANAGER_MANAGE_INTEGRATIONS` | ✅ | ✅ | — | — | — |
| `media_manager.delete` | `MEDIA_MANAGER_DELETE` | ✅ | ✅ | — | — | — |
| `media_manager.admin` | `MEDIA_MANAGER_ADMIN` | ✅ | ✅ | — | — | — |
| `media_manager.imdb.view` | `MEDIA_MANAGER_IMDB_VIEW` | ✅ | ✅ | ✅ | ✅ | — |
| `media_manager.imdb.configure` | `MEDIA_MANAGER_IMDB_CONFIGURE` | ✅ | ✅ | ✅ | — | — |
| `media_manager.imdb.import_dataset` | `MEDIA_MANAGER_IMDB_IMPORT_DATASET` | ✅ | ✅ | ✅ | — | — |
| `media_manager.imdb.search` | `MEDIA_MANAGER_IMDB_SEARCH` | ✅ | ✅ | ✅ | ✅ | — |
| `media_manager.imdb.match` | `MEDIA_MANAGER_IMDB_MATCH` | ✅ | ✅ | ✅ | — | — |

## `media_renamer`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `media_renamer.view` | `MEDIA_RENAMER_VIEW` | ✅ | ✅ | — | — | — |
| `media_renamer.preview` | `MEDIA_RENAMER_PREVIEW` | ✅ | ✅ | — | — | — |
| `media_renamer.execute` | `MEDIA_RENAMER_EXECUTE` | ✅ | ✅ | — | — | — |
| `media_renamer.rollback` | `MEDIA_RENAMER_ROLLBACK` | ✅ | ✅ | — | — | — |
| `media_renamer.manage_templates` | `MEDIA_RENAMER_MANAGE_TEMPLATES` | ✅ | ✅ | — | — | — |

## `media_server_analytics`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `media_server_analytics.view` | `MEDIA_SERVER_ANALYTICS_VIEW` | ✅ | ✅ | — | — | — |
| `media_server_analytics.manage_connections` | `MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS` | ✅ | ✅ | — | — | — |
| `media_server_analytics.manage_mappings` | `MEDIA_SERVER_ANALYTICS_MANAGE_MAPPINGS` | ✅ | ✅ | — | — | — |
| `media_server_analytics.view_live_activity` | `MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY` | ✅ | ✅ | — | — | — |
| `media_server_analytics.view_users` | `MEDIA_SERVER_ANALYTICS_VIEW_USERS` | ✅ | ✅ | — | — | — |
| `media_server_analytics.view_history` | `MEDIA_SERVER_ANALYTICS_VIEW_HISTORY` | ✅ | ✅ | — | — | — |
| `media_server_analytics.view_reports` | `MEDIA_SERVER_ANALYTICS_VIEW_REPORTS` | ✅ | ✅ | — | — | — |
| `media_server_analytics.export` | `MEDIA_SERVER_ANALYTICS_EXPORT` | ✅ | ✅ | — | — | — |
| `media_server_analytics.manage_newsletters` | `MEDIA_SERVER_ANALYTICS_MANAGE_NEWSLETTERS` | ✅ | ✅ | — | — | — |
| `media_server_analytics.send_newsletters` | `MEDIA_SERVER_ANALYTICS_SEND_NEWSLETTERS` | ✅ | ✅ | — | — | — |
| `media_server_analytics.manage_imports` | `MEDIA_SERVER_ANALYTICS_MANAGE_IMPORTS` | ✅ | ✅ | — | — | — |
| `media_server_analytics.run_imports` | `MEDIA_SERVER_ANALYTICS_RUN_IMPORTS` | ✅ | ✅ | — | — | — |
| `media_server_analytics.manage_settings` | `MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS` | ✅ | ✅ | — | — | — |
| `media_server_analytics.admin` | `MEDIA_SERVER_ANALYTICS_ADMIN` | ✅ | ✅ | — | — | — |

## `modules`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `modules.view` | `MODULES_VIEW` | ✅ | ✅ | — | — | — |
| `modules.manage` | `MODULES_MANAGE` | ✅ | ✅ | — | — | — |

## `release_scoring`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `release_scoring.view` | `RELEASE_SCORING_VIEW` | ✅ | ✅ | — | — | — |
| `release_scoring.manage` | `RELEASE_SCORING_MANAGE` | ✅ | ✅ | — | — | — |

## `roles`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `roles.manage` | `ROLES_MANAGE` | ✅ | ✅ | — | — | — |

## `rss`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `rss.view` | `RSS_VIEW` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `rss.manage` | `RSS_MANAGE` | ✅ | ✅ | ✅ | — | — |
| `rss.show_status.lookup` | `RSS_SHOW_STATUS_LOOKUP` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `rss.show_status.refresh` | `RSS_SHOW_STATUS_REFRESH` | ✅ | ✅ | ✅ | — | — |
| `rss.show_status.override` | `RSS_SHOW_STATUS_OVERRIDE` | ✅ | ✅ | ✅ | — | — |

## `settings`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `settings.view` | `SETTINGS_VIEW` | ✅ | ✅ | — | — | — |
| `settings.manage` | `SETTINGS_MANAGE` | ✅ | ✅ | — | — | — |
| `settings.manage_root_path` | `SETTINGS_MANAGE_ROOT_PATH` | ✅ | ✅ | — | — | — |

## `subtitle_intelligence`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `subtitle_intelligence.view` | `SUBTITLE_INTELLIGENCE_VIEW` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `subtitle_intelligence.search` | `SUBTITLE_INTELLIGENCE_SEARCH` | ✅ | ✅ | ✅ | ✅ | — |
| `subtitle_intelligence.download` | `SUBTITLE_INTELLIGENCE_DOWNLOAD` | ✅ | ✅ | ✅ | — | — |
| `subtitle_intelligence.synchronize` | `SUBTITLE_INTELLIGENCE_SYNCHRONIZE` | ✅ | ✅ | ✅ | — | — |
| `subtitle_intelligence.manage` | `SUBTITLE_INTELLIGENCE_MANAGE` | ✅ | ✅ | ✅ | — | — |
| `subtitle_intelligence.providers` | `SUBTITLE_INTELLIGENCE_PROVIDERS` | ✅ | ✅ | ✅ | — | — |
| `subtitle_intelligence.settings` | `SUBTITLE_INTELLIGENCE_SETTINGS` | ✅ | ✅ | ✅ | — | — |
| `subtitle_intelligence.admin` | `SUBTITLE_INTELLIGENCE_ADMIN` | ✅ | ✅ | — | — | — |

## `system`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `system.view` | `SYSTEM_VIEW` | ✅ | ✅ | ✅ | — | ✅ |
| `system.manage` | `SYSTEM_MANAGE` | ✅ | — | — | — | — |

## `tags`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `tags.manage` | `TAGS_MANAGE` | ✅ | ✅ | ✅ | ✅ | — |

## `torrents`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `torrents.view` | `TORRENTS_VIEW` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `torrents.add` | `TORRENTS_ADD` | ✅ | ✅ | ✅ | ✅ | — |
| `torrents.pause` | `TORRENTS_PAUSE` | ✅ | ✅ | ✅ | ✅ | — |
| `torrents.resume` | `TORRENTS_RESUME` | ✅ | ✅ | ✅ | ✅ | — |
| `torrents.start` | `TORRENTS_START` | ✅ | ✅ | ✅ | ✅ | — |
| `torrents.stop` | `TORRENTS_STOP` | ✅ | ✅ | ✅ | ✅ | — |
| `torrents.delete` | `TORRENTS_DELETE` | ✅ | ✅ | ✅ | — | — |
| `torrents.delete_data` | `TORRENTS_DELETE_DATA` | ✅ | ✅ | — | — | — |
| `torrents.recheck` | `TORRENTS_RECHECK` | ✅ | ✅ | ✅ | — | — |
| `torrents.manage_trackers` | `TORRENTS_MANAGE_TRACKERS` | ✅ | ✅ | ✅ | — | — |
| `torrents.manage_files` | `TORRENTS_MANAGE_FILES` | ✅ | ✅ | ✅ | — | — |
| `torrents.manage_limits` | `TORRENTS_MANAGE_LIMITS` | ✅ | ✅ | ✅ | — | — |
| `torrents.move` | `TORRENTS_MOVE` | ✅ | ✅ | ✅ | — | — |
| `torrents.rename` | `TORRENTS_RENAME` | ✅ | ✅ | ✅ | — | — |

## `users`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `users.view` | `USERS_VIEW` | ✅ | ✅ | — | — | — |
| `users.manage` | `USERS_MANAGE` | ✅ | ✅ | — | — | — |

## `workflows`

| Permission | Constant | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `workflows.view` | `WORKFLOWS_VIEW` | ✅ | ✅ | ✅ | — | — |
| `workflows.create` | `WORKFLOWS_CREATE` | ✅ | ✅ | — | — | — |
| `workflows.edit` | `WORKFLOWS_EDIT` | ✅ | ✅ | — | — | — |
| `workflows.delete` | `WORKFLOWS_DELETE` | ✅ | ✅ | — | — | — |
| `workflows.publish` | `WORKFLOWS_PUBLISH` | ✅ | ✅ | — | — | — |
| `workflows.run` | `WORKFLOWS_RUN` | ✅ | ✅ | ✅ | — | — |
| `workflows.approve` | `WORKFLOWS_APPROVE` | ✅ | ✅ | — | — | — |

## See also

- [Access Control (RBAC) for developers](/develop/rbac) — how guards consume these
- [Users & Roles](/modules/users) — assigning roles in the UI
- [Security hardening](/operate/security)
