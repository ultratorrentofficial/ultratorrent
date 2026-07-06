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
| `GET /reports/usage` · `/reports/users` · `/reports/libraries` · `/reports/playback` | `…view_reports` | Analytics aggregations. |
| `GET /users` | `…view_users` | Per-user activity. |
| `GET /recently-added` | `media_server_analytics.view` | Newest library media (from Media Manager). |

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
- ~~Recently Added / Library / User / Playback analytics~~ ✅ (Phase 3) — computed
  on demand from watch history + the Media Manager library. Snapshot persistence
  (for long-range trends) remains.
- ~~Newsletters~~ ✅ (Phase 5) — a net-new SMTP email service (`nodemailer`, config
  in the `Setting` store with the password encrypted), scheduled newsletter
  campaigns of recently-added media (responsive HTML + plain-text, preview, test
  send, send now, delivery tracking, a 15-min dispatch scheduler). Subscription
  management + Tautulli newsletter import remain.

  **Newsletter template** (`newsletter-render.ts`, pure/unit-tested): an original
  dark "media digest" email built from tables + inline styles (plus a mobile media
  query) for broad email-client support. Structure:
  - **Header** — UT icon, `ULTRATORRENT NEWSLETTER`, the default connected media
    server's name, the date range (`YYYY-MM-DD - YYYY-MM-DD`), and an amber divider.
  - **Sections (per content type, Tautulli-style)** — `buildContent()` splits the
    recently-added items into **one section per content-type group** present
    (`NEWSLETTER_GROUPS`: TV/anime/episode → *TV Shows*, movie → *Movies*,
    music_video/music/concert → *Music & Concerts*, documentary → *Documentaries*,
    other_video/other → *Recently Added*). **Episodic groups collapse into show
    cards** — episodes are grouped by show via `groupShows()` and the summary reads
    "N Shows / M Episodes" (never a flat per-episode list); every non-episodic group
    renders as a poster grid with an "N Movies" / "N Items" summary. Empty groups are
    omitted, and section order follows `NEWSLETTER_GROUPS`. Section headers show a
    per-type icon + title + amber count numbers. A newsletter can be **scoped to a
    subset of types** via `contentSections` — the service filters the media query by
    the selected groups' `mediaType`s (an empty selection means all types), so a
    "TV Shows" newsletter only ever contains grouped shows, a "Movies" one only
    movies, etc.
  - **TV cards** — poster on the left, title, episode count, season/episode range,
    overview, metadata badges (year · seasons · runtime · genres · library) bottom-left,
    and a **5-star rating** bottom-right (`renderRating()` normalizes the 0–10 provider
    rating to 5 stars, omitted when unrated). Two-column grid on desktop → one column on mobile.
  - **Movie grid** — poster cards (poster, title, year · runtime, stars) in a
    responsive two-up grid.
  - **Footer** — three areas: unsubscribe (left), brand + tagline + instance URL
    (center), preferences (right).

  Accent `#f5a623`; 720px centered container. **Poster fallback:** the Media
  Manager poster (server / imported / metadata-provider artwork all land in
  `MediaArtwork`) is attached as a **CID inline image** (no public/authenticated
  URL leaves the server, no remote tracking); a missing poster degrades to a
  gradient-initial placeholder — the layout never breaks. **Sample data** renders
  in the preview when the library has no new items, and the Newsletters page offers
  a **desktop/mobile** preview toggle. All template text is localized via
  `newsletter-strings.ts` (`en-US` + `es-PR`); a plain-text alternative is always
  generated. Style toggles (ratings / genres / runtime / overview / library badges,
  accent, max items per section) are supported via `RenderOptions.style` with the
  reference-matching defaults.
- ~~Tautulli import~~ ✅ (Phase 4, watch history) — `MediaAnalyticsImportProvider`
  + a background import job with preview, duplicate-safe streaming, and progress.
  See [TAUTULLI_IMPORT.md](TAUTULLI_IMPORT.md). Users/libraries/statistics/
  newsletter import, mapping, and incremental sync remain.
- **Automation triggers/actions**, notifications, and the remaining UI pages.
