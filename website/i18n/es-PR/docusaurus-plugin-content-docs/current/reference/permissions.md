---
id: permissions
title: Referencia de permisos
sidebar_position: 2
description: Cada permiso RBAC de UltraTorrent y qué rol integrado lo tiene.
keywords: [permissions, rbac, roles, access control, authorization, security]
---

# Referencia de permisos

:::info Generado automáticamente
Esta página se genera desde `packages/shared/src/permissions.ts` durante el build. **No la edites a mano** — cambia la fuente y reconstruye. Esto garantiza que la referencia siempre coincida con el código que se publica.
:::

UltraTorrent usa **permisos granulares con espacios de nombres por punto** (`domain.action`). Los roles son
simplemente conjuntos con nombre de esos permisos. Tanto los guards de ruta del backend (`@RequirePermissions`) como las comprobaciones
de capacidades del frontend leen este mismo catálogo, así que lo que ves aquí es
exactamente lo que se aplica.

- **116 permisos** en **22 dominios**
- **5 roles integrados**

## Cómo leer esto

- Un **✅** significa que el rol tiene ese permiso de fábrica.
- Los roles son acumulativos en la práctica pero **no** por herencia — el conjunto de cada rol
  es explícito, así que siempre puedes ver con precisión lo que puede hacer.
- Los roles personalizados se construyen a partir del mismo catálogo. Ver [Control de acceso](/develop/rbac).

## Resumen de roles

| Rol | Permisos que tiene |
| --- | --- |
| `SUPER_ADMIN` | 116 of 116 |
| `ADMINISTRATOR` | 115 of 116 |
| `POWER_USER` | 58 of 116 |
| `USER` | 18 of 116 |
| `READ_ONLY` | 9 of 116 |

## `apikeys`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `apikeys.manage` | `APIKEYS_MANAGE` | ✅ | ✅ | — | — | — |

## `audit`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `audit.view` | `AUDIT_VIEW` | ✅ | ✅ | — | — | — |

## `automation`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `automation.view` | `AUTOMATION_VIEW` | ✅ | ✅ | ✅ | — | ✅ |
| `automation.manage` | `AUTOMATION_MANAGE` | ✅ | ✅ | ✅ | — | — |

## `categories`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `categories.manage` | `CATEGORIES_MANAGE` | ✅ | ✅ | ✅ | ✅ | — |

## `engines`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `engines.manage` | `ENGINES_MANAGE` | ✅ | ✅ | — | — | — |

## `files`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
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

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `indexers.view` | `INDEXERS_VIEW` | ✅ | ✅ | ✅ | — | — |
| `indexers.manage` | `INDEXERS_MANAGE` | ✅ | ✅ | ✅ | — | — |
| `indexers.test` | `INDEXERS_TEST` | ✅ | ✅ | ✅ | — | — |

## `integrations`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `integrations.prowlarr.view` | `INTEGRATIONS_PROWLARR_VIEW` | ✅ | ✅ | ✅ | — | — |
| `integrations.prowlarr.manage` | `INTEGRATIONS_PROWLARR_MANAGE` | ✅ | ✅ | ✅ | — | — |
| `integrations.prowlarr.test` | `INTEGRATIONS_PROWLARR_TEST` | ✅ | ✅ | ✅ | — | — |
| `integrations.prowlarr.open` | `INTEGRATIONS_PROWLARR_OPEN` | ✅ | ✅ | ✅ | — | — |

## `media_acquisition`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
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

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
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

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `media_renamer.view` | `MEDIA_RENAMER_VIEW` | ✅ | ✅ | — | — | — |
| `media_renamer.preview` | `MEDIA_RENAMER_PREVIEW` | ✅ | ✅ | — | — | — |
| `media_renamer.execute` | `MEDIA_RENAMER_EXECUTE` | ✅ | ✅ | — | — | — |
| `media_renamer.rollback` | `MEDIA_RENAMER_ROLLBACK` | ✅ | ✅ | — | — | — |
| `media_renamer.manage_templates` | `MEDIA_RENAMER_MANAGE_TEMPLATES` | ✅ | ✅ | — | — | — |

