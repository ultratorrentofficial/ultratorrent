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
| `POST /sessions/:id/terminate` | `…sessions.terminate` | Administratively stop a live session (Concurrent Stream Control). |
| `GET/PATCH /stream-control/settings` | `…stream_limits.read` / `…manage` | Global Stream Control defaults. |
| `GET /stream-control/policies[/:mediaUserId]` | `…stream_limits.read` | Per-user limit roster / one subject. |
| `PUT/DELETE /stream-control/policies/:mediaUserId` · `PATCH /policies/:mediaUserId/exempt` | `…stream_limits.manage` | Set/clear a user's override; toggle exempt. |
| `POST /stream-control/link` · `POST /policies/:mediaUserId/unlink` | `…stream_limits.manage` | Link accounts as one person / unlink. |
| `GET /stream-control/status` · `/stream-control/events` | `…enforcement.read` | Live enforcement state / enforcement history. |
| `GET /household/{overview,users[/:id],reviews,networks,settings}` | `…household.read` | Household & Sharing read views. |
| `PUT /household/settings` · `POST /household/users/:id/{set-home,lock-home,unlock-home,relearn}` · `/household/networks/:id/{trust,ignore,classification,disposition}` | `…household.manage` | Home + network config. |
| `POST /household/reviews/:id/disposition` | `…household.review` | Disposition a review case. |
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

The poller also used to publish onto the notification event bus
(`media_server.user_started_watching` / `user_finished_watching` /
`transcode_detected`), as did the newsletter dispatcher
(`newsletter_sent` / `newsletter_failed`). **Those emitters were removed on
2026-07-25** with the notification engine and its event bus — nothing publishes
them today.

## Concurrent Stream Control

Native, provider-agnostic control over playback sessions: manual termination,
automatic per-user/global concurrent-stream limits, and cross-product identity
linking so one person's Plex **and** Jellyfin streams count together.

- **Provider capability.** `MediaServerCapabilities.terminateSessions` and
  `MediaServerProvider.terminateSession(cfg, sessionId, options?)` are the single
  boundary that knows how to stop a stream: **Plex** (`/status/sessions/terminate`,
  the message becomes the client-visible reason), **Jellyfin/Emby**
  (`POST /Sessions/{id}/Playing/Stop`, preceded by a best-effort on-screen message).
  **Kodi cannot terminate** — it throws `UnsupportedCapabilityError` and the UI
  shows **"Monitoring only — session termination is not supported by this
  provider."** A provider that can't terminate, or a terminate that fails, is
  **never** treated as the server being unhealthy.
- **Manual stop.** `POST /sessions/:id/terminate` (permission
  `media_server_analytics.sessions.terminate`) resolves the provider-native id
  from the `MediaServerSession` row and delegates to the provider. In **Live
  Activity**, a capable session shows a confirm-gated **Terminate stream** action;
  the acting admin, target, and outcome are written to the audit log
  (`media_server_analytics.session.terminated`).
- **Realtime.** The outcome broadcasts `media_server.stream.terminated` /
  `media_server.stream.termination_failed` (scoped to analytics-view holders), so
  every open Live Activity view updates without a refresh.

### Automatic enforcement

- **Canonical subject.** `MediaAnalyticsUser` is one row per `(product kind,
  stable providerUserId)`. Plex account ids are global, so one Plex account across
  several Plex servers is **one** subject and its streams count together; Jellyfin
  and Emby ids are per-server, so they stay separate. Accounts are **never**
  auto-merged across products — that is a manual admin action (a later phase).
- **Global defaults** live in **Media Server Analytics → Stream Control** (settings
  key `media_server_analytics.stream_control`): a master **enabled** switch (off by
  default — nothing is enforced until an admin turns it on), a default limit
  (unlimited or 1–100), the action when a limit is exceeded (terminate newest /
  oldest / warn / log), a grace period (0–300s), whether paused sessions count (and
  when they expire), and the scope (across all servers, or per server).
