# Media Server Analytics

A **core** UltraTorrent module (id `media_server_analytics`, route
`/api/media-server-analytics`, RBAC `media_server_analytics.*`) that turns your
connected media servers into monitoring, analytics, watch history, live activity,
newsletters, and historical-analytics migration. It is **media-server agnostic** —
every product-specific integration lives behind a provider.

> **Built by extending Media Manager's existing media-server integration**, not a
> parallel system. Connections, encrypted secrets, and the Plex/Jellyfin/Emby/Kodi
> provider layer are reused from `apps/backend/src/modules/media/`. See
> [MEDIA_MANAGER.md](MEDIA_MANAGER.md).

## Supported media servers

Behind the `MediaServerProvider` abstraction (`media/media-server-provider.ts`):

| Provider | Auth | Notes |
|---|---|---|
| Plex | `X-Plex-Token` | full capability set |
| Jellyfin | `X-Emby-Token` | full capability set |
| Emby | `X-Emby-Token` | full capability set |
| Kodi | JSON-RPC (optional basic auth) | client library — no section list / sessions; declares those capabilities `false` |

Each provider declares a **capability set** (`libraries`, `recentlyAdded`,
`sessions`, `watchHistory`, `refresh`). A capability a provider genuinely can't
serve returns a clean typed result (`UnsupportedCapabilityError` → a
`{ supported: false }` response) instead of a generic failure — analytics degrades
gracefully per server.

## Analytics import (Tautulli)

Tautulli is **not** a media server — it is a historical analytics/newsletter
**import** source, behind a separate `MediaAnalyticsImportProvider` abstraction.
See [TAUTULLI_IMPORT.md](TAUTULLI_IMPORT.md). *(Import lands in a later phase.)*

## Multi-server

Unlimited connections, multiple of the same type (e.g. "Plex Home" + "Plex
Remote"). Each stores name, type, base URL, encrypted token/credentials, enabled +
default flags, health status, server version, platform, capabilities, and notes —
reusing the `MediaServerIntegration` model (extended with the analytics fields).
Secrets are AES-256-GCM encrypted at rest (`SecretCipher`) and redacted from API
responses.

## API (Phase 1)

Under `/api/media-server-analytics`:

| Method + path | Permission | Purpose |
|---|---|---|
| `GET /dashboard` | `media_server_analytics.view` | Server counts + health + connection summaries. |
| `GET /connections` | `media_server_analytics.view` | List connections (secrets redacted). |
| `POST /connections` · `PATCH /connections/:id` · `DELETE /connections/:id` | `…manage_connections` | Connection CRUD. |
| `POST /connections/:id/test` | `…manage_connections` | Probe + persist health (status/version/platform/capabilities). |
| `POST /connections/:id/sync` | `…manage_connections` | Trigger a library refresh. |
| `GET /connections/:id/libraries` | `media_server_analytics.view` | List a server's libraries (capability-aware). |
| `GET /live` | `…view_live_activity` | Current now-playing sessions. |
| `POST /live/poll` | `…manage_connections` | Reconcile sessions now (also polled every 30s). |
| `GET /watch-history` | `…view_history` | Completed playback. |

## Live Activity & Watch History

A poller (`media_server_session_poll`, every 30s, active only when the module is
enabled and connections exist) fetches now-playing sessions from each server
(`getSessions` — Plex `/status/sessions`, Jellyfin/Emby `/Sessions`; Kodi is
unsupported and skipped) and reconciles them into `MediaServerSession` rows. When
a session disappears it is written to `MediaServerWatchHistory` (with
`watchedSeconds`), and `media_server.session.started/updated/ended` events fire.
This is the media-server-native watch-history source; Tautulli import is the other.

## Permissions

`media_server_analytics.` + `view`, `manage_connections`, `manage_mappings`,
`view_live_activity`, `view_users`, `view_history`, `view_reports`,
`manage_newsletters`, `send_newsletters`, `manage_imports`, `run_imports`,
`manage_settings`, `admin`. Enforced server-side (`@RequirePermissions`) and
frontend-side (nav/route gating). Auto-synced to the `Permission` table at boot.

## Roadmap

Phase 1 (this) delivers the module foundation: registration, the extended
capability-aware provider (`getServerInfo` / `getLibraries`), secure multi-server
connection management, and Dashboard + Connections pages. Later phases:

- ~~Live Activity~~ ✅ (Phase 2) — now-playing sessions + `MediaServerSession`.
- ~~Watch History~~ ✅ (Phase 2) — captured on session end + `MediaServerWatchHistory`.
- **Recently Added / Library / User / Playback analytics** + snapshots.
- **Newsletters** — a full SMTP email + scheduled-newsletter system (net-new; no
  email infrastructure exists today).
- **Tautulli import** — `MediaAnalyticsImportProvider` + import job engine
  (preview, validation, mapping, duplicate handling, resume, incremental sync).
- **Automation triggers/actions**, notifications, and the remaining UI pages.
