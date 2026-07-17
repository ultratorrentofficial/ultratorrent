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
**Watch-history import has shipped** (import sources, test, preview, and a
background import job under `/import-sources` + `/import-jobs`); users,
libraries, statistics and newsletter import are still to come. See
[TAUTULLI_IMPORT.md](TAUTULLI_IMPORT.md).

## Multi-server

Unlimited connections, multiple of the same type (e.g. "Plex Home" + "Plex
Remote"). Each stores name, type, base URL, encrypted token/credentials, enabled +
default flags, health status, server version, platform, capabilities, and notes —
reusing the `MediaServerIntegration` model (extended with the analytics fields).
Secrets are AES-256-GCM encrypted at rest (`SecretCipher`) and redacted from API
responses.

## API

Under `/api/media-server-analytics`:

| Method + path | Permission | Purpose |
|---|---|---|
| `GET /dashboard` | `media_server_analytics.view` | Server counts + health + connection summaries. |
| `GET /connections` · `GET /connections/:id` | `media_server_analytics.view` | List/read connections (secrets redacted). |
| `POST /connections` · `PATCH /connections/:id` · `DELETE /connections/:id` | `…manage_connections` | Connection CRUD. |
| `POST /connections/:id/test` | `…manage_connections` | Probe + persist health (status/version/platform/capabilities). |
| `POST /connections/:id/sync` | `…manage_connections` | Trigger a library refresh. |
| `GET /connections/:id/libraries` | `media_server_analytics.view` | List a server's libraries (capability-aware). |
| `GET /live` | `…view_live_activity` | Current now-playing sessions. |
| `GET /live/:id/artwork` | `…view_live_activity` | Proxy a session's poster. |
| `POST /live/poll` | `…manage_connections` | Reconcile sessions now (also polled every 15s). |
| `GET /watch-history` | `…view_history` | Completed playback. |
| `GET /reports/usage` · `/users` · `/libraries` · `/playback` · `/top-media` · `/devices` · `/heatmap` · `/trends` · `/resolutions` · `/library-growth` · `/bandwidth` | `…view_reports` | Analytics aggregations. |
| `GET /export/watch-history` | `…export` | Export watch history. |
| `GET /meta/libraries` · `/meta/users` | `media_server_analytics.view` | Synced library/user entities (dashboard filters). |
| `GET /meta/sync-runs` | `…view_reports` | Metadata-sync run history. |
| `POST /meta/sync` | `…manage_connections` | Run the metadata sync now (also hourly). |
| `GET /users` | `…view_users` | Per-user activity. |
| `GET /recently-added` | `media_server_analytics.view` | Newest library media (from Media Manager). |
| `GET/POST /import-sources` · `GET/PATCH/DELETE /import-sources/:id` · `POST /import-sources/:id/test` · `/preview` | `…manage_imports` | Tautulli import sources ([TAUTULLI_IMPORT.md](TAUTULLI_IMPORT.md)). |
| `POST /import-sources/:id/import` | `…run_imports` | Start an import. |
| `GET /import-jobs` · `/import-jobs/:id` | `…manage_imports` | Import job history + progress. |
| `GET/POST /newsletters` · `GET/PATCH/DELETE /newsletters/:id` · `POST /newsletters/:id/preview` · `GET /newsletters/:id/deliveries` | `…manage_newsletters` | Newsletter campaigns + delivery tracking. |
| `GET /newsletters/recipient-options` · `PATCH /newsletters/recipient-options/:userId` | `…manage_newsletters` | Synced users for the recipient picker; PATCH sets a user's email by hand (servers whose accounts carry none). |
| `POST /newsletters/:id/test-send` · `/send-now` | `…send_newsletters` | Send a test / send now. |
| `GET/PATCH /settings/email` · `POST /settings/email/test` | `…manage_settings` | SMTP config (password encrypted). |
| `GET/PATCH /settings/newsletter-images` | `…manage_settings` | Poster-hosting mode (see below). |

`GET /api/media-server-analytics/nl-image/:artworkId` is the one **unguarded**
route (a separate `NewsletterImageController`) — mail clients can't send a bearer
token, so access is gated by an HMAC-signed, expiring token instead.

## Live Activity & Watch History

A poller (`media_server_session_poll`, every 15s, active only when the module is
enabled and connections exist) fetches now-playing sessions from each server
(`getSessions` — Plex `/status/sessions`, Jellyfin/Emby `/Sessions`; Kodi is
unsupported and skipped) and reconciles them into `MediaServerSession` rows. When
a session disappears it is written to `MediaServerWatchHistory` (with
`watchedSeconds`), and `media_server.session.started/updated/ended` events fire.
This is the media-server-native watch-history source; Tautulli import is the other.

The poller also publishes onto the Notification Center's event bus
(`media_server.user_started_watching` / `user_finished_watching` /
`transcode_detected`), as does the newsletter dispatcher
(`newsletter_sent` / `newsletter_failed`) — see
[NOTIFICATION_CENTER.md](NOTIFICATION_CENTER.md).

## Metadata sync

A second job (`media_server_metadata_sync`, hourly and on demand via `POST
/meta/sync`) normalizes provider metadata into queryable entities so the
dashboard filters are backed by real rows: **libraries** are pulled from each
connection's provider (capability-aware) into `MediaServerLibrary`, and **users**
are derived from durable watch history into `MediaServerUser` (provider-agnostic,
so Tautulli-imported history with no live connection still yields users). The user
sweep also pulls each connection's **provider account list** (`provider.getUsers`):
this adds users who have never watched anything and fills in `MediaServerUser.email`
where the server holds one — Plex accounts do (fetched from plex.tv `/api/users` +
the owner), while Jellyfin/Emby user models have none, so their email stays null
until an admin enters one via the newsletter recipient picker. A hand-entered email
is never overwritten by a later sync (email is only written when the row has none).
Every run is recorded as a `MediaProviderSyncRun`; one bad server never aborts the sweep.

## Permissions

`media_server_analytics.` + `view`, `manage_connections`, `manage_mappings`,
`view_live_activity`, `view_users`, `view_history`, `view_reports`, `export`,
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

  Accent `#f5a623`; 720px centered container. Backgrounds are set with both CSS
  `background-color` **and** `bgcolor` attributes so the dark canvas holds in
  clients that ignore CSS on `<body>`/tables (Gmail, Outlook). Cards are laid out
  with the panel on the row **cell** (not a nested table) so paired cards render at
  equal height (Gmail/Outlook honour equal-height sibling cells, unlike
  `height:100%` on a nested table).

  **Poster hosting is admin-selectable** (`NewsletterImageService`, Settings →
  *Newsletter poster images*, stored in the `Setting` store). Posters are always
  downscaled to a ~240px JPEG (via `sharp`) first, then delivered per the chosen
  mode:
  - **Embed (`attach`, default)** — a **CID inline attachment** (self-contained, no
    remote fetch); Gmail lists these in the attachment strip.
  - **Serve from this instance (`self_hosted`)** — a **signed, expiring, public
    image URL** (`GET /api/media-server-analytics/nl-image/:artworkId?e&s`, served by
    `NewsletterImageController` — a separate **unguarded** controller since mail
    clients can't send a bearer token; access is gated by an HMAC-SHA256 token over
    `(artworkId, expiry)` and it only ever serves a downscaled `MediaArtwork` by id,
    never an arbitrary path). No attachments; requires the instance to be reachable
    at the configured **public base URL**.
  - **External host (`external`)** — uploads the downscaled poster to Imgur (client
    id stored **encrypted**) and links the returned URL. No attachments; works even
    if the instance is private. Any mode with missing config silently degrades to
    `attach` so a send never produces broken images. A missing poster degrades to a
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
- ~~Notifications~~ ✅ — the session poller and newsletter dispatcher publish
  `media_server.*` events onto the Notification Center bus.
- ~~UI pages~~ ✅ — Dashboard, Connections, Live Activity, Watch History,
  Recently Added, Reports, Import, Newsletters.
- **Automation triggers/actions** — still to come: the automation catalog
  registers no `media_server.*` trigger or action yet.