- **Per-user overrides** live in **Stream Limits**, which lists **only** the
  viewers an admin has deliberately configured — not everyone. **Add user** picks a
  known viewer and grants an override: unlimited / custom, an optional action &
  scope override, or an **exempt** toggle (the admin bypass, preferred over a huge
  number). Clearing an override ("use global default") drops the viewer from the
  list. Effective policy resolves per the priority per-user+server → per-user →
  per-server → global. (The enforcement engine still auto-provisions internal
  subjects for counting; those never appear in the list until configured.)
- **The engine** (`StreamEnforcementService`, a 5s interval) reuses the poller's
  `MediaServerSession` rows — it never re-polls the providers. It counts a subject's
  active streams, waits out the grace period, then terminates exactly the excess
  (newest or oldest by start time) via `provider.terminateSession`, recording a
  `MediaStreamEnforcementEvent` and broadcasting `media_server.stream_limit.exceeded`
  / `stream.termination_requested|terminated|termination_failed`.
- **Safety.** Enforcement never terminates when it is disabled, the user is
  unlimited/exempt, the provider cannot terminate, the server is not `online`, the
  session data is stale, or the identity cannot be resolved — it records and skips.
- **Concurrency.** A `DistributedLockService` (Redis `SET NX PX`, with an
  in-process fallback when Redis is absent) makes enforcement single-flight per
  subject across replicas; every termination re-checks the session is still active
  and still over the limit before acting (idempotent).
- **Enforcement History** (a filterable table) is the operational record; it is
  separate from the audit log, which records admin configuration changes.
- **Cross-product linking.** By default the same person's Plex and Jellyfin
  accounts are separate subjects (different id-spaces). An admin can **link** them
  on the Stream Limits page (select two or more → Link) so they share a `groupId`
  and count together; the group's effective policy is the most restrictive of its
  members (any exempt member exempts the person, otherwise the tightest limit).
  Linking is always explicit — accounts are **never** joined by a matching name or
  email — and **Unlink** dissolves it. `POST /stream-control/link` /
  `…/policies/:id/unlink`, audited.

## Household & Sharing

Advisory detection of possible account sharing — **explainable, conservative, and
it never terminates a stream** (Stream Control remains the only enforcer). It
reuses the canonical identity (`groupId ?? MediaAnalyticsUser.id`), the existing
watch-history + live sessions, and offline GeoIP; there is no second poller, no
second identity model, no external IP lookup.

- **Home network is a cluster, not one IP.** A residential ISP hands out dynamic
  addresses, so "most-used exact IP = home" is wrong. The fingerprint keys on
  `(ASN‖ISP, country, region, city)` — a changing /24 within the same ISP+city is
  ONE network — and is scoped per household, so two customers of the same ISP are
  never treated as one home. Home is *learned* only from **residential** networks
  with enough evidence (age, distinct days, plays, watch time); mobile/hosting/VPN
  can never become or replace a home.
- **Networks are classified** residential / mobile / hosting / VPN-or-proxy /
  unknown (offline, from ISP/ASN; broad when uncertain). An admin can override the
  class, trust or ignore a network, or mark it travel/mobile.
- **Risk is derived from multiple explainable signals**, 0–100 with a reason trace
  (every case shows *why*): **mobile is neutral** (recorded, never raises risk),
  travel and trusted are discounted, VPN/hosting is review-worthy but not proof, a
  persistent second residential network is strong, and **simultaneous** residential
  streams (real time overlap, not just close timestamps) dominate. Dynamic-IP,
  CGNAT, IPv6 rotation, mobile and travel are handled so they don't create false
  "sharing" alerts. Wording favours **review**, never accusation.
- **Review workflow.** Cases that cross the review threshold open in a **Review
  Queue**; an admin can trust, mark travel/mobile, dismiss, or **confirm sharing**.
  Home can be **set / locked / unlocked / relearned** — a locked home is never
  auto-replaced; the learner's suggestion is surfaced instead.
