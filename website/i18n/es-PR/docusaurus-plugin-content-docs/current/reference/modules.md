---
id: modules
title: Referencia de módulos
sidebar_position: 3
description: Cada módulo de UltraTorrent, su tier, dependencias, permisos y rutas.
keywords: [modules, registry, manifest, dependencies, core, community]
---

# Referencia de módulos

:::info Generado automáticamente
Esta página se genera desde `apps/backend/src/modules/module-registry/manifests.ts` durante el build. **No la edites a mano** — cambia la fuente y reconstruye. Esto garantiza que la referencia siempre coincida con el código que se publica.
:::

UltraTorrent está construido como un **registro de módulos**. Cada módulo declara un manifiesto — su id,
tier, dependencias, los permisos que introduce y las rutas de API que le pertenecen. El
registro resuelve el grafo de dependencias al arrancar y se niega a iniciar ante una
dependencia desconocida o circular, así que un módulo roto nunca puede quedar a medio cargar.

- **23 módulos** en los tiers: `core`, `community`
- Los módulos **core** siempre están activos. Los módulos **community/opcionales** se pueden activar o desactivar.

## Grafo de dependencias

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

## Todos los módulos

| Módulo | Id | Tier | Activo por defecto | Depende de |
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

## Autenticación

`auth` · tier `core` · activo por defecto

Inicio de sesión, sesiones, rotación del refresh token.

**Rutas propias:** `/api/auth`

## Control de acceso (RBAC)

`rbac` · tier `core` · activo por defecto

Roles, permisos y guards de ruta.

**Depende de:** `auth`

**Introduce permisos:** `roles.manage`

## Cuenta y seguridad

`account` · tier `core` · activo por defecto

Perfil de autoservicio, contraseña y 2FA.

**Depende de:** `auth`

**Rutas propias:** `/api/account`

## Usuarios

`users` · tier `core` · activo por defecto

Gestión de usuarios y asignación de roles.

**Depende de:** `auth`, `rbac`

**Introduce permisos:** `users.view`, `users.manage`

**Rutas propias:** `/api/users`

## Motor de torrents

`engine` · tier `core` · activo por defecto

Abstracción del proveedor de motor (rTorrent) + registro.

**Depende de:** `auth`

**Introduce permisos:** `system.view`, `engines.manage`

**Rutas propias:** `/api/engines`

## Panel

`dashboard` · tier `core` · activo por defecto

Estadísticas agregadas y actividad reciente.

**Depende de:** `auth`, `engine`

**Introduce permisos:** `torrents.view`

**Rutas propias:** `/api/dashboard`

## Torrents

`torrents` · tier `core` · activo por defecto

Lista de torrents, detalle, ciclo de vida, acciones masivas.

**Depende de:** `auth`, `engine`

**Introduce permisos:** `torrents.view`, `torrents.add`, `torrents.delete`

**Rutas propias:** `/api/torrents`

## Búsqueda

`search` · tier `core` · activo por defecto

Busca en las instantáneas de torrents guardadas.

**Depende de:** `auth`

**Introduce permisos:** `torrents.view`

**Rutas propias:** `/api/search`

## Categorías y etiquetas

`taxonomy` · tier `core` · activo por defecto

Organiza los torrents con categorías y etiquetas.

**Depende de:** `auth`

**Introduce permisos:** `categories.manage`, `tags.manage`

**Rutas propias:** `/api/categories`, `/api/tags`

## Automatización RSS

`rss` · tier `core` · activo por defecto

Feeds, candidatos de coincidencia rankeados, y el Constructor de Coincidencias Inteligentes.

**Depende de:** `auth`, `engine`

**Introduce permisos:** `rss.view`, `rss.manage`, `rss.show_status.lookup`, `rss.show_status.refresh`, `rss.show_status.override`

**Rutas propias:** `/api/rss`

## Automatización

`automation` · tier `core` · activo por defecto

Motor de reglas de disparador/condición/acción.

**Depende de:** `auth`, `engine`

**Introduce permisos:** `automation.view`, `automation.manage`

**Rutas propias:** `/api/automation`

## Gestor de archivos

`files` · tier `core` · activo por defecto

Navegación segura por rutas y operaciones de archivos.

**Depende de:** `auth`

**Introduce permisos:** `files.view`, `files.manage`

**Rutas propias:** `/api/files`

## Claves API

`api_keys` · tier `core` · activo por defecto

Emisión/listado/revocación de claves API personales.

**Depende de:** `auth`

**Introduce permisos:** `apikeys.manage`

**Rutas propias:** `/api/api-keys`

## Registro de auditoría

`audit` · tier `core` · activo por defecto

Rastro de auditoría de solo-anexado de las acciones sensibles.

**Depende de:** `auth`

**Introduce permisos:** `audit.view`

**Rutas propias:** `/api/audit`

## Salud del sistema

`system` · tier `core` · activo por defecto

Sondas de liveness/readiness e informes de salud.

**Introduce permisos:** `system.view`

**Rutas propias:** `/api/system`

## Configuración

`settings` · tier `core` · activo por defecto

Configuración de la aplicación en pares clave/valor.

**Depende de:** `auth`

**Introduce permisos:** `settings.view`, `settings.manage`

**Rutas propias:** `/api/settings`

## Registro de módulos

`module_registry` · tier `core` · activo por defecto

Activa/desactiva módulos opcionales.

**Depende de:** `auth`, `rbac`

**Introduce permisos:** `modules.view`, `modules.manage`

**Rutas propias:** `/api/modules`

## Gestor de Medios

`media_manager` · tier `community` · activo por defecto

