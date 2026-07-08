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

## [0.23.0] - 2026-07-08

### Added
- Auto-download match preferences: editable Auto-Download tab (ranked list, size caps) + per-show RSS-rule reuse (watchlistItem.rssRuleId) + match-preferences CRUD API (Phase 2)

## [0.22.0] - 2026-07-08

### Added
- Missing-episode auto-download uses RSS-style ranked match preferences with a real size cap (AcquisitionMatchCandidate + match-engine) instead of a quality profile; grabSelected bypasses profile scoring; defaults seeded 1080p/720p x265 size-capped (Phase 1a)

## [0.21.2] - 2026-07-08

### Fixed
- Fix Media Acquisition page crash (React #31): render evaluation releaseScore breakdown object's .value instead of the object; surfaced once evaluations existed

## [0.21.1] - 2026-07-07

### Fixed
- Torznab client: parse Prowlarr/Jackett feeds that advertise <rss version=1.0> (rss-parser rejected them, breaking all indexer searches through Prowlarr/Jackett)

## [0.21.0] - 2026-07-07

### Added
- Optional FlareSolverr companion (Compose profile flaresolverr) so Prowlarr can reach Cloudflare-protected indexers like EZTV; internal-only backend helper, docs updated

## [0.20.0] - 2026-07-07

### Added
- Optional Prowlarr companion container (Compose profile) + link-only integration: Settings → Integrations → Prowlarr (encrypted API key, SSRF-hardened health check), RBAC perms integrations.prowlarr.*, conditional nav shortcut, and docs/PROWLARR.md

## [0.19.0] - 2026-07-07

### Added
- indexers: Torznab/Newznab indexer subsystem + Missing-Episode auto-acquire bridge (scan → search → evaluate → profile-gated download), opt-in and default OFF

## [0.18.3] - 2026-07-07

### Fixed
- media-acquisition: group the Add-series-from-library picker by show folder, not per-episode title (fixes 9-1-1 showing episodes instead of one series row)

## [0.18.2] - 2026-07-07

### Fixed
- Missing Episodes / Watchlist: surface the 'Add from library' multi-select picker on the Watchlist page too (Media Acquisition -> Watchlist), next to the single Add button — previously it was only on the Missing Episodes page, so users adding to the watchlist saw only the old one-at-a-time form.

## [0.18.1] - 2026-07-07

### Fixed
- TV renames use unpadded season folders ('Season 8', not 'Season 08') and fetch metadata before renaming, feeding the identified series title into the rename so a bare filename (e.g. S01E01.mkv) resolves its show, episode title, and year instead of landing under 'Unknown'.
- rss: reject duplicate rule names (case-insensitive) and rules reusing another rule's save path

## [0.18.0] - 2026-07-07

### Added
- Missing Episodes: add a searchable multi-select 'Add from library' picker that lists the TV series already in your media libraries (with IMDb IDs resolved automatically) and bulk-adds the selected ones to the watchlist — instead of hand-typing each show + IMDb ID. New GET /media-acquisition/watchlist/library-series and POST /watchlist/bulk endpoints.

## [0.17.8] - 2026-07-07

### Fixed
- Media rename: rename_in_place now keeps files inside the show folder they already live in (the one the RSS rule set), only re-homing them into the correct season subfolder and fixing the filename — instead of relocating the whole series into a divergent, year-less Show/ folder. It reuses an existing season folder (Season 8 vs Season 08) and never re-derives the show-folder name, so a missing series year (or a rate-limited metadata lookup) can no longer fork a library. Series metadata continues to come from TMDB.

## [0.17.7] - 2026-07-07

### Fixed
- Add a 'variables available' help popover (Info icon) next to every rename-template input — the renamer Quick Rename + template dialog, the Media Manager library form, the MediaPage library form, and the Automation rename-for-media action. Lists all template tokens with descriptions plus the padding/optional-block/folder syntax, in en-US + es-PR.

## [0.17.6] - 2026-07-07

### Fixed
- RSS feeds page: per-feed rule lists are now collapsible and collapsed by default (toggle via the rule count), and each feed's Add rule button moved up into the top-right action row.

## [0.17.5] - 2026-07-07

### Fixed
- Duplicate detection: for TV/episodic items, scope the external_id key by show title + episode number. Provider external ids on episode rows are unreliable — series-level, and in some data the SAME id repeats across completely different shows — so external_id matching was grouping unrelated shows' first episodes together. External ids remain the strong entity-level signal for movies; for TV the title+episode scope prevents corrupt shared ids from collapsing distinct shows/episodes while still matching two files of the same episode.

## [0.17.4] - 2026-07-07

### Fixed
- Duplicate detection: separate UNIDENTIFIED episodes (null season/episode columns) whose filename still carries the SxxEyy marker and that share a series-level external id. The episode discriminator now derives season/episode from the title when the structured columns are null (and falls back to the title for any other non-movie without markers), so e.g. 248 Chicago P.D. episodes sharing one IMDb series id no longer collapse into a single duplicate group. Two files of the same episode still group.

## [0.17.3] - 2026-07-07

### Fixed
- Fix duplicate detection grouping different films that share a title (e.g. Aladdin 1992 vs 2019). The similar_filename fallback key was title-only for movies, so same-title/different-year films collided even though title_year already separated them. The fallback is now year-scoped for movies (and episode-scoped for shows), matching the precision of the primary keys.
- Library scans now reconcile deletions: items whose file no longer exists on disk are pruned (guarded so an unreadable/unmounted root never wipes a library). Previously scans only added/updated, so files removed on disk (or under a skipped dot-folder like tinyMediaManager's .deletedByTMM) lingered as phantom library items forever. ScanSummary gains a removed count. Combined with the existing dot-directory skip, hidden trash folders are neither indexed nor left behind.

## [0.17.2] - 2026-07-07

### Fixed
- Notification Center Phase 2: wire the event bus into Downloads, RSS, Media Manager, System and Auth so the seeded rules actually fire; add an Automation 'send_notification' action that dispatches through the Notification Center; and add the remaining UI pages (Templates with live preview, Recipient Groups, Queue Monitor, Provider Health, Preferences, Settings) with routes, nav and en-US/es-PR i18n. Adds an edge-fired system resource monitor (disk/cpu/memory). Also fixes a pre-existing media-processing test mock.
- Fix duplicate detection grouping different episodes of a series as duplicates. The similar_filename key used only the show title, and the external_id key used the raw provider id — but providers store a series-level id (e.g. the same TVDB number) on every episode row, so both keys collapsed every episode of a show into one duplicate group. Both keys are now episode-scoped (season/episode appended for episodic items), so distinct episodes never group while two files of the same episode still do. Recomputed on the next Detect run.

## [0.17.1] - 2026-07-06

### Fixed
- Add Notification Center — the centralized, provider-driven messaging platform (core module). Modules publish events onto a new in-process event bus; configurable rules decide if/when/how/to-whom notifications are delivered across Email, SMS, Telegram and WhatsApp (provider abstraction allows unlimited future providers). Includes rich media cards (with SMS plain-text fallback), templates, recipients + groups, an async delivery queue with retries/quiet-hours/rate-limiting/dedup, delivery history, provider health, RBAC, audit, WebSocket updates, and a seeded editable default rule catalog. Supersedes the legacy notifications module. Media Server Analytics now publishes its watch/newsletter events.

## [0.17.0] - 2026-07-06

### Added
- RSS: TV show airing-status awareness (Phase 1, backend). Pluggable TvShowStatusProvider (TMDB/IMDb/local) + normalization/recommendation, GET/POST /api/rss/show-status lookup endpoints, RSS-rule status snapshot + migration, save validation requiring allowInactiveShowMonitoring for ended/canceled shows, new rss.show_status.* permissions, WS events, and audit. Frontend + automation + background refresh are Phase 2/3.
- RSS show-status Phase 2 (frontend rule flow): reusable ShowStatusPanel/badge + hook, api.rss.showStatusLookup, a Media type selector + live status panel in the RSS rule create/edit dialog, and a confirmation modal that gates saving a rule for an ended/canceled show (allowInactiveShowMonitoring). i18n en-US + es-PR.
- RSS: TV show airing-status awareness (Phase 3b, automation triggers + actions). The automation engine gains an event-context path (evaluateEvent) with five RSS triggers (rule created for inactive show, show status changed, became active, ended, canceled) and four actions (refresh RSS show status, disable RSS rule, convert rule to backfill only, notify admin). RSS actions are delegated to a new RssAutomationActions provider; the show-status refresh job and the inactive-show rule save fire the triggers via ModuleRef. Remaining Phase 3b: frontend status-badge placements (Smart Match Builder / Match Preferences Builder / rule list + detail) and the RSS.md/MODULES.md docs.
- RSS: TV show airing-status awareness (Phase 3b, status badges + docs). The stored rule snapshot now surfaces its airing status on the rule list and the rule-detail header (covering the Smart Match Builder / Match Preferences tabs beneath it), with a recommendation caption for non-recommended shows. New docs/RSS.md documents the RSS module and the full show-status layer; MODULES.md and MEDIA_ACQUISITION_INTELLIGENCE.md updated to match. Completes the TV show airing-status awareness epic.
- RSS: TV show airing-status awareness (Phase 3a, scheduled background refresh). New RssShowStatusRefreshService re-resolves cached show statuses on a per-status cadence (active 24h / hiatus 7d / ended·canceled 30d / unknown 3d); on a status change it updates every rule that snapshots the show, emits rss.show_status.changed (+ rss.show.ended/canceled/became_active), and audits it — it never disables a rule. New WS events + manifest scheduler job. Automation triggers/actions and remaining frontend badge placements are Phase 3b.

## [0.16.13] - 2026-07-06

### Fixed
- Admin-selectable newsletter poster hosting + dark-canvas fix. Posters were always CID inline attachments, which Gmail lists in the attachment strip (unlike Tautulli's hosted-URL images), and the dark background dropped to white in clients that ignore CSS backgrounds on <body>/tables. Admins can now choose, in Settings → Newsletter poster images, how posters reach the inbox: embed (CID attachment, default, self-contained), serve from this instance (a signed, expiring, public image URL — no attachments), or upload to an external image host (Imgur, client id stored encrypted). Self-hosted images are served by a new unguarded endpoint (mail clients can't authenticate) gated by an HMAC-signed, expiring per-image token that only ever serves a downscaled MediaArtwork by id — no arbitrary paths, no library structure leaked; any mode missing its config degrades to embedding. Posters are downscaled to ~240px regardless. The email now also sets bgcolor attributes so the dark canvas holds in Gmail/Outlook.

## [0.16.12] - 2026-07-06

### Fixed
- Media Items grouped TV browser: enlarge show posters (h-14 w-10 -> h-24 w-16) and default to 10 shows per page (was 30)
- Media Items grouped TV browser: enlarge show posters a bit more (h-24 w-16 -> h-[7.5rem] w-20, 2:3)
- Equal-height newsletter card grid (Gmail-safe). Two cards in a row rendered at their own content heights, so a show with a long overview left its paired card's panel visibly shorter/ragged. The card panel (background/border/padding) now lives on the grid cell instead of a nested table — sibling cells in a table row are always drawn at equal height, which Gmail/Outlook honour (unlike height:100% on a nested table, which only browsers respect). A shared twoColGrid() lays out panel-cell / gutter-cell / panel-cell rows; on mobile the columns collapse to full width (panel padding preserved) and the gutter is hidden.

## [0.16.11] - 2026-07-06

### Fixed
- Media Items: group TV shows when a TV/anime-kind library is selected, not only when the media-type filter is TV/anime. Browsing the 'TV Shows' library (via the library filter) showed a flat episode list because the grouped Show->Season->Episode view only triggered on the type filter; it now also triggers from the selected library's kind (unless an explicit non-TV type filter is active)
- Downscale newsletter poster attachments so they actually render. Full-size library posters run 250KB–1MB+, but the newsletter's inline size cap (MAX_POSTER_BYTES, 500KB) silently dropped anything larger — so most show/movie cards fell back to the gradient placeholder even after their poster was found (a real test send showed 4 correct show cards but only 1 poster, 3 placeholders). `loadPoster()` now resizes each poster to a small JPEG (240px wide, via sharp) before attaching — the card slot is only ~84–120px, so a full-resolution poster was massive overkill. Real posters drop from 250KB–1.1MB to ~20KB, so every card gets its artwork and a full 30-poster email stays well under 1MB. Falls back to the original image (if within the cap) when resizing fails.

## [0.16.10] - 2026-07-06

### Fixed
- Move the newsletter Email/SMTP setup out of the Newsletters page onto the Settings page. The EmailSettingsCard (SMTP host/port/secure/auth/from + test-send) is extracted to its own component and rendered on SettingsPage, gated by the media_server_analytics.manage_settings permission; removed from NewslettersPage. Self-contained (keeps its mediaServerAnalytics i18n + API), no behavior change
- Newsletters: add an edit button for campaigns. A per-campaign Edit (pencil) toggle now reveals name / frequency / recipients fields with Save/Cancel, patching via the existing updateNewsletter endpoint — previously those core fields couldn't be changed after creation (only the content window + sections were inline-editable). i18n en-US + es-PR
- Fix TV newsletter grouping and artwork for unidentified episodes. Episodes imported with a raw release title ("Show - S02E01 - Name") and null season/episode were grouped by exact title, so each became its own one-episode "show" (blank season/episode ranges, no poster) — the newsletter looked like a wall of broken cards with almost all artwork missing. The newsletter build now normalizes the show name + season/episode from the title (reusing the RSS release-name parser) so those episodes collapse into their real show, and resolves each show's poster from the whole library by (normalized) show title — trying poster → season_poster → thumbnail → fanart — instead of relying on the newest (often artwork-less) episode's own artwork. Verified against real data: a 9-broken-card / 1-poster TV section becomes 4 correct show cards, each with its real poster.

## [0.16.9] - 2026-07-06

### Fixed
- Media artwork: display each artwork type at its natural aspect ratio. The detail Artwork tab rendered every type in a 2:3 poster frame with object-cover, so wide banners (and fanart/logos/clearart) were cropped to a vertical slice and looked wrong. MediaPoster gained a fit prop ('cover' default / 'contain'); the Artwork tab now frames posters 2:3, banners 16:3, fanart/thumbnails 16:9, and shows banners + transparent logos/clearart with object-contain (no crop)
- Fix frontend production build (tsc noUnusedLocals) broken by the newsletter content-type toggle: the ContentTypeToggle chip computed an `active` flag but styled off `value.includes(key)` inline, leaving `active` unused. The highlight now uses `active` (so an unscoped newsletter shows every type as on, dimmed), which is also the correct behavior. No functional change beyond the empty-selection visual.

## [0.16.8] - 2026-07-06

### Fixed
- Media artwork: cached poster thumbnails for fast grid rendering. Full-size posters (often several MB) were streamed for every grid cell via a per-item authenticated fetch, so lists showed the stub placeholder while images slowly loaded. New MediaArtworkService.thumbnail() lazily generates a small WebP thumbnail (width 400, via sharp) on first request and caches it under .ultratorrent/media-artwork/thumbs/ (a dot-dir the scanner ignores), regenerating when the source changes and falling back to the original if resizing fails. Served via GET /media/artwork/:id/image?thumb=1. MediaPoster now requests thumbnails by default (grids/cards) with a size='full' opt-out; adds the sharp dependency
- Reworked the Media Server Analytics newsletter into a dark, amber-accented media digest: branded header (server name + date range + divider), section headers with count summaries, poster-left TV show cards grouped by show with metadata badges and 5-star ratings, a movie poster grid, and a three-area footer (unsubscribe / brand / preferences). Preview page gains desktop/mobile modes and sample data when empty; fully server-side localized (en-US/es-PR); plain-text and poster fallbacks preserved
- Media Server Analytics newsletters are now split into per-content-type sections (Tautulli-style) and can be scoped to a specific type. buildContent() replaced the fixed TV+Movies model with a generalized sections model that iterates NEWSLETTER_GROUPS and emits one section per content type present (TV Shows, Movies, Music & Concerts, Documentaries, Recently Added). Episodic groups collapse into show cards ("N Shows / M Episodes") via groupShows() instead of listing every episode; other types render as poster grids ("N Movies" / "N Items"); empty groups are omitted. A newsletter can be scoped to a subset of types via contentSections — the service filters the media query by the selected groups' mediaTypes (empty = all types), so a "TV Shows" newsletter only contains grouped shows, a "Movies" one only movies, etc. The Newsletters page gained a content-type toggle-chip selector on both the create form and each newsletter card (en-US + es-PR).
- Media artwork: stop posters falling back to the stub icon, and fetch missing art from providers on scan. (1) The frontend artworkImage() blob fetch bypassed request()'s auth handling and never refreshed on 401, so once the 15-minute access token expired every local poster silently 401'd and showed the placeholder until a full reload — it now refreshes + retries once like every other call. (2) Library scans now ALWAYS import local folder artwork (poster/fanart/folder sidecars), no longer gated behind the artwork-fetch flag, and fall back to a provider fetch for items whose folder has no poster (self-limiting: no network without a configured key + metadata id).
- Media artwork: import show/season-level art from parent directories for TV. importLocal only scanned each media file's own directory, so a TV episode in 'Show/Season 01/' never picked up the show-level poster.jpg/fanart.jpg/banner.jpg (which live in the show root, a level up) — episodes ended up with only their per-episode '<episode>-thumb.jpg' screenshot, so the grouped TV browser showed no poster and the artwork tab showed the episode still. importLocal now scans each file's directory AND its ancestors up to the library root, and classifies 'seasonNN-poster' as a season_poster (with season number). The scanner's skip-if-enriched check now requires a poster (not just any artwork) so thumbnail-only items get re-processed on the next scan

## [0.16.7] - 2026-07-06

### Fixed
- RSS feed history: add filtering. The history view can now be filtered by status (Downloaded / Matched / Seen) via clickable summary tiles and by a case-insensitive release-title search. GET /rss/feeds/:id/history gains optional status + search query params; pagination total reflects the active filter while the count tiles stay scoped to the search (never the status) so they keep the full breakdown and double as toggles. i18n en-US + es-PR
- Media Items page: group TV episodes into a collapsible Show → Season → Episode tree, paginated by show (a 24k-episode library becomes ~638 show rows). New /media/series grouping endpoint + exact-title episode fetch, lazy-loaded season/episode expansion, posters and season/episode counts per show
- RSS feed history: add a date-range filter (from/to on when the item was seen), complementing the status + title-search filters. GET /rss/feeds/:id/history gains from/to query params (inclusive, whole-day, UTC); the range scopes both the list and the count tiles, like search. Frontend adds two date pickers to the history filter bar. i18n en-US + es-PR
- Bundled rtorrent: persist session state promptly so a crash no longer loses recently-added torrents. The rc had no session-save schedule, so rtorrent only wrote full state on a clean shutdown — any torrent added since the last graceful stop was lost when the (sporadic, auto-restarted) libtorrent crash hit, which is why RSS-grabbed torrents 'downloaded' but never appeared. rtorrent.rc now saves each torrent's full state on add (event.download.inserted_new -> d.save_full_session) plus a 5-minute periodic session.save backstop
- RSS history match-test now scans the newest 5000 feed-history rows instead of 200, so on busy feeds a rule's real matches (many release variants per episode push past 200 rows) are found instead of wrongly reporting no matches

## [0.16.6] - 2026-07-06

### Fixed
- Media Server Analytics newsletter overhaul: Tautulli-style dark, poster-driven HTML email (gradient header, colour-accented sections, per-title cards with artwork, rating/runtime/certification chips, genres and overview from media metadata; posters attached as inline CID images with graceful fallback), plus a selectable start date (new since_date range mode + startDate) alongside since-last-send and last-N-days, editable on the create form and inline per newsletter
- Media Items page performance: paginate GET /media/items instead of loading every item at once (28k+ item libraries made the page take many seconds). Server-side page/pageSize (default 60) + total + case-insensitive title search; frontend gains a search box and prev/next pager on both the Media Items and Unmatched pages. ~170x faster DB fetch and a bounded payload/render
- Paginate every growing result-page endpoint (watch history, users, duplicates, import jobs, newsletter deliveries, sync runs, RSS match-history, automation logs, media rename history, notifications) via a shared page helper + reusable Pagination component, so large lists no longer load thousands of rows at once. Also: the RSS history match-test now shows only matching rows, not the full history
- Media Manager: two identification edge-case fixes. (1) Numeric-title/year collision — a movie whose title is a 4-digit year (e.g. '1917 (2019)') no longer parses the leading number as the year and collapses the title to empty; the parser now prefers a parenthesized (YYYY) release year, falls back to the last year candidate, and never treats a year at position 0 as the title boundary. (2) The library scanner now skips hidden/dot directories (tinyMediaManager '.deletedByTMM'/'.actors', macOS '.Trashes') and Synology '@eaDir' thumbnail folders, which were surfacing phantom unmatchable items
- rTorrent engine: confirm a torrent actually registers before reporting an add as successful. addMagnet/addTorrentFile issued a fire-and-forget load.start (which returns 0 immediately and loads asynchronously) and then returned a hash derived from the magnet/torrent — so if rtorrent silently dropped the torrent or crashed mid-announce, the RSS/download flow recorded a phantom 'downloaded' with no torrent in the engine. Both add paths now poll the download list (case-insensitive) until the info-hash appears and throw if it never does, so the manual path surfaces an error and the auto path skips marking it downloaded
- Bundled rtorrent engine image: replace Debian's apt rtorrent 0.9.8 / libtorrent 0.13.8 (which sporadically crashes on tracker announce with 'priority_queue_insert(...) called on an invalid item', and on DHT) with the maintained jesec/rtorrent static binary (pinned v0.9.8-r16). Same SCGI-TCP:5000 wiring, rc, entrypoint, uid-drop, and /downloads/.session persistence — only the rtorrent binary changes

## [0.16.5] - 2026-07-06

### Fixed
- Re-engineered the frontend navigation into a declarative typed tree with logical collapsible groups and nested sub-menus (Overview, Downloads, RSS & Acquisition, Media Management, Media Server Analytics, Automation, Files, Administration, Account), RBAC- and module-aware visibility with empty-group pruning, persisted collapse state + auto-expanded active branch, icon-rail tooltips, mobile drawer, tree-derived breadcrumbs, and a Ctrl/Cmd+K command palette that only surfaces pages the user can access. Full en-US/es-PR i18n parity and accessibility
- SMTP settings: add an explicit 'Use authentication' toggle so newsletters can send through relays that reject AUTH (e.g. internal/localhost postfix). When off, no user/pass is sent regardless of a saved username; back-compat: existing configs with a username keep authenticating
- Media Manager: fix cleanly-organised TV libraries scanning entirely as unmatched. Identification now recovers the series title from the parent folder when the episode filename omits it (Show/Season 01/S01E01.mkv), and confidence is weighted by identity signals (title + season/episode, or movie year) instead of the count of scene tokens (resolution/source/codec/group) — so a tidy personal library matches without needing release-scene junk in the filename
- Media Manager: add bulk re-identify endpoint (POST /api/media/items/reidentify) to re-run auto-identification across a whole library at once — the recovery path for libraries that scanned as unmatched. Optional { libraryId, matchStatus } body (omit to re-identify all non-manual items, or matchStatus:'unmatched' to retry only failures); runs as a tracked media_identification job with WebSocket progress and returns a { total, matched, unmatched, failed } summary. Manual matches are never auto-overwritten. The Unmatched page gains a "Re-identify all" button (scoped to unmatched items) that reports how many matched; `api.media.reidentifyItems()` client method added. i18n en-US + es-PR

## [0.16.4] - 2026-07-06

### Fixed
- Live Activity overhaul: real-time updates (WebSocket session-event push + 8s poll; backend session poll 30s→15s) so it no longer needs a manual reload, now-playing poster artwork via an auth-injected backend image proxy (Plex/Jellyfin/Emby), a summary KPI strip (streams/watchers/bandwidth/transcodes), a stream-mix proportion bar, and redesigned session cards with posters, playback-method colors, quality chips (resolution/codec/bitrate/container) and progress
- Fix Tautulli analytics import failing with "Failed to parse URL" when the source address is entered without a scheme (e.g. `192.168.99.10:8181`). The import provider now normalizes the base URL, defaulting to `http://` when no scheme is present and stripping trailing slashes. Regression test covers scheme-less, explicit-scheme, and trailing-slash cases.

## [0.16.3] - 2026-07-06

### Fixed
- Fix media-server connections failing with 'baseUrl is required': the integration settings form persisted the server address under 'url' but providers read 'baseUrl'. decryptConfig now aliases url→baseUrl (repairs already-saved connections), and the form writes baseUrl going forward

## [0.16.2] - 2026-07-06

### Fixed
- Media Server Analytics (Phase 6e): DB normalization + sync overhaul. New MediaServerLibrary/MediaServerUser/MediaProviderSyncRun entities + stream-detail capture (container/bitrate/audio codec); MediaServerSyncService pulls provider libraries (capability-aware, upsert+prune) and derives users from watch history, hourly + on demand with run tracking. ReportFilter gains connectionId/libraryName/userName dimensions unlocking dashboard server/library/user filters; new bandwidth-over-time aggregation. Frontend: server/library/user selectors, bandwidth chart, provider Sync button

## [0.16.1] - 2026-07-06

### Fixed
- Media Server Analytics premium dashboard overhaul: dataviz-validated color system, KPI grid, real-time Now Playing panel, and Recharts graphs (plays-over-time, playback-method donut, top users, devices, most-watched) with real KPI aggregation + top-media/devices endpoints
- Media Server Analytics dashboard: artwork-rich Recently Added strip (provider posters via MediaPoster with lazy-load/skeleton/graceful fallback) and a persistent filter bar (date range, media type, auto-refresh interval, manual refresh) wired end-to-end into report aggregation (days/mediaType where-clauses)
- Media Server Analytics dashboard (Phase 6d): activity heatmap (day×hour, single-hue sequential), streaming trend (transcode vs direct-play stacked area over time), quality/resolution distribution, cumulative library-growth chart, provider-status health panel, and watch-history CSV export (new media_server_analytics.export permission). Watch history now captures resolution + video codec on session close; all new aggregations honor the shared date/media-type filter

## [0.16.0] - 2026-07-05

### Added
- Smart Download execution engine (Phase 1): acquisition decisions now actually download — a new SmartDownloadExecutorService turns a download/upgrade decision into a real torrent add (and removes the superseded torrent on an upgrade), wired into evaluate/approve/override; closes the gap where a 'download' decision recorded a pending action that nothing executed
- Smart Download Phase 2: missing movie & season detection — MissingMoviesService scans movie watchlist items (owned via IMDb link or title+year) into WantedMovie rows; MissingEpisodesService.listSeasons rolls up per-season missing status; new endpoints + WantedMovie model
- Smart Download Phase 3: multi-dimensional upgrade comparison (resolution/source/HDR/audio, codec as tiebreak) replacing resolution-only logic; a wait-for-better decision + policy; and waiting/upgrade queue endpoints
- Smart Download Phase 4: Decision Simulator — a dry-run POST /simulate endpoint (no side effects) returning the decision plus a clickable stage-by-stage pipeline explanation, and a Decision Simulator UI page with the visual pipeline
- Smart Download Phase 5a: a Smart Download dashboard page (widget grid + recent decisions + Waiting/Upgrades/Rejected queue tabs) backed by an extended overview() and a new /rejected endpoint
- Media Server Analytics module (Phase 1): new core module extending the existing Plex/Jellyfin/Emby/Kodi integration with capability-aware getServerInfo/getLibraries, health checks, a dashboard, and secure multi-server connection management; Dashboard + Connections UI, RBAC, i18n
- Media Server Analytics Phase 2: live activity + watch history — provider getSessions (Plex/Jellyfin/Emby; Kodi unsupported), a 30s reconciliation poller feeding MediaServerSession + MediaServerWatchHistory, /live and /watch-history endpoints, and Live Activity + Watch History UI pages
- Media Server Analytics Phase 3: analytics & reports — usage/users/libraries/playback aggregations from watch history + recently-added from Media Manager, with Analytics Reports (tabbed) and Recently Added UI pages
- Media Server Analytics Phase 4: Tautulli analytics import — a MediaAnalyticsImportProvider + background import job streaming Tautulli watch history into UltraTorrent (encrypted API key, preview, duplicate-safe dedup, progress), with an Import Analytics UI page
- Media Server Analytics Phase 5: scheduled newsletters — a net-new SMTP email service (nodemailer, encrypted config) + newsletter campaigns of recently-added media with responsive HTML/text rendering, preview, test/send, delivery tracking, and a dispatch scheduler; Newsletters UI page with SMTP settings

### Fixed
- Smart Download Phase 6 docs: new docs/SMART_DOWNLOAD.md (full engine documentation), API.md endpoint additions + boundary correction, and cross-links from acquisition/media-manager/README

## [0.15.0] - 2026-07-05

### Added
- feat(media): optional TV series & episodes in the optimized IMDb import (importTvShows toggle) — also imports tvSeries/tvMiniSeries/tvEpisode + title.episode; principals still always skipped
- Missing Episodes — detect which episodes of a monitored TV series are absent from the library by diffing the local IMDb episode catalogue, with a per-series view and season/episode grid

### Fixed
- Dashboard Recent Activity now renders audit-log entries (map AuditLog rows to the ActivityItem shape the UI expects)
- feat(rss): treat a rule's match-preference list as a per-title acquisition policy — hold one release per movie/episode, upgrade to a strictly higher-priority release when it appears (removing the superseded torrent), and skip equal-or-lower releases, so a movie is no longer grabbed once per quality variant
- fix(rss): dedupe auto-downloads by torrent info-hash so a release re-posted under a rotated guid or seen on a second feed is never grabbed twice (poll + backfill)

## [0.14.0] - 2026-07-05

### Added
- feat(media): add a "Test TMDB key" button in Media Settings that validates the key against TMDB before saving
- feat(media): optimized IMDb movie import — import a lean movie-focused subset (title.basics/ratings/akas, filtered by type/adult/min-year) with referential integrity, stats, idempotency; skip title.principals/episode; add reset + admin strategy panel + docs

### Fixed
- feat(media): add a Stop button to cancel a running IMDb dataset import — cooperative cancellation across both the optimized and full import strategies, marking the run 'cancelled' (already-imported records are kept) with a stop endpoint, WS event, and UI button
- feat(media): IMDb Danger Zone — wipe all imported IMDb data (wipe-only) for when the wrong dataset was imported
- fix(docker): rtorrent entrypoint no longer crash-loops when it cannot drop privileges (Synology/non-root/cap-stripped hosts)
- fix(docker): re-add SETUID/SETGID caps to the rtorrent service so gosu can drop to PUID:PGID on hosts (Synology) that strip them

## [0.13.1] - 2026-07-05

### Fixed
- fix(files): translate mkdir failures (EACCES/EROFS/ENOSPC/…) into actionable errors instead of an opaque 500 when creating a directory
- feat(rss): per-feed rule export — download a bundle scoped to a single feed

## [0.13.0] - 2026-07-05

### Added
- Add an in-app update check. The About dialog now shows whether a newer UltraTorrent release is available (compared against the GitHub release tags), with a Check now button, release-notes link, and the exact deployment-specific commands to apply it. New endpoints: GET /api/system/update (status), POST /api/system/update/check (force check, system.view), PATCH /api/system/update/settings (toggle, system.manage). SystemUpdateService detects Docker vs bare-metal (/.dockerenv + cgroups, overridable via ULTRATORRENT_DEPLOYMENT) and runs a daily background check (on by default, toggleable) plus on demand. Note: the app never auto-applies updates — in Docker a container can't replace its own image, and updates rebuild from source — so it surfaces the right command instead (docker compose up -d --build vs git pull + build + restart).
- Library scans now import existing sidecar artwork and metadata. When a scanned media directory already contains Kodi/Jellyfin-style artwork (poster.jpg, fanart.jpg, folder.jpg, banner, logo, clearart, landscape/thumb, and <name>-poster.jpg style suffixes) the files are imported in place (referenced, not copied; source 'local', auto-selected one per type). Adjacent .nfo files (<basename>.nfo, movie.nfo, tvshow.nfo) are parsed for title/overview/year/runtime/rating/genres/studios/certification/original-title/directors/writers/cast and external ids (imdbid/tmdbid/tvdbid or Kodi <uniqueid>), filling metadata gaps without clobbering provider data and recording external ids + a MediaNfoFile. Runs per item at the end of a scan, skips already-enriched items, is idempotent, and reports artworkImported/metadataImported counts in the scan summary + toast.

### Fixed
- Fix: the IMDb dataset auto-download no longer requires a dataset path to be configured first. The path is a download destination, not a pre-existing source, so when none is set the download+import now falls back to a managed default (<storage-root>/.ultratorrent/imdb-datasets), creates it, and persists it. 'Update now' works out of the box and the scheduler no longer skips when no path is configured.
- Fix: the IMDb dataset import panel now refreshes when a long import finishes even if the WebSocket completion event is missed. A long import (title.principals is ~90M rows) emits no progress events for minutes and can outlast a socket reconnect, so the terminal event could be lost and the history/status never updated. The settings page now polls the imports + provider status every 4s while an import is active (from the live panel or the newest history row, so a page reload mid-import still tracks it) and reconciles the live panel to completed/failed from the polled history.
- Prevent overlapping IMDb dataset imports. ImdbDatasetImporterService.startImport now refuses to spawn a second worker while one is pending/running (returns the in-flight import instead) — the single choke point for Import-now, Update-now, and the scheduler. ImdbService guards download+import with an in-flight flag + DB active-import check, and marks any import left running after a restart as failed on startup so a dead job can't wedge future runs. The frontend disables Update-now while an import is active and surfaces a friendly message when a duplicate is rejected.

## [0.12.0] - 2026-07-04

### Added
- The **Media Manager** can now fetch artwork online. A new `ArtworkProvider` seam ships with a `TmdbArtworkProvider` that resolves an item's TMDB id and imports the best **poster** and **fanart** from TMDB. Downloads reuse the same magic-byte + 10 MB validation as custom uploads, are restricted to the TMDB image host (SSRF guard), record provenance (`source: 'tmdb'`), and are idempotent per image. Auto-imported art only auto-selects when the item has no art of that type yet, so operator uploads keep precedence. The `media_fetch_artwork` automation action now performs the fetch (falling back to reporting missing art when no TMDB key or match is configured), operators can trigger it manually via `POST /api/media/items/:id/artwork/import`, and the Media Detail artwork panel gains a **Fetch from provider** button (en-US + es-PR).
- The **Media Manager** gains its full enrichment backend. Scanned files now carry technical details (codec, resolution, HDR, audio, release group, quality) parsed from their filenames. Items can fetch rich **metadata** (overview, genres, cast/crew, ratings) from a local `.nfo` sidecar and — when a TMDB key is configured — from TMDB, with manual edits supported. New capabilities: **artwork** management (list/select per type, custom image upload validated to PNG/JPG/WEBP under 10 MB), **subtitle** discovery (scans for sidecar `.srt/.ass/.sub/.vtt` files, detecting language, forced, and SDH flags), Kodi-style **NFO** generation (movie/tvshow/season/episode, per-library toggle), **duplicate** detection (by external id, show/season/episode, title+year, or similar filename, with a quality comparison to pick the copy to keep), and **media-server integrations** for Plex, Jellyfin, Emby, and Kodi (test connection + trigger a library refresh; credentials are encrypted at rest). All filesystem access stays inside the configured storage roots and sensitive actions are audited.
- When the IMDb dataset feature is enabled, a scheduled job now downloads the official IMDb dataset files and imports them automatically. New IMDb settings — autoDownloadEnabled, datasetBaseUrl (defaults to the official https://datasets.imdbws.com/, operator-configurable), and autoUpdateIntervalHours (default 168 = weekly). An hourly ImdbDatasetScheduler tick runs the download+import at most once per interval when mode is dataset/hybrid and a dataset path is set. ImdbDatasetImporterService.downloadDataset streams the seven .tsv.gz files to disk (temp .part + atomic rename) inside the hard roots, emitting imdb.dataset.download.* WS events. New POST /api/media/providers/imdb/dataset/update-now triggers a manual download+import. The IMDb settings page replaces the unused cron field with auto-download controls (toggle, base URL, interval, Update now) with live download+import progress.

### Fixed
- Fix backend crash-loop on fresh build: break the MediaModule ⇄ AutomationModule DI cycle (ImdbService + MediaProcessingService now resolve AutomationEngine lazily via ModuleRef).
- Show the git tag in the version display: /api/system/version returns gitTag (GIT_TAG build arg or v<VERSION> fallback) and the About dialog shows a Tag row.
- RSS rules import now supports three merge modes: skip (default — leave existing rules), overwrite (replace matched rules' fields and their whole candidate set), and merge (append only non-duplicate match candidates to existing rules). Feeds are always reused by URL, never renamed. The import UI adds a mode-selection dialog and the summary reports overwritten/merged/skipped counts.
- Saving a directory path now validates it against the hard storage roots (FILE_MANAGER_ROOTS) and, when the path is allowed but doesn't exist yet, prompts to create it. New GET /api/files/inspect (containment + on-disk state) and POST /api/files/ensure-dir (recursive mkdir inside the roots, audited) back a reusable useEnsureDirectory() hook. It is wired into every destination-path save form: Media Manager library create/edit, Add Torrent save path, RSS rule save path, Automation move/rename destinations, and the Settings default root path. Media library create/update now also asserts the path is within the hard roots server-side. Pure read-source inputs (rename-from source, scan/dry-run library, rename preview source) are intentionally left out, since creating an empty folder there is meaningless.
- The Media Manager media list is now a rich, poster-forward view instead of a bare table. Each row shows the poster artwork, title/year, rating, media type + match badges, season/episode, certification, runtime, overview, genres, technical specs from the primary file (resolution/codec/HDR/audio/size/container), and IMDb/TMDB external-id links; rows link to the item detail page. Backed by the list endpoint now eagerly loading metadata/artwork(poster)/externalIds relations, and a new GET /api/media/artwork/:artworkId/image endpoint (MEDIA_MANAGER_VIEW) that streams locally-stored artwork so it renders in the browser (remote provider artwork still loads from its url).
- The Media Detail artwork tab now renders posters through the shared MediaPoster component, so locally-stored artwork (custom uploads / on-disk provider imports) displays correctly instead of showing a broken image — it fetches those bytes through the authenticated artwork image endpoint, while remote provider art still loads from its url.

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