- **Advisory by default:** analysis runs when data exists, notifications are off,
  and there is no enforcement coupling — upgrading never terminates anything.
  Evaluation runs as a bounded, idempotent background reconciliation (backfill of
  existing history included).

Permissions: `household.read` (view), `household.review` (disposition cases),
`household.manage` (home/network config + settings). Every admin action is audited;
meaningful transitions emit `media_server.household.*` domain/WS events (deduped).

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
`manage_settings`, `admin`, `sessions.terminate` (stop a live session — a stronger
grant than viewing activity), `stream_limits.read`/`stream_limits.manage` (view/edit
concurrent-stream limits), `enforcement.read` (view enforcement state + history),
`household.read`/`household.review`/`household.manage` (Household & Sharing: view /
disposition review cases / configure home + networks).
Enforced server-side (`@RequirePermissions`) and
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
- ~~UI pages~~ ✅ — Dashboard, Connections, Live Activity, Watch History,
  Recently Added, Reports, Import, Newsletters.
- **Automation triggers/actions** — still to come: the automation catalog
  registers no `media_server.*` trigger or action yet.

## IP address and geolocation

Every play records the address the viewer streamed from — Plex reports it as
`Player.address`, Jellyfin as `RemoteEndPoint` — and the Tautulli import carried
the historical ones. It is shown in **Watch History** and **Live Activity**, and
the **Reports → Locations** tab charts the top viewing countries, cities and
ISPs.

Geolocation is **offline**. Lookups run against MaxMind GeoLite2 database files on
the host; **no viewer IP address ever leaves your network**, and nothing is
called over the internet to resolve one. A LAN/loopback address has no public
geography and is shown as **Local**.

### The databases

Two free databases are used, both from a free MaxMind account:

- **GeoLite2-City** — country / region / city (and the map coordinates). Drives
  the location column and the country/city charts.
- **GeoLite2-ASN** — the network operator (ISP). Drives the ISP chart; optional —
  without it, locations still resolve and the ISP chart shows a hint instead.

Create a free account at <https://www.maxmind.com/en/geolite2/signup>, then note
your **Account ID** and generate a **licence key**.

### Setup — in the UI

Media Server Analytics has an **IP Geolocation** page (under its menu) that works
just like the local IMDb dataset admin:

1. Enter your MaxMind **Account ID** and **licence key**. The key is encrypted at
   rest and never shown again (a saved key reads as `••••••••`).
2. Choose the editions to keep current (City is required for locations; ASN adds
   the ISP chart), and optionally turn on **automatic updates** with an interval.
3. Click **Update now** for the first download. The status panel then shows each
   database's build date, size and when it was last refreshed.

The backend downloads the databases into the `/data/geoip` volume, verifies each
archive's checksum, installs the `.mmdb`, and reloads it immediately — no restart.
With automatic updates on, it refreshes on your interval (MaxMind publishes new
data about twice a week). **This download is the only outbound call the feature
makes, and it fetches a public database with your own licence — no viewer IP is
ever sent anywhere; lookups stay entirely offline.**

### Manual alternative

If you would rather not store a licence key, download `GeoLite2-City.mmdb` and
`GeoLite2-ASN.mmdb` (the `.mmdb`, not the CSV) yourself and copy them into the
volume the backend reads:

```bash
docker cp GeoLite2-City.mmdb ultratorrent-core-backend-1:/data/geoip/
docker cp GeoLite2-ASN.mmdb  ultratorrent-core-backend-1:/data/geoip/
```

You are then responsible for refreshing them on MaxMind's schedule. The backend
reloads whenever a file is replaced. The read paths are overridable with
`GEOIP_DB_PATH` and `GEOIP_ASN_DB_PATH`.

Everything degrades gracefully: with no database present, IP addresses still show
(without a location), the Locations tab explains what to add, and nothing errors.