## `media_server_analytics`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
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

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `modules.view` | `MODULES_VIEW` | ✅ | ✅ | — | — | — |
| `modules.manage` | `MODULES_MANAGE` | ✅ | ✅ | — | — | — |

## `notifications`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `notifications.manage` | `NOTIFICATIONS_MANAGE` | ✅ | ✅ | — | — | — |
| `notifications.view` | `NOTIFICATIONS_VIEW` | ✅ | ✅ | ✅ | ✅ | — |
| `notifications.manage_channels` | `NOTIFICATIONS_MANAGE_CHANNELS` | ✅ | ✅ | — | — | — |
| `notifications.manage_templates` | `NOTIFICATIONS_MANAGE_TEMPLATES` | ✅ | ✅ | — | — | — |
| `notifications.manage_rules` | `NOTIFICATIONS_MANAGE_RULES` | ✅ | ✅ | — | — | — |
| `notifications.manage_recipients` | `NOTIFICATIONS_MANAGE_RECIPIENTS` | ✅ | ✅ | — | — | — |
| `notifications.manage_groups` | `NOTIFICATIONS_MANAGE_GROUPS` | ✅ | ✅ | — | — | — |
| `notifications.view_history` | `NOTIFICATIONS_VIEW_HISTORY` | ✅ | ✅ | — | — | — |
| `notifications.retry` | `NOTIFICATIONS_RETRY` | ✅ | ✅ | — | — | — |
| `notifications.send_test` | `NOTIFICATIONS_SEND_TEST` | ✅ | ✅ | — | — | — |
| `notifications.manage_preferences` | `NOTIFICATIONS_MANAGE_PREFERENCES` | ✅ | ✅ | ✅ | ✅ | — |
| `notifications.manage_settings` | `NOTIFICATIONS_MANAGE_SETTINGS` | ✅ | ✅ | — | — | — |
| `notifications.admin` | `NOTIFICATIONS_ADMIN` | ✅ | ✅ | — | — | — |

## `release_scoring`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `release_scoring.view` | `RELEASE_SCORING_VIEW` | ✅ | ✅ | — | — | — |
| `release_scoring.manage` | `RELEASE_SCORING_MANAGE` | ✅ | ✅ | — | — | — |

## `roles`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `roles.manage` | `ROLES_MANAGE` | ✅ | ✅ | — | — | — |

## `rss`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `rss.view` | `RSS_VIEW` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `rss.manage` | `RSS_MANAGE` | ✅ | ✅ | ✅ | — | — |
| `rss.show_status.lookup` | `RSS_SHOW_STATUS_LOOKUP` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `rss.show_status.refresh` | `RSS_SHOW_STATUS_REFRESH` | ✅ | ✅ | ✅ | — | — |
| `rss.show_status.override` | `RSS_SHOW_STATUS_OVERRIDE` | ✅ | ✅ | ✅ | — | — |

## `settings`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `settings.view` | `SETTINGS_VIEW` | ✅ | ✅ | — | — | — |
| `settings.manage` | `SETTINGS_MANAGE` | ✅ | ✅ | — | — | — |
| `settings.manage_root_path` | `SETTINGS_MANAGE_ROOT_PATH` | ✅ | ✅ | — | — | — |

## `system`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `system.view` | `SYSTEM_VIEW` | ✅ | ✅ | ✅ | — | ✅ |
| `system.manage` | `SYSTEM_MANAGE` | ✅ | — | — | — | — |

## `tags`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `tags.manage` | `TAGS_MANAGE` | ✅ | ✅ | ✅ | ✅ | — |

## `torrents`

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
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

| Permiso | Constante | SUPER ADMIN | ADMINISTRATOR | POWER USER | USER | READ ONLY |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| `users.view` | `USERS_VIEW` | ✅ | ✅ | — | — | — |
| `users.manage` | `USERS_MANAGE` | ✅ | ✅ | — | — | — |

## Ver también

- [Control de acceso (RBAC) para desarrolladores](/develop/rbac) — cómo los guards los consumen
- [Usuarios y Roles](/modules/users) — asignar roles en la interfaz
- [Endurecimiento de seguridad](/operate/security)