Escanea, identifica, enriquece y organiza tus bibliotecas de medios: escaneo de bibliotecas, identificación por nombre de archivo, metadatos/carátulas/subtítulos, detección de duplicados, generación de NFO, renombrado/movimiento para servidores de medios, y un panel de salud.

**Depende de:** `auth`, `files`

**Introduce permisos:** `media_manager.view`, `media_manager.manage_libraries`, `media_manager.scan`, `media_manager.match`, `media_manager.edit_metadata`, `media_manager.manage_artwork`, `media_manager.manage_subtitles`, `media_manager.rename`, `media_manager.move_files`, `media_manager.generate_nfo`, `media_manager.manage_integrations`, `media_manager.delete`, `media_manager.admin`, `media_manager.imdb.view`, `media_manager.imdb.configure`, `media_manager.imdb.import_dataset`, `media_manager.imdb.search`, `media_manager.imdb.match`

**Rutas propias:** `/api/media`

## Puntuación de Releases

`release_scoring` · tier `community` · activo por defecto

Puntuación explicable de 0 a 100 de los releases de RSS, con razones, advertencias y una recomendación.

**Depende de:** `auth`, `rss`

**Introduce permisos:** `release_scoring.view`, `release_scoring.manage`

**Rutas propias:** `/api/release-scoring`

## Inteligencia de Adquisición de Medios

`media_acquisition_intelligence` · tier `community` · activo por defecto

Decide qué medios adquirir a partir de huecos en la biblioteca, calidad del release, riesgo de duplicados, listas de seguimiento, perfiles de adquisición y contexto de automatización — decisiones explicables, nunca operaciones directas sobre archivos.

**Depende de:** `auth`, `rbac`, `module_registry`, `audit`, `settings`, `rss`, `automation`, `release_scoring`

**Introduce permisos:** `media_acquisition.view`, `media_acquisition.manage_watchlist`, `media_acquisition.manage_profiles`, `media_acquisition.evaluate`, `media_acquisition.approve`, `media_acquisition.reject`, `media_acquisition.override`, `media_acquisition.history`, `media_acquisition.export`, `media_acquisition.settings`

**Rutas propias:** `/api/media-acquisition`

## Analíticas del Servidor de Medios

`media_server_analytics` · tier `core` · activo por defecto

Monitoreo y analíticas del servidor de medios, añadidos recientemente, historial de reproducción, actividad en vivo, estadísticas de usuarios/bibliotecas, boletines programados, e importación de analíticas de Tautulli — en Plex, Jellyfin, Emby y Kodi.

**Depende de:** `auth`, `rbac`, `module_registry`, `audit`, `settings`, `media_manager`, `automation`

**Introduce permisos:** `media_server_analytics.view`, `media_server_analytics.manage_connections`, `media_server_analytics.manage_mappings`, `media_server_analytics.view_live_activity`, `media_server_analytics.view_users`, `media_server_analytics.view_history`, `media_server_analytics.view_reports`, `media_server_analytics.export`, `media_server_analytics.manage_newsletters`, `media_server_analytics.send_newsletters`, `media_server_analytics.manage_imports`, `media_server_analytics.run_imports`, `media_server_analytics.manage_settings`, `media_server_analytics.admin`

**Rutas propias:** `/api/media-server-analytics`

## Subtitle Intelligence

`subtitle_intelligence` · tier `core` · activo por defecto

The definitive subtitle engine: fingerprints every media file (movie hash + technical metadata), searches multiple providers with a progressively-relaxed strategy (hash → release → external id → title), scores and validates each candidate, installs the best as a media-server-correct sidecar (never overwriting an original), and can synchronize it to the audio. Per-library language policy, automation, and background monitoring.

**Depende de:** `auth`, `rbac`, `files`, `audit`, `settings`, `media_manager`

**Introduce permisos:** `subtitle_intelligence.view`, `subtitle_intelligence.search`, `subtitle_intelligence.download`, `subtitle_intelligence.synchronize`, `subtitle_intelligence.manage`, `subtitle_intelligence.providers`, `subtitle_intelligence.settings`, `subtitle_intelligence.admin`

**Rutas propias:** `/api/subtitle-intelligence`

## Library Cleanup Center

`library_cleanup` · tier `core` · activo por defecto

Policy-driven reclamation of library storage. Users build versioned cleanup policies from a catalogue of metadata, playback, technical, storage and safety conditions; a run turns matches into CANDIDATES, never deletions. Nothing is removed except through a persisted, approved plan whose per-file fingerprints still match the world, and protected, locked, actively-playing, in-flight, ambiguous or unmeasured files are refused server-side. Removal goes to quarantine or Trash through the existing path-safe file services; permanent deletion is a manual, separately-permissioned operation.

**Depende de:** `auth`, `rbac`, `files`, `audit`, `settings`, `media_manager`

**Introduce permisos:** `library_cleanup.view`, `library_cleanup.policy.create`, `library_cleanup.policy.edit`, `library_cleanup.policy.publish`, `library_cleanup.policy.enable`, `library_cleanup.policy.delete`, `library_cleanup.run`, `library_cleanup.simulate`, `library_cleanup.approve`, `library_cleanup.cancel`, `library_cleanup.protection.view`, `library_cleanup.protection.create`, `library_cleanup.protection.revoke`, `library_cleanup.protection.legal_hold`, `library_cleanup.trash`, `library_cleanup.restore`, `library_cleanup.permanent_delete`, `library_cleanup.settings`, `library_cleanup.audit`

**Rutas propias:** `/api/media/cleanup`

## Ver también

- [Referencia de permisos](/reference/permissions)
- [Referencia de la API REST](/reference/api)
- [Escribir un módulo](/develop/creating-modules)
