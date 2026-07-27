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

## [0.53.0] - 2026-07-27

### Added
- A file move now updates every path-bearing record instead of leaving a stale row for the next scan to delete along with the item's enrichment
- Quarantine and restore now move their database records; a consistency endpoint reports rows whose file is gone

## [0.52.0] - 2026-07-27

### Added
- Rename undo: reverse a rename run by moving files back to their recorded sources, with guards for a shared media tree

## [0.51.2] - 2026-07-27

### Fixed
- Duplicate groups left with one member after their other copy's file disappeared are pruned where the deletion happens, instead of lingering as a phantom duplicate with stale reclaimable bytes
- Fix issue counts and filtering reintroducing the NOT IN pathology: relation-absence issues now use NOT EXISTS anti-joins

## [0.51.1] - 2026-07-27

### Fixed
- Fix the media issues and CSV export routes: literal paths were shadowed by items/:id, and the CSV serialized as JSON instead of streaming

## [0.51.0] - 2026-07-27

### Added
- Library Browser Phase 1: a virtualized poster-first browser over existing media endpoints, with five view modes remembered per library
- Library Browser: drill down from a show into its seasons and episodes, with URL-backed navigation
- Media bulk operations over an explicit item selection: metadata refresh, lock/unlock and NFO for {itemIds}, each one job and one audit record
- Library Browser: selection-aware context action bar wired to the bulk endpoints (metadata, NFO, lock/unlock, scan)
- Library Browser: server-side debounced search and match-status filtering
- Media CSV export: streamed, keyset-paged, browser-filtered, audited, with a new media_manager.export permission
- Library Browser: issue chips (unmatched, missing artwork, missing subtitles, duplicate) with per-library counts that filter the grid

### Fixed
- Fix the Media Manager dashboard hanging forever: replace Prisma NOT IN subqueries for missing artwork/subtitles with indexed NOT EXISTS anti-joins
- Library Browser: selection model for multi-select over the virtualized grid (click/ctrl/shift/checkbox, select-all-loaded, pruning)
- Notifications, activity feed and audit trail now name a person by their full name, falling back to the login handle

## [0.50.1] - 2026-07-26

### Fixed
- Media-server sessions are no longer ended on a single missed poll: a grace period plus re-attachment of sessions whose provider id changed, fixing spurious stop/start notifications, fragmented watch history and inflated completed-play counts

## [0.50.0] - 2026-07-26

### Added
- Telegram playback notifications are now short and artwork-led: a poster, a natural-language line, the title, one quality/device line and a single View Live Activity button
- Telegram stopped-watching notifications are now short and artwork-led, with finished-watching wording at the existing completion threshold and a progress/duration context line

## [0.49.0] - 2026-07-26

### Added
- Telegram notifications are now per-user: each person connects their own @BotFather bot on the Channels page, replacing the shared operator-configured bot that had no UI

## [0.48.2] - 2026-07-26

### Fixed
- Fix React #426 when opening the notification pages: lazy routes had no Suspense boundary; AppShell's Outlet is now guarded, covering every lazy page

## [0.48.1] - 2026-07-26

### Fixed
- Notifications: add a Dashboard nav rail entry (Inbox/Events/Channels) and register the module in the core registry, so the engine is discoverable rather than reachable only from the avatar menu

## [0.48.0] - 2026-07-25

### Added
- Rebuild the platform domain-event bus (notifications rebuild, Phase 1). Restores shared pub/sub as DomainEventBus on the domain.event channel - named for what it is, not for one subscriber. Adds guarantees the previous bus never had: a catalogue that refuses unregistered keys, payload validation at the producer, idempotency by event id and by fact within a dedupe window, best-effort publishing that never throws, and per-subscriber failure isolation. Restores workflow event-waits (which silently expired) and generic automation fan-in.
- Personal in-app notifications (Phase 2). Each user answers two questions - which events do I want, and where - with an Inbox and an Events matrix under Account. Every notification and preference is owned by exactly one locally authenticated user; recipients are fixed in code per event rather than configurable; preferences are lazy overrides and no external channel is ever enabled by default. 19 events catalogued, all with real producers.
- Rich notification presentation and shared playback primitives (Phase 3). One canonical presentation model backs both the in-app card and the Live Activity dashboard, so playback notifications and live session cards share one implementation. Also fixes a standing privacy defect: liveActivity() returned every session column including ipAddress, and now projects explicitly.
- Personal email notifications (Phase 4). One shared SMTP transport as infrastructure with a personal destination per user - reusing the transport that already existed for newsletters rather than adding a second. Connect-and-verify in one step, encrypted destinations that are never returned, asynchronous bounded-retry delivery that re-checks every precondition at send time, and HTML/plaintext rendering from the canonical presentation.
- Personal Telegram notifications (Phase 5). One shared bot as infrastructure with per-user chat linking via a hashed, single-use, expiring code - a user never types a chat id. Includes rate limiting, replay prevention via an advancing update offset, duplicate-chat protection, and HTML rendering from the canonical presentation.
- Personal Discord notifications (Phase 6). One personal webhook per user, with the SSRF allow-list applied to the supplied host rather than a resolved address so DNS rebinding cannot defeat it. Webhooks are encrypted and never returned, mentions are disabled at the payload level, and messages render as embeds carrying the accent as the stripe colour.
- Wire real producers for all 19 catalogued notification events (Phase 7). Playback, torrents, storage, workflows, providers, security and user events now fire from live code, with edge detection shared by the three polled producers so a restart cannot announce everything that was already broken.
- Notifications rebuild hardening and documentation (Phase 8). Fixes an N+1 in dispatch where the playback-detail permission was resolved per recipient, corrects comments that described build phases rather than behaviour, and adds NOTIFICATION_ENGINE.md, NOTIFICATION_ENGINE_SECURITY.md and DOMAIN_EVENTS.md alongside API, SECURITY, NAVIGATION, UX and README updates.

## [0.47.0] - 2026-07-25

### Added
- Remove the notification engine entirely, ahead of a rebuild from scratch. BREAKING: both the legacy Notification Center and the personal engine are gone, along with the domain-event bus they consumed - which also removes automation and workflow domain-event triggering, since both subscribed to that same bus. 23 database tables are dropped, destroying the encrypted SMTP transport and Telegram bot token; both hosts were backed up first to notification-teardown-backups/.

## [0.46.0] - 2026-07-25

### Added
- Personal Notification Engine phases 1-2: audit, gap analysis, ownership schema, eligibility and RBAC. Phase 1 (docs/NOTIFICATION_ENGINE_GAP_ANALYSIS.md) inventories the three overlapping notification systems and measures them against a live install: all 1729 in-app notifications have a NULL userId (Notification.userId is nullable and delivery goes to the shared authenticated socket room, so every in-app notification is a broadcast and no personal inbox exists); recipient resolution performs no RBAC, permission, resource or eligibility check; and recipient.service.ts resolves recipients from payload.userId while media-server-session.service.ts puts a Plex/Jellyfin provider user id in that same field, conflating two identity namespaces in one unvalidated lookup (latent, not active: 0 of 59 live rules set mapEventUser true). Also records that the provider registry has no Discord (it exists only as a raw URL in the legacy global settings blob) and that NOTIFICATION_EVENTS holds 62 events across 7 namespaces. Phase 2 adds the ownership backbone: UserNotificationProfile, UserNotificationChannel (several connections of one type per user), UserNotificationPreference (override rows only, lazy defaults), UserNotificationEventRoute (normalized, so one event can fan out to several connections of the same type) and UserNotification (personal in-app with exactly one owner), all cascading from users. Adds shared contracts typing channel types (in_app/email/telegram/whatsapp/discord; sms retired, Slack and webhooks classified as integration messages), severities with a rank for minSeverity comparison, delivery modes, quiet-hours behaviours, suppression reasons and a delivery-status lifecycle that keeps provider acceptance distinct from confirmed delivery. Adds NotificationRecipientEligibilityService as the single fail-closed authority on who may own notifications, deliberately looking up by primary key only so an external identity can never be resolved by shared email or username, with a batched filter to avoid an N+1 on the audience path and an ownership assertion that returns an identical message for not-yours and not-found. Adds self-service RBAC (view_own, manage_own, channels.manage_own, deliveries.view_own, deliveries.retry_own) granted to ordinary roles, plus admin diagnostics permissions, with notifications.admin.view_user_summary added to NEVER_INHERITED_PERMISSIONS since it reads another person's activity. The migration is purely additive: legacy tables are untouched and behaviour is unchanged until the Phase 10 cutover. 27 new tests.
- Personal Notification Engine phase 3: typed event catalog and recipient resolution. Adds a code-defined catalog registering all 69 events across 9 namespaces, each declaring category, severity, i18n title/description keys, required payload fields, supported channels, new-user defaults, required permission, audience, deduplication, aggregation, sensitivity and an optional deep-link template. Categories are chosen for how the matrix is read rather than mirroring namespaces, since media/media_server/subtitle/library_cleanup are four namespaces but one mental category while system holds both security and infrastructure events. No default ever enables an external channel: a connection the user has not created cannot deliver, so defaulting one on would promise delivery that silently never happens. Adds NotificationAudienceResolver implementing the intersection the old engine lacked entirely — event audience, eligible local users, active accounts, RBAC permission — and it fails closed, so an unregistered event, an invalid payload or an empty audience reaches nobody rather than everybody. Eligibility is applied BEFORE permissions so an id from another identity namespace never reaches the permission tables, permission_holders and approvers audiences derive from the permission the event itself declares (so a new role resolves automatically), SUPER_ADMIN is matched by role because it holds every permission implicitly rather than through stored rows, and resource_owner resolves to owner and actor deduplicated so one person is never notified twice. Marks the three producer-less media_server events (user_paused, user_resumed, user_stopped) deprecated so the matrix cannot offer a toggle that can never fire, and keeps deprecated definitions resolvable so a stored preference does not break. Also corrects the Phase 1 gap analysis, which reported 62 events across 7 namespaces: that count came from a pattern requiring exactly one dot and silently dropped the three-segment keys workflow.execution.failed and library_cleanup.plan.*. 28 new tests.
- Personal Notification Engine phase 4 (backend): effective preference resolution, personal event routes and the self-service API. Adds UserNotificationPreferenceService resolving catalogue default merged with a stored override, so a user with no rows still has a complete deterministic answer and adding an event to the catalogue is not a data migration across every account. Routes support multiple connections of the same channel type on one event, which is the deliberate improvement over the UniFi model, and every route naming a connection is validated to belong to the acting user: without that check anyone could route their own events through someone else's Telegram chat or email address, reading their destination and sending to it. A foreign connection returns the same message as a missing one so the response cannot confirm that another user's connection exists. Bulk operations report what they skipped rather than silently dropping it, so asking for Telegram on 40 events where 3 do not support it says so instead of quietly doing 37. Adds the account/notifications API where every route derives the acting user from the JWT and no route accepts a userId parameter at all, which is a stronger guarantee than checking ownership on a supplied id because it cannot be forgotten on a route added later; eligibility is asserted per request since an account can be deactivated while a session is still alive. Adds UserNotificationPreference.routesOverridden with a backfilling migration to resolve a genuine ambiguity the tests exposed: zero route rows means inherit the default for someone who only changed the delivery mode (a scalar edit creates the row) but means send nowhere for someone who deliberately cleared every channel, and without recording the intent one of those silently becomes the other, so either the user cannot switch in-app off or a mode change wipes it. Also fixes a bug where the ownership loop iterated the in-app route, whose connection id is null, and rejected valid selections. 26 new tests.
- Personal Notification Engine phase 4b: the personal event matrix UI. Adds Account then Notification events at /account/notifications/events, a searchable and filterable table with one row per registered event showing category, severity, per-channel state and when to send, all scoped to the authenticated user by the API with no user selector because there is nothing to select. The left filter panel narrows by search, category (counts derived from the catalogue so an event added later appears without touching the panel), severity, channel in use, state (enabled, disabled, customized, default, missing connection) and delivery mode, with a clear-filters control showing how many are active. Channel state is never conveyed by colour alone: every cell carries an icon, a title and an aria-label naming the event, the channel and the state, and unsupported channels are disabled rather than hidden so the row shape stays consistent. A bulk toolbar appears only when rows are selected and can enable or disable events, add or remove the in-app route, set the delivery mode and restore defaults, reporting partial results honestly (updated 37, 3 skipped) rather than looking like it did all 40. Clicking an event opens a detail drawer showing description, category, severity, who it is sent to, supported channels, current destinations, delivery mode, quiet-hours behaviour, a security-event marker and a restore-default action. Full en-US and es-PR translations including accessible labels.
- Personal Notification Engine phase 6 (backend): personal channel connections. Adds PersonalChannelService managing per-user connections for email, telegram, whatsapp and discord, where every query is scoped by userId and a connection belonging to someone else is reported as not found rather than forbidden so a response cannot confirm it exists. Config is encrypted at rest with the platform AES-GCM cipher and never returned by any read path: listings render from a destinationMask computed once on write, so the common case never decrypts, and a connection whose config cannot be decrypted after a key rotation is treated as unusable rather than delivering to a garbage destination. Adds Discord as a real personal channel, which did not exist before except as a raw URL in the legacy global settings blob, with an allow-list SSRF guard: the server fetches the webhook URL, so an unrestricted one reaches cloud metadata at 169.254.169.254, loopback, the private network or any internal service name, and the allow-list is applied to the host the user supplied rather than to what it resolves to, plus HTTPS and webhook-path requirements. Adds Telegram linking through short-lived single-use codes stored only as SHA-256 hashes and held in memory so a restart cancels them rather than persisting a bearer credential; direct creation of a Telegram connection is refused because a chat id from the client could point at someone else's chat, a replayed code cannot bind a second chat, and a chat already linked to a different account is refused instead of being silently re-pointed. Phone numbers are normalized to E.164 and a number with no country code is rejected rather than guessed, since guessing a country would silently message a stranger. Connection health is derived from state rather than stored, verification is only ever granted by a real round trip, and revocation is a soft delete that removes routes pointing at the connection while preserving delivery history. Fixes a bug the tests caught where the duplicate-chat guard threw inside a try whose catch swallowed it, silently disabling the check. 36 new tests.
- Personal Notification Engine phase 6b: the personal connections UI. Adds Account then Notification connections at /account/notifications/channels, showing connection cards grouped by type with name, masked destination, health, verification state, default marker, last success and consecutive failures, plus enable, disable, make-default and revoke actions. Destinations are only ever rendered masked because the raw address, phone or webhook URL is encrypted server-side and never returned by any endpoint, so there is nothing on the page that could display it even by mistake. Email, WhatsApp and Discord are added through a form with per-type hints and validation errors mapped to human sentences, while Telegram is added through a one-time linking code shown in the dialog rather than a chat-id field, because a chat id typed into a form could point at somebody else's chat. Revoking a connection reports how many event routes were removed with it rather than silently dropping them, which would look like data loss. Health badges carry an icon and a word so state is never conveyed by colour alone. Full en-US and es-PR translations. Also repairs an i18n regression introduced in this phase: the new page's keys were written into the existing channels namespace, replacing the admin Notification Channels page's sixteen keys; the admin keys are restored and the personal page now uses its own myChannels namespace.
- Personal Notification Engine phase 7: delivery orchestration. Adds UserNotificationDelivery, UserNotificationDeliveryAttempt and NotificationDeadLetter, kept separate from the legacy notification_deliveries table because that one has no owner and ownership is the entire point. A delivery row is created per ROUTE rather than per event, so choosing two Telegram destinations produces two independently retried deliveries and one broken destination never silences the other. Adds PersonalNotificationDispatcher running catalogue validation, audience resolution, eligibility and RBAC, per-user preference, in-app record and per-route delivery queueing, with per-user isolation so one person's failure never affects another and a guarantee that dispatch never throws at the caller because a notification failure must not break the operation that produced the event. Suppression is recorded with a reason (preference disabled, below minimum severity, paused, no route, no verified connection) rather than inferred, since otherwise 'I did not get notified' is unanswerable, and an unverified connection is recorded as a terminal delivery rather than silently dropped so the user can see why a channel they selected produced nothing. Idempotency comes from a unique userId plus dedupeKey index, so a redelivered bus event increments a group count instead of duplicating the notification. Adds a pure delivery policy classifying provider failures into retryable and terminal classes, where credential, destination and payload failures are terminal because retrying cannot change them and hammering a revoked credential is what gets an integration banned, while an unclassified error is retried because a blip is more likely than a permanent rejection. Backoff is exponential with plus or minus twenty-five percent jitter so a provider outage that fails many deliveries at once does not retry them all at the same instant, capped at an hour, and a provider Retry-After header always wins over the computed delay. In-app records emit only to the recipient's own JWT-derived socket room. 33 new tests.
- Personal Notification Engine phase 7 (completion): the transmit worker. Adds PersonalTransmitter, the only place a decrypted destination is touched, which never returns one because failures are reported as classified error codes so nothing upstream can log a credential by accident; provider error bodies are deliberately not captured either, since a webhook echo would put the credential in the logs. Discord posts to the personal webhook, Telegram uses the shared infrastructure bot with the user's linked chat, and email uses the shared SMTP transport with the personal destination address, which is the documented model where no user supplies SMTP credentials so there is no per-user secret to leak. WhatsApp reports honestly that no transport is configured rather than pretending to send. Every provider call is bounded by a timeout so a hung provider cannot pin a worker slot. Adds NotificationDeliveryWorker draining the queue on a schedule with a small fixed worker pool, because these are third-party APIs with per-app rate limits and the failure mode of parallelism is not a slow queue but a rate-limited integration that stops delivering for everyone. Every attempt re-checks preconditions rather than trusting what was true at queue time: an account deactivated, a connection revoked, disabled or unverified since queueing terminates the delivery without a provider call, which is the delivery-after-deactivation failure the engine must not have. Success is recorded as provider_accepted and never as delivered, since a provider taking a message is not a person receiving it. Every attempt is logged with its duration and error class so a flapping destination is visible as a pattern rather than a single last error, terminal failures and exhausted retries are dead-lettered so the evidence survives cleanup of the delivery row, and one delivery raising never aborts the batch. 13 new tests.
- Personal Notification Engine phase 5: the personal in-app inbox and top-bar bell. Adds NotificationInboxService with paging, state filters for unread, read, all and archived, plus category, severity, event and text search, where archived items are out of the way by default because that is what archiving is for and only appear when explicitly requested. Every query is scoped to the acting user and a notification belonging to someone else is reported as not found rather than forbidden so a response cannot confirm it exists. Per-channel delivery outcomes are attached for the whole page in one query rather than per row, since this is the most-opened page in the product and per-row lookups would be a guaranteed N+1. Archiving also marks read, because an archived but unread item would keep the bell lit for something deliberately filed away. Adds the account inbox API with static routes declared before the parameterised ones so unread-count and mark-all-read are not captured as notification ids, a personal inbox page with filters, search, paging, per-item delivery badges, deep links that are re-authorised by the destination route rather than treated as a capability, and a top-bar bell whose unread count comes only from the JWT-derived owner. The bell subscribes to the personal socket room through the shared ws client, which rebinds handlers across reconnects, and polls as a backup so a dropped connection degrades to slightly stale rather than silently wrong. Titles are resolved through i18n with the stored value as fallback, so an event that carried no human title shows its translated name rather than leaking a raw key. Full en-US and es-PR translations. 15 new tests.
- Personal Notification Engine phase 8: quiet hours, digests and the personal profile. All timing is computed in the recipient's own timezone rather than the server's, because a person in Puerto Rico and one in Madrid have different nights and a server reasoning in UTC would wake exactly the wrong one; wall-clock parts come from Intl so daylight-saving transitions are handled by the platform tz database, and an invalid timezone falls back to the server zone rather than throwing since a malformed profile must not stop a notification. Overnight windows are handled explicitly: 22:00 to 07:00 wraps midnight, and a naive start-to-end comparison would make it an empty window and silently disable quiet hours for everyone who set a normal night. The day-of-week test uses the day the window STARTED on, so a Friday 22:00 to 07:00 window stays quiet through Saturday morning instead of ending abruptly at midnight, and start equal to end is treated as an empty window rather than a 24-hour one. Quiet hours are wired into dispatch with four behaviours: bypass delivers anyway, which is what lets a security alert arrive at 3am, suppress drops the event, and respect and digest both defer the delivery to the computed release instant rather than dropping it. The release time is found by stepping forward in whole minutes so a DST shift inside the window cannot land the release back inside it, and a misconfigured never-ending window releases after a cap rather than holding a notification forever. Adds NotificationProfileService and the account profile API for timezone, quiet hours, digest schedules, pause and resume, with validation performed before any write because a stored 25:00 would silently disable quiet hours rather than failing, which is the kind of bug nobody reports. Next digest instants are computed server-side so the UI can say when the next one lands instead of making the user derive it from a time and a timezone. 39 new tests.
- Personal Notification Engine phase 8 (completion): digest assembly and aggregation. Adds NotificationDigest recording each assembled digest so the worker is idempotent across restarts, since a duplicate digest is far more annoying than a late one, and the period end is what the next period starts from so no notification can fall between two digests. Adds a pure assembler where aggregation happens at assembly rather than at dispatch: two torrent-completed events an hour apart are separate notifications because either might be worth opening, but in a daily summary they are one line reading times two, and collapsing at dispatch would lose the individual records while collapsing at assembly keeps both truths. Sections are ordered worst-severity first so a digest opens with what matters rather than with whatever arrived first, lines within a section are ordered by recency, and the rendered body is capped because a message channel has a hard length limit and a four-hundred-line digest is unreadable, with the omitted count reported in the body so the summary never quietly under-states what happened. Adds NotificationDigestWorker which claims the period before assembling so a crash mid-run cannot duplicate it, re-checks pause and eligibility at send time rather than trusting the schedule, records an empty period as empty and sends no message because a digest saying nothing happened is noise, and delivers the digest only to destinations the user had already chosen for the digested events, deduplicated across events so three events routed to the same chat do not send it three times. Unverified, disabled and revoked connections are excluded at send time. 15 new tests.
- Personal Notification Engine phase 9: automation and workflow migration. Adds NotificationActionBridge as the seam between Automation, Workflow and the personal engine, where an action names a registered EVENT and the engine then decides who is eligible, who holds the permission and what each person personally chose; an action cannot name a channel, a destination or somebody who is not a local account. That is the whole difference from what it replaces, where a rule called dispatch with a title and a message and no user at all, producing an unowned in-app row broadcast to every connected client plus a fan-out to one globally configured chat, with no preference to respect because there was no owner to have one. Explicit recipients are validated rather than trusted, since a rule author or a compromised rule can put anything in that list including a media-server user id, and rejections are reported rather than silently dropped so a rule pointing at a deleted account is visible instead of merely quiet. An unregistered event key is refused loudly because a rule that looks configured and does nothing is worse than one that errors. notifyPermissionHolders uses the permission the event itself declares and refuses an event that declares none, since letting the action choose would let a rule widen its own audience. assertNoDirectChannel makes the refusal to address a destination explicit and testable rather than an absence, because a rule naming a Telegram chat would be a global routing decision wearing an automation costume. Adds action migration classification separating personal notifications from integration messages: webhook and Slack address an endpoint rather than a person and are reclassified as integration messages with no recipient, inbox or preference, notify_admin converts automatically because it already named an audience, the free-text actions are flagged for manual review because guessing which registered event they meant would silently re-point a rule at a different audience, and an unknown action is flagged incompatible rather than converted. The planner reports rather than converts. 27 new tests.
- Personal Notification Engine phase 10 (documentation, security model and migration validation). Adds NOTIFICATION_ENGINE.md documenting the ownership model, eligibility, catalogue, recipient resolution, preferences, multiple connections per channel type, each channel's linking and verification, delivery and retries, quiet hours, digests and aggregation, the inbox, automation integration, the API surface and the cutover plan, with nine Mermaid diagrams. Adds NOTIFICATION_ENGINE_SECURITY.md with trust boundaries, the identity model and thirty-three threats each paired with its concrete mitigation and the test that pins it, covering cross-identity, cross-user, credential, network, authorization, availability, administrative and realtime categories, plus a residual-risk section stating plainly what is not yet covered. Adds ops/scripts/notification-engine-validate.sql with twelve queries asserting the invariants the design depends on: no external identity owns a profile, every connection and in-app notification has one eligible owner, every route references a connection owned by the same user, only in-app routes omit a connection, no delivery targets a connection its recipient does not own, no retired channel type is in use, no enabled legacy rule still pins channels, the global credential blob is gone, and no unowned legacy in-app notification remains. Queries one to eleven must return zero rows and are the definition of cutover complete rather than a formality; run today they correctly report the pre-cutover state, flagging the enabled rules still pinning channels and all 1729 unowned legacy rows on a live host. Updates the architecture change log. Full regression run across both workspaces.
- Personal Notification Engine: localized message rendering and channel verification. Closes the two gaps that kept external delivery switched off. Messages now render in the recipient's locale from the notification's own payload instead of sending the raw i18n key, which is what external channels did before: a delivered Telegram message read events.download.torrent_completed.title. Rendering humanizes the event key by default so an event added tomorrow with no translation is still readable, with a small override table holding only the entries the humanizer gets wrong rather than 138 hand-written strings that would rot the moment the catalogue changed and revert silently to a key. Severity leads the subject only where it changes what the reader should do. Body fields are an allow-list, so a payload gaining a secret cannot leak into a message, credential-shaped names are dropped regardless, duplicates are collapsed and the body is bounded because a notification is a nudge rather than a report; an assembled digest body is preserved instead of being replaced by a summary. Adds POST channels/:id/test, which sends a real message and grants verification only on a successful round trip, since a user asserting they own an address would make the flag meaningless and let delivery target something nobody proved they control. A failed test records the classified reason rather than the provider body, which for a webhook can echo the credential, and never revokes an existing verification because one bad night does not mean the address stopped being theirs. Testing another user's connection is refused before any send. 20 new tests.
- Personal Notification Engine: producer cutover. The personal dispatcher now subscribes to NOTIFICATION_BUS_CHANNEL, which turned out to be the actual cutover: producers already emitted registered domain events onto that bus, but the legacy Notification Center was its sole subscriber, so the personal engine sat inert with empty tables no matter what happened. Subscribing needs no producer changes and both engines observe the same bus, so the legacy path keeps working beside the personal one during the transition rather than requiring a flag day. An event the personal catalogue does not register is ignored silently, since the legacy engine may still handle it and warning per bus event would drown the log. Removes the legacy dispatch in torrent-sync, which was pure duplication: it created an unowned in-app row broadcast to every connected client for the same occurrence the domain event beside it already described. Adds automation.rule_failed to the catalogue and rewires the automation engine to emit it rather than dispatching free text, closing the gap that previously made this call site unmigratable; it is deduplicated on rule name because a rule failing on every torrent in a sweep is one problem rather than fifty. Recipient ids carried in a payload are passed to resolution but never trusted, so an id from another identity namespace cannot become a recipient. 5 new tests, and three existing suites updated to assert the new behaviour rather than the removed legacy call.
- Personal Notification Engine: the quiet-hours and digest settings UI. Adds Account then Notification settings at /account/notifications/settings covering timezone, quiet hours, daily and weekly digests and the global pause. The timezone is presented first and explained rather than buried as an advanced option, because everything below it is evaluated in that zone rather than the server's, and the picker offers the browser's own zone alongside a short curated list. An overnight quiet-hours window, where the end time is before the start, is labelled as such instead of being left to look like a mistake, since a normal night crosses midnight. Day selection states plainly that leaving every day unchecked applies the window daily. Next digest instants are shown from the server-computed values so the user is not asked to derive them from a time and a timezone. Pause is placed first because somebody opening this page in a hurry usually wants it, and offers one-hour and twenty-four-hour options with the resume state and expiry shown. Save errors surface the backend's own validation message rather than a generic failure, since the backend validates times and zones before writing and a generic message would hide which field was wrong. Full en-US and es-PR translations under a mySettings namespace, deliberately kept separate from the admin notification settings page's existing settings namespace so the locale diff is purely additive.
- Rich playback notification presentation: a canonical, channel-neutral presentation model shared by the in-app card, email, Telegram and Discord. Started/stopped watching notifications now render as rich cards with accent colour, initials avatar, media artwork, fact table and progress, with per-recipient redaction applied server-side.

## [0.45.0] - 2026-07-25

### Added
- Per-user notification routing profiles, and recipients derived from platform users. Previously a recipient was a hand-made island whose userId nothing populated, and routing was global: channelsFor() resolved rule.channelIds then the recipient's single preferredChannelId then the isDefault channels, and NotificationPreference could only subtract (opt-out), so a rule pinned to Telegram put email out of reach for everyone and no user could choose their own destinations per event. Adds NotificationRouting (recipientId, event, channelIds) expressing positive routing — 'send me THIS event on THESE channels' — where event is an exact name, a namespace wildcard (system.*) or *; resolution takes the single most specific line (exact > namespace > catch-all), never a union, so 'all system alerts by email except backup failures to Telegram' is expressible. Namespace wildcards also apply to opt-out preferences. The delivery precedence becomes: a forced rule's channels, then the recipient's routing line, then the rule's channels, then preferredChannelId, then defaults. NotificationRule.forced is the counterweight to letting users win: an admin can pin a security or system alert so a routing profile can neither redirect nor mute it (forced also bypasses opt-outs). A routing line naming only disabled channels falls through rather than silently delivering nowhere. RecipientProvisioningService reconciles recipients with users idempotently at boot, on user create/update/delete (resolved via ModuleRef to avoid a module cycle), and via POST /notifications/recipients/reconcile: it creates a recipient per user, ADOPTS an existing unlinked recipient whose email matches a user rather than duplicating it (so an already-configured Telegram chat id is not orphaned), follows renames and deactivations, and disables — never deletes — a recipient whose user is gone, preserving its profile and history. External recipients without a matching user are left untouched. New Routing Profiles page (namespace-first, with per-event overrides, showing where each event actually lands and locking forced rules), and the Recipients page now marks each row user-derived or external and refuses to delete a user-derived one. 17 new tests covering every precedence branch, wildcard specificity, the forced override, stale-channel fallback and all six provisioning cases including idempotency.

## [0.44.1] - 2026-07-24

### Fixed
- Ships the notification actor/action card rendering that the v0.44.0 changelog already described. That work's changeset was consumed into the 0.44.0 release while its code was still uncommitted in a working tree, so the v0.44.0 tag and the images built from it do not contain it; v0.44.1 is the first release whose tag actually includes the code. No behaviour is added beyond what 0.44.0 documented: NotificationCard's actor/action fields, the shared cardContext() rendering across text/markdown/SMS/HTML-email, and actor sourced from the payload's actorName only (never the recipient fallback userDisplayName). Anyone running 0.44.0 needs 0.44.1 to actually get it.

## [0.44.0] - 2026-07-24

### Added
- Notification rules: choose which channel(s) deliver each rule, with an apply-to-namespace bulk action

### Fixed
- Missing-episode detection no longer reports an announced-but-unreleased season as missing. The owned-vs-catalogue diff decided 'has this aired?' from the IMDb year alone (airYear > currentYear ? unaired : missing), which cannot tell an episode that aired earlier this year from one merely announced for later this year — both have airYear === currentYear. Ahsoka's season 2 (eight episodes IMDb stamps 2026, not yet released) was therefore flagged missing and would trigger fruitless searches. Classification now consults a TMDB 'aired boundary' — the last-aired season/episode from last_episode_to_air, resolved from the series IMDb id via /find — and treats an episode as aired iff it is at or before that boundary; for Ahsoka the boundary is S1E8, so season 2 is provably unaired even though TMDB does not list season 2 at all. The boundary is fetched only when the year check is actually ambiguous (some not-owned episode dated to the current year or with no year), so a fully-past library makes no network call, and any failure (no TMDB key, unresolved show, network) falls back to the previous year-granularity behaviour. Adds a pure classifyEpisode function with unit tests plus scanSeries coverage of the Ahsoka case.
- Notifications name the acting user and what happened, not just the media title
- Missing-episode search records a total indexer outage as failed instead of no_results. IndexerService.searchAll isolates per-indexer failures so one broken indexer cannot sink a search, but it swallowed them entirely — so when EVERY indexer failed it returned an empty candidate list indistinguishable from an honestly empty catalogue, and the caller stamped the episode no_results ('we looked and this release does not exist') when in truth nothing had looked. Observed live: Prowlarr had put EZTV (unreachable) and The Pirate Bay (over its request limit) in failure backoff, leaving only a current-episodes-only indexer, and all 113 missing 9-1-1 episodes were recorded as no_results. Adds searchAllDetailed returning the candidates plus run health (queried, failed, per-indexer failure messages); searchAll delegates to it and is unchanged for existing callers. The missing-episode search now reports failed with an auditable media_acquisition.missing_episode.indexers_unavailable record naming which indexers failed and why, but only when queried > 0 and every one of them failed — a partial outage still yields the surviving indexer's answer, so an empty result there is real and stays no_results. Retry behaviour is unchanged (failed and no_results share the same backoff); what changes is that the state is now true.

## [0.43.2] - 2026-07-24

### Fixed
- Fix dead Duplicate Center bulk/quick-clean endpoints — they were shadowed by the :groupId routes. The static routes (duplicates/bulk/preview, duplicates/bulk/resolve, duplicates/quick-clean/candidates, duplicates/trash/history) were declared AFTER duplicates/:groupId/preview etc., and Nest matches in declaration order, so POST duplicates/bulk/preview was captured by duplicates/:groupId/preview with groupId='bulk' and rejected with 400 'property groupIds should not exist'. The UI's Quick Clean button hit exactly this. All literal duplicate routes are now declared before the parameterized :groupId routes; a route-ordering regression test introspects the controller metadata so a literal route can never again be declared behind a parameter route that would capture it. Verified live: POST duplicates/bulk/preview now reaches its handler (201 with succeeded/failed/results) instead of the whitelist 400.
- Duplicate detection no longer groups a film with its same-year sequel on a shared external id. The movie matcher already refuses to write a sequel's id onto its predecessor, but that only protects ids written after the gate landed and nothing re-fetches the rows the old matcher poisoned: observed live, 'Ultimate Avengers' and 'Ultimate Avengers 2' (separate files, both 2006) both carried imdb tt0803093 / tmdb 14611 and were reported as one duplicate offering 1.15 GB of savings that would have deleted a different film. The movie external-id key is scoped by year, which cannot help here because a film and its sequel routinely share a release year, so detection now applies the same sequel gate independently and splits such a bucket. The split is pairwise rather than by sequel number, so a numbered copy and a subtitled one ('Ultimate Avengers 2' vs 'Ultimate Avengers 2 Rise of the Panther') stay together as the one film they are, and two copies of the sequel itself still group whether numbered in arabic or roman. Ids are sorted before splitting so the resulting group keys are identical on every scan and an operator's 'not a duplicate' decision stays attached.
- Item identification climbs past an unrenamed release folder to the show root, so a not-yet-renamed season pack is titled for its show instead of the release. When a whole season is downloaded but not renamed, the torrent's release folder still sits between the show root and the Season folder (From (2022)/From.S04.1080p.WEBRip.10Bit.DDP5.1.x265-NeoNoir/Season 04/...S04E08.mkv). showFolderName stopped at that release folder, which the name parser reads as the junk title 'From S04' (the .S04. glues onto the title because no episode number splits it off), so the episode was stored as 'From S04' beside its already-renamed sibling 'From' and the two showed up as a same-show duplicate with mismatched names. The climb now skips a release folder as well as generic Season/Specials/Disc containers: a folder whose parse carries scene/quality tokens (resolution, source, codec, release group) or a bare season marker names one release, never the show, so it is passed over in favour of the show-root folder above it (from which the correct title and year 2022 are recovered). The first non-generic parent is still kept as a fallback, so a flat scene release with no show-root wrapper is unchanged. This matches the position-based showFolderOf, which already resolves nested release dirs to the direct library child. Detection was already correct here (both copies share seriesImdbId tt9813792); only the stored title was wrong.
- Fix the external-id URL going stale on a metadata re-fetch. media-metadata.service.ts's mediaExternalId upsert rewrote externalId in its update branch but not the url, which is derived from the id — so after a re-fetch corrected 'Ultimate Avengers' from tt0803093 to tt0491703, the 'View on IMDb' link still opened the sequel. The update branch now recomputes url alongside externalId via externalUrl().
- Fix the duplicate-group table blowing past the viewport when a file path is very long. The Item cell shows the path in a truncate element, but the table used the browser default auto layout, in which a cell grows to its content's intrinsic width before overflow:hidden can clip — so a long unrenamed release path (e.g. The.Lincoln.Lawyer.S02.COMPLETE.720p.NF.WEBRip.x264[eztv.re] nested twice) expanded the column and broke the page layout. The list table is now table-fixed with the four short columns (Year, S/E, Resolution, Size) pinned to fixed widths and marked whitespace-nowrap, so the Item column takes the remaining width and its title/path truncate within it as intended.

## [0.43.1] - 2026-07-23

### Fixed
- Duplicate detection no longer groups two different shows that share a title. Episode duplicate keys were built from normalized title + season + episode only, so S01E03 of 'Invasion' (2005) and S01E03 of 'Invasion' (2021) — two unrelated series — collapsed into one 'Same show / season / episode' duplicate. Detection now establishes show identity FIRST: episode keys (show_season_episode, the TV external-id scope, and the episode-scoped similar_filename) are scoped by the parent series id (seriesImdbId) when present and by title+year otherwise, and BOTH signals are emitted so genuine duplicates still group when either agrees — an identified copy matches an unidentified same-year copy, and two copies sharing a series id match even if one is missing its year — while two shows that merely share a title differ on both and never collapse. seriesImdbId is now loaded into the detection query. Existing libraries need media_duplicate_scan_state cleared for the corrected logic to re-run (the scan digest covers data, not code). 6 new regression tests.

## [0.43.0] - 2026-07-22

### Added
- Library Cleanup Center Phase 2 — data model, permissions & module manifest. Adds nine additive tables (media_cleanup_policies/policy_versions/runs/candidates/plans/actions/protections/quarantine_items + media_playback_aggregates) in migration 20260722030000_library_cleanup_core. Audit-bearing rows reference media by plain id (no FK) so a candidate's snapshot outlives the media row — the same rationale as MediaDuplicateCandidate.path; only the derived playback aggregate uses a cascading FK. Adds the 19-permission library_cleanup.* block and, per decision D-5, a NEVER_INHERITED_PERMISSIONS set so ADMINISTRATOR's blanket ALL_PERMISSIONS inheritance no longer hands out library_cleanup.permanent_delete or protection.legal_hold (nor system.manage, as before) — they must be granted deliberately. POWER_USER receives view/simulate/protection.view only. Registers the library_cleanup core module manifest (route /api/media/cleanup, Media workspace). No cleanup behaviour yet: schema, permissions and manifest only.
- Library Cleanup Center Phase 3 — measured technical & playback facts. Fixes two shipped defects that would let a filename guess drive a deletion: the scanner now stamps techSource:'filename' on both write paths (a never-probed row was previously indistinguishable from an unset one), and a rescan no longer overwrites probe-measured tech with filename guesses — previously it did, and the row was then never re-probed because the backfill's working set is 'probedAt: null', so the guess stayed permanently. Adds six measured colour/depth columns to media_files (videoBitDepth, chromaSubsampling, colorPrimaries, colorTransfer, colorSpace, hdrFormat) parsed from the mediainfo Video track; hdrFormat keeps the FULL string while the legacy truncated hdr field is untouched for its existing consumers. Adds a cleanup resolution classifier with the missing tiers (576p/1440p/4320p) and a total ORDER, since 'resolutionClass < 1080p' is a comparison a string label cannot answer; it classifies from measured width/height only and is consistent with the existing stored-label classifier on shared tiers, which is left unchanged to avoid re-labelling ~29k rows. Adds the pure playback aggregation core: a play counts as completed only at/above a threshold defaulting to 90 (stricter than Trakt's 80), same-session observations collapse so heartbeats and re-imports cannot inflate counts, rows without a progress reading are never counted as completed, and an aggregate the caller cannot vouch for is untrustworthy — absence must never read as 'never watched'. 34 new tests.
- Library Cleanup Center Phase 4 (part 1) — protection matcher. The pure, exhaustively-tested core of the Protection Registry: given a target and the stored protections, decide whether automatic cleanup is forbidden and why. Matches by stable database identity across all twelve scopes (file, item, show, season, episode, library, path prefix, tag, collection, watchlist, torrent, external identity); canonicalPathSnapshot is deliberately NOT consulted, since a moved file is still the same file and matching on its old path would both miss it and protect whatever now occupies that path. Path-prefix matching respects path-segment boundaries so /media/Movies cannot protect /media/Movies2, and normalises traversal first. Revoked and lapsed temporary protections stop protecting; permanent ones never lapse; legal holds are surfaced distinctly so an ordinary operator cannot lift one. Conditional protections FAIL CLOSED — an unknown fact or an unrecognised condition keeps the target protected, because uncertainty must never become deletion. Every matching rule is returned, not just the first, so the UI can explain all of them. 29 tests.
- Library Cleanup Center Phase 4 (part 2) — Protection Registry service and API. Adds ProtectionService (create, bulk create, list, get, expiring-soon, revoke, evaluate) and the first LibraryCleanupModule routes under /api/media/cleanup/protections, RBAC-guarded and audited. Removal is a REVOCATION, never a delete, so the audit history survives. Shape validation refuses a protection whose scope field is missing, since that would silently protect nothing — the worst possible outcome for a safety registry. Legal holds are re-checked inside the service, not only at the route guard, because a job or workflow path can reach the service without traversing the controller; creation and revocation of a hold are audited under distinct actions. Bulk creation reports partial outcomes honestly, naming the index of each entry that failed rather than silently dropping it. A six-hourly expiry sweep announces only the protections whose deadline crossed since the previous tick, so a restart replays no backlog and a quiet period stays quiet; lapsing itself is done by the matcher, not the sweep. 42 new tests.
- Library Cleanup Center Phase 5 (part 1) — condition catalogue, policy document and evaluator. Adds a catalogue of ~60 conditions across metadata, playback, technical, storage and safety, read by the validator, the evaluator and the UI palette alike so a policy can never reference something the engine cannot evaluate. Adds the typed policy document (nested ALL/ANY groups, scope, mandatory exclusions, replacement requirements, action, storage-pressure) with structural bounds on condition count, nesting depth, group width and document size; the document is DATA, never code, so there is nothing to eval. Adds the nested evaluator, which reuses the Workflow Builder's constrained operators — the same eight the Automation Engine uses — so a cleanup policy branches exactly like a rule and no second expression language exists. Its critical departure from boolean logic is a third outcome, UNMEASURED: a probe-only condition on filename-derived or absent data does not evaluate to false, it makes the evaluation unmeasured so the caller excludes the candidate rather than matching or dismissing it. A definite false still settles an ALL, and a definite true still settles an ANY. Unknown condition ids fail to unmeasured rather than a silent false. 17 evaluator tests.
- Library Cleanup Center Phase 5 (part 2) — policy validator. Strict, side-effect-free validation gating publication: structural bounds (condition count, nesting depth, group width, document size), catalogue coherence (unknown condition ids, unsupported operators, value type and enum mismatches), and destructive limits. Unattended permanent deletion is refused as a policy destination outright — permanent removal stays a manual, separately-permissioned operation. Automatic modes are held to a materially higher bar than report-only: an automatic policy must be scoped to at least one library/kind/path (an unscoped one addresses every library at once), must cap items or bytes per run and stay under the automatic ceiling, must set a grace period so a file added minutes ago cannot be deleted before it had the chance to be watched or probed, and may not accept filename-inferred technical values either globally or per condition. Report-only policies get warnings where automatic ones get errors. Replacement-aware cleanup must state at least one requirement a replacement has to meet, and a storage-pressure policy must be capped and have a reachable stop target, since a stop threshold at or below the trigger can never be reached. 25 tests.
- Library Cleanup Center Phase 5 (part 3) — PolicyService, immutable versioning and the policy API. Policies now follow the Workflow Builder's versioning invariant: at most one mutable draft, publishing freezes that draft into an immutable version, and the next edit forks a fresh draft from it, so editing a policy can never change what an in-flight cleanup is doing. A stable content checksum canonicalises key order (so reordering JSON is not a change) while preserving array order (in an ANY group, branch order is evaluation order) and ignores prose notes. A new policy is inert by construction: disabled, report-only, unscoped. Publishing deliberately does NOT enable — arming a destructive policy is a separate, separately-permissioned act. Adds the policy REST surface under /api/media/cleanup: catalog, stateless validate, CRUD, PUT draft, publish, enable, disable, archive, delete; all RBAC-guarded and audited, with catalog/validate declared before the :id routes. An invalid draft is saved as validation_failed rather than rejected, so an operator can save work in progress, but publish refuses it with 422. Each version records the fact keys its document reads, which will drive the policy-scoped input digest. 14 service tests.
- Library Cleanup Center Phase 5 (part 4) — starter templates, and a resolution-comparison bug fix found by writing them. FIX: an ordered enum was authored as a human label ('resolutionClass < 1080p') but the underlying fact is an ordinal, so the numeric comparator ran Number('1080p') = NaN and every such comparison was false — the brief's own headline policy would have silently matched nothing. The evaluator now coerces an enum label to its ordinal for ordinal operators, and an unrecognised label yields unmeasured rather than a NaN comparison. Equality on enums still compares labels. Adds three starter templates shipped as CODE rather than seeded rows, because seeding destructive-shaped policy records into every install — even disabled ones — puts objects in the database nobody asked for; a template creates nothing until deliberately instantiated, and what it creates is an ordinary draft the operator owns, still disabled and unpublished. Templates: old unwatched low-resolution movies (approval-required), low-use 10-bit media (REPORT-ONLY by design, since 10-bit is usually the better encode), and superseded 8-bit H.264 with a verified equal-or-better replacement (approval-required, quarantine). Tests assert every shipped template is publishable, none deletes unattended, none targets permanent deletion, and all keep the mandatory exclusions plus a grace period. Adds GET /templates and POST /policies/from-template. 19 tests.
- Library Cleanup Center Phase 6 (part 1) — candidate fingerprints, mandatory exclusions, and a fix for locked items being deletable by duplicate cleanup. FIX (G10): MediaItem.locked takes an item out of every automated path — scans, enrichment, the organizer, the renamer, automation — but duplicate cleanup was the one destructive path that never consulted it, so a locked item's file could still be trashed. The check now runs at execution rather than preview, so a lock applied while the operator was deciding still takes effect. Adds the candidate fingerprint: what 'the world has not changed' means, recomputed immediately before the filesystem step so a file replaced, resized, moved, re-probed, newly protected or newly watched between approval and execution is skipped rather than deleted. It covers only policy-relevant facts, because hashing everything would invalidate every plan on unrelated churn until 'changed' stopped meaning anything — but protection and replacement state are always included, since they are safety inputs to every decision rather than optional conditions. A diff names exactly what moved so a skip can say why. Adds the mandatory exclusion pass, enforced server-side regardless of the policy document or what the UI displayed: protection and legal hold, locked, path confinement, active playback, incomplete downloads, in-flight operations, active jobs, pending duplicate resolutions, grace period, ambiguous identity, unmeasured technical data, untrustworthy playback aggregates, an optional substantial-progress guard, the last surviving copy, and a required-but-unverified replacement. An unknown added-date fails closed. 42 new tests.
- Library Cleanup Center: candidate discovery runs, cooperative cancellation, and explainable ranking
- Library Cleanup Center: persisted plans, approvals with per-destination permission gates, and plan expiry
- The rename preview now shows only the files that actually change. A settled library is almost entirely files already sitting at their destination, and listing them buried the handful that move: one live show planned 346 rows of which just 10 were genuine renames. Plan items now carry an 'unchanged' flag (derived once, centrally, so a new push site cannot forget it), the preview hides those rows behind a 'Show N files already in place' toggle and counts only what it shows, and the executor skips them instead of renaming a file onto itself and counting it as applied work. The reason so few rows were no-ops is fixed too: the TV and anime templates rendered '{Series Title}' with no year while the MOVIE templates already carried '({year})', so every correctly-filed episode in a 'Show Name (Year)' folder — 701 of 704 folders on the live library — was planned as a move OUT of its own folder, and applying it would have restructured the whole library and lost the disambiguation between shows like 'And Just Like That (2021)' and 'And Just Like That... (2021)'. All four presets now render '{Series Title}{year? ({year})}' for tv and anime, using the existing optional-token syntax so a show with no known year gets no empty '()'. Combined, the live show's preview drops from 346 rows to 34.
- Library Cleanup Center: quarantine, path-safe removal, restore, and the G12 storage-scope restore fix
- Library Cleanup Center: scheduled runs, storage-pressure trigger with recovery target, caps and a circuit breaker
- Library Cleanup Center: Jobs Center integration, security threat model and documentation — the 10-phase feature is complete
- Library Cleanup Center: the frontend UI — Cleanup Center overview, policies, runs & candidates, plans & approvals, quarantine and protections

### Fixed
- Cancel the in-flight IMDb trigram index build on shutdown instead of blocking on it. ImdbTrigramIndexService fires a CREATE INDEX CONCURRENTLY off the boot path and never tracked it, so PrismaService.onModuleDestroy -> $disconnect() waited on that statement and stalled shutdown for the rest of the build (6-10 min measured). systemd then SIGKILLed at TimeoutStopSec, so nothing closed cleanly. The service now retains the in-flight promise, refuses to start another index once shutdown has begun, and cancels the running build with a targeted pg_cancel_backend before Prisma disconnects. The build is matched in pg_stat_activity by statement text rather than a PID captured up front, because Prisma pools connections and a separately-issued pg_backend_pid() can name a different backend than the one running the DDL; the lookup excludes the caller and is scoped to the current database. The cancel is issued server-side inside that same statement rather than reading the pid back into JS and calling pg_cancel_backend($1): Prisma marshals a JS number as int8, only the int4 overload exists, and the call fails with 42883. That defect passed all nine unit tests and was caught only by the live SIGTERM check now documented in OPERATIONS.md — a mocked client reproduces neither hook ordering nor parameter marshalling. A cancelled build is logged as ordinary shutdown, not as a failure. Verified live: stop went from ~8-9 min to 208 ms, with the build confirmed gone from pg_stat_activity. 4 new tests.
- Duplicate detection no longer groups a film with its 'Part N' continuation. Root cause was the filename parser, which cut the title at a numeric "Part N" marker: "South Park the Streaming Wars Part 2 (2022)" parsed to "South Park the Streaming Wars", TMDB then legitimately matched that to Part 1, and the sequel inherited the first film's tmdb/imdb ids — so detection grouped the two on BOTH the external_id and title_year keys. "Part N" now ends the title only for an episodic release, where it numbers a multi-part episode; for a film it is title text. This also removes an inconsistency, since a spelled-out part ("Dune Part Two") never matched the regex and already survived. As a second, independent gate, titlesAreSequelVariants now treats an ordinal qualifier (part/pt/chapter/ch/vol/volume) as belonging to the sequel number rather than the base title, so "… Streaming Wars Part 2" conflicts with "… Streaming Wars" and "The Godfather Part II" with "The Godfather"; the qualifier is never stripped down to an empty base, which would make every qualifier-only title collide. Existing libraries need a re-identify pass to correct rows already stamped with the wrong film's ids.
- A subtitle now follows the episode it names, not the video whose filename happens to share the most characters. In a library holding both organised and raw-release names the two styles diverge immediately, so prefix scoring ranked a DIFFERENT episode above the right one: for "lucifer - s05e10 - bloody celestial karaoke jam.fin" the correct video (Lucifer.S05E10.1080p.HEVC.x265-MeGusta) scored 7 while "Lucifer - S05E12 - Daniel Espinoza Naked and Afraid" scored 15 and won. Replayed against the live Lucifer folder, 12 of 45 planned subtitles were aimed at the wrong episode; only 6 of those collided with another subtitle, so the remaining 6 raised no conflict at all and would have been silently reattached — the renamer's conflict check compares destinations, and a lone wrong destination collides with nothing. When a subtitle names an episode, only a video that IS that episode may claim it (a multi-episode file covers its whole span, and season is compared only when both sides carry one, so absolutely-numbered anime is unaffected); prefix similarity now merely breaks ties among those candidates. A subtitle whose episode has no video in the batch is skipped with a reason instead of being attached to the closest-looking name. Subtitles carrying no episode at all keep matching by name similarity, so a movie's "2_English.srt" still attaches.
- A metadata sidecar now follows its video across naming styles. A sidecar is named after the video it describes, but the pass matched only the video's CURRENT basename — so when an episode's .nfo/-thumb were already organised while the video itself arrived as a raw release (or vice versa), the two names shared no prefix and every sidecar was dropped as a 'non-media file', left behind describing nothing. It now also matches the name the video is being renamed TO, since that is the name an already-organised sidecar was built on; the suffix still comes out of whichever name matched, so no sidecar marker has to be enumerated and -thumb.jpg / -mediainfo.xml keep working. The same episode-identity gate the subtitle pass uses is applied here too: when both sides name an episode they must be the same episode, so a coincidental prefix cannot carry a sidecar across episodes. Replayed against the live Lucifer folder this rescues 14 previously-orphaned sidecars (35 skipped down to 21, 174 moved up to 188) with zero cross-episode attachments, and all 18 show-level artwork files (poster/fanart/banner/seasonNN-*) are still correctly left standing where they are.
- Library Cleanup Center Phase 6 (part 2) — fact assembly and explainable ranking. Fact assembly turns raw media/playback/context rows into the facts the evaluator and the exclusion pass read, as a pure function so the mapping is tested directly rather than through a database. Its governing rule: a fact that could not be established stays undefined, never a substituted default — filling a blank with 0, false or 'unknown' would quietly convert 'we do not know' into 'it qualifies'. Most importantly, an item with no playback aggregate row reports NO playback facts rather than zero plays, so a policy asking about completed plays evaluates as unmeasured instead of matching; a genuinely empty aggregate still reports zero. Resolution is classified only from probe-measured pixels, and a 1920x800 scope encode stays 1080p. Identity ambiguity is derived, since no column records it: unmatched is ambiguous, hand-corrected never is, and a low-confidence match with no external id is. Adds candidate ranking for storage-pressure runs — a fixed set of weighted, named factors each contributing stated points with a human-readable reason, so an operator can read why this file and not that one and disagree. Weights are spaced so a verified replacement cannot be outvoted by the sum of weaker signals, reclaim size saturates so one enormous file cannot dominate, and rating is weakest because it is someone else's opinion. Ordering is deterministic including ties. 18 tests.
- Subtitle language codes are now defined once. They were defined FIVE times — renamer, sidecar scanner, local-repository provider, scraper name map — and the copies disagreed: the renamer knew 18 languages, the name map 44, and the local-repository provider was missing the three-letter form of six languages it already accepted in two-letter form. The divergence deleted files: the cleanup pass keeps a subtitle only when its normalised code is in the keep-list, and an unrecognised code normalised to itself, so a library of .heb/.hun sidecars against a keep-list written the way the field documents it ('ISO-639 codes' — he, hu) matched nothing and those subtitles were deleted, while .eng survived purely because eng was one of the 18 hard-coded aliases. Whether a file lived depended on which spelling the operator happened to type. common/languages.ts now holds one row per language — 639-1 code, English name, every alias (639-2/B and /T both, plus legacy and provider spellings) and alternate names — covering 73 languages, and the four call sites read from it. Also fixes a latent misread in the two filename scanners: both claimed to inspect trailing tokens but scanned every one, so 'No.Country.For.Old.Men.srt' reported Norwegian; with a table this size that matters much more, since is/it/id/no/la/my are ordinary English words too. They now scan right-to-left and stop at the first token that is neither a language nor a flag, with the rightmost tag winning on a dual-tagged release.
- The rename preview collapses skipped files too. Files the plan will not touch are not rename candidates either, and 30 of them sat between the 44 rows that were real work on a live show. They now hide behind their own 'Show N skipped files' toggle, alongside the existing one for files already in place. The two groups are disjoint by construction — the plan only marks 'unchanged' on a file it did not skip — so the counts never double-report. A skipped row keeps its reason (e.g. 'no video for episode S05E14 in this batch'), so the diagnostic is one click away rather than gone, and plan-level warnings stay visible above the list regardless. The live show's preview now opens on 44 rows out of 352.
- A rename no longer leaves a space before the file extension. Illegal filename characters are replaced with a SPACE, so a title ending in one put that space right against the extension: Lucifer S01E08 ('Et Tu, Doctor?') planned a rename to 'Et Tu, Doctor .mp4'. Neither existing guard could catch it — renderTemplate's tidy-up runs BEFORE sanitisation, when the '?' is still present and there is no stray space to see, and the trailing trim only inspects the very end of the segment, where the extension sits. sanitizeSegment now drops whitespace that ends up against the extension, and the dangling ' - ' left when a title consisted entirely of illegal characters. The extension match allows a compound suffix so a subtitle's language tag ('.en.srt', '.en.forced.srt') is handled rather than missed. Beyond producing a wrong name, this made an already-correct file look like pending work in every preview forever; such files are now correctly reported as unchanged and disappear from the list.

## [0.42.1] - 2026-07-22

### Fixed
- Restore the UltraTorrent logo in the sidebar. The Workspace-rail brand mark and the collapsed-sidebar header were left showing a 'UT' gradient placeholder after the navigation remake; both now render the actual logo mark. Adds public/logo-mark.png — a tight square crop of the brand emblem (transparent background, so it composites cleanly on the dark rail) generated from art/logo_initial.png. The user-initials avatar is unchanged.

## [0.42.0] - 2026-07-22

### Added
- Workflow Builder Phase 3 — node registry & strict graph validation. Trigger/Action node definitions are generated from the Automation catalog (AUTOMATION_TRIGGERS/ACTIONS) so visual nodes always reference real registered triggers/actions; built-in control nodes (condition/branch/delay/wait/parallel/join/transform/variable/approval/subworkflow/end + manual/scheduled/webhook triggers) are declared in the registry. A strict, side-effect-free validator enforces schema version, node/edge limits, unique ids, known types, exactly-one-trigger-family, trigger/end port rules, valid edge endpoints/ports, acyclicity, reachability, bounded delays, wait/approval timeout handling, destructive-node safeguards, scheduled-trigger identity, and (when context supplied) permission + module gating and subworkflow self-recursion. 39 domain tests.
- Workflow Builder Phase 4a — backend WorkflowsModule & API. Adds workflows.* permissions (view/create/edit/delete/publish/run/approve; admin auto-inherits, POWER_USER gets view+run). New WorkflowService (CRUD, single-mutable-draft versioning, publish freezes the draft into an immutable published version and forks a fresh draft on next edit, graph validation on save/publish, stateless /validate, node catalog) and RBAC-guarded WorkflowsController (/api/workflows: catalog, validate, list, create, get, update, PUT graph, publish, enable, disable, archive, delete) with DTO validation, pagination caps, audit on every mutation, and a 512KB graph-size ceiling. Registry wired into a real module; boot-verified.
- Workflow Builder Phase 4b — visual editor (@xyflow/react). Adds the Workflows UI: a searchable/paginated list with a create dialog, and a lazy-loaded canvas editor (kept off the main bundle) with a catalog-driven node palette (grouped by category, so it always reflects the real registered triggers/actions — no drift), typed port handles per node, a node settings panel (required config, destructive-acknowledgement safeguard, delay/wait timeouts, free-form config), live debounced validation with clickable issue markers, save-draft/publish/enable/disable, read-only mode when the user lacks workflows.edit, and an accessible non-canvas graph representation. New workflows API client + full en-US/es-PR i18n namespace (parity green) + Automation-domain nav entry. Node definitions now carry a display label sourced from the automation catalog.
- Workflow Builder Phase 5 — simulation / dry-run. A no-side-effect executor walks the validated, acyclic graph in topological order: conditions and branches are evaluated with the SAME operator semantics as the Automation Engine (a shared constrained evaluator — eq/neq strict, numeric comparators coerce, contains=includes, matches=case-insensitive regex; never eval/Function), variables are set, and action inputs are rendered ({{path}} templating) — but no provider is ever called. Actions/delays/waits/approvals are recorded as 'would happen' (approvals auto-approved with a warning; joins wait for all inputs). New POST /api/workflows/:id/simulate (workflows.run, audited, accepts a graph/trigger/vars override). Editor gains a Simulate button + trace panel showing the ordered per-node decisions, rendered action inputs, and which actions would run. 11 new backend tests; full green gate.
- Workflow Builder Phase 6 — durable execution engine. A restart-safe graph executor over relational state: an execution is pinned to the immutable WorkflowVersion it started on; every node's progress is persisted to workflow_node_executions and the pure scheduling core (execution-planner) recomputes the next ready wave purely from the database, so a process restart resumes in-flight executions (interrupted running nodes are marked failed, since non-idempotent side effects can't be safely re-dispatched). Actions dispatch by REUSING the Automation Engine (new AutomationEngine.runWorkflowAction wraps its real per-action dispatch — never reimplemented). Per-node retries, timeouts, and cooperative cancellation are honored; a failed action routes to a wired failure branch or fails the execution. Conditions/branches/variables/templating are shared with the simulator so dry and real runs branch identically. Triggering rides the single shared domain-event bus (WorkflowTriggerBridge, no second bus) plus a manual run endpoint. New RBAC-guarded, audited endpoints: :id/run, :id/executions, executions/:executionId(/cancel). Delay/wait/approval persist as durable pause points resumed in P7; Jobs Center parent/child linking deepened in P8. Editor gains Run + recent-runs. 68 backend module tests incl. an in-memory-Prisma run-loop suite; full green gate.
- Workflow Builder Phase 7 — durable waits, approvals & sub-workflows. Turns Phase 6's pause points into real resumable waits (single-active-wait model matching the schema's execution-level resumeAt/expiresAt): delays set resumeAt; wait-for-event sets waiting_for_event + expiresAt; approvals create a WorkflowApproval gate; sub-workflows start a version-pinned child execution (parentExecutionId/depth, guarded to depth 5). One idempotent resume(executionId, port) advances the waiting node and continues the durable run; accumulated variables survive the pause (persisted in outputSummary.vars, reloaded on resume). Time-based resume rides the existing @nestjs/schedule (no second scheduler): a single WorkflowResumeService @Interval resumes due delays and expires event/approval waits. Event resume rides the shared bus (WorkflowTriggerBridge matches a wait node's eventType). Sub-workflow completion resumes the parent down out/failure. Approval center: GET /workflows/approvals/pending + POST /approvals/:id/respond (workflows.approve, permission re-check, audited) + a new Approvals page (nav under Automation). 72 backend module tests incl. delay-resume, approve/reject routing, variables-across-pause; full green gate.
- Workflow Builder Phase 8 — Jobs Center integration. Each workflow execution is mirrored into the Unified Jobs Center as a workflow.execution parent job, and each long-running action node as a workflow.node child job linked by parentJobId (definitions registered with JobRegistry; source:'workflow' already first-class so executions appear in existing /api/jobs surfaces). The mirror is best-effort and non-authoritative — a WorkflowJobBridge wraps every Jobs-Center call so an invalid transition or registry gap can never break the executor (execution DB state is the source of truth). Job status tracks the execution via only valid job-SM transitions: running on start, pausing→paused while durably waiting (parked out of RUNNING states so boot-reconcile won't fail a waiting job), back to running on resume, terminal on finalize. Cancelling a workflow also requestCancels its job, and a parked (waiting) execution finalizes immediately on cancel. WorkflowExecution.jobId / WorkflowNodeExecution.jobId store the links. 74 backend module tests; full green gate.
- Workflow Builder Phase 9 — RBAC, notifications & search. Closes the security seam from Phase 6: the executor now performs a runtime least-privilege re-check — the execution identity's roles+permissions are snapshotted once per run (run-local; replicates the auth guard's SUPER_ADMIN short-circuit) and every action node is gated by its ACTION_PERMISSION before dispatch; a lacking permission fails the node (permission_denied, routed to a wired failure branch or fails the execution) with no side effect. Identity-less event/system runs rely on publish-time validation and fail closed if the identity can't be resolved. Notifications: three routable workflow.* domain events (execution failed/completed, approval requested) added to the shared NOTIFICATION_EVENTS catalog + Notification Center seed catalog, emitted by the executor as DomainEventEnvelopes on the shared bus (first-class routing keys, best-effort). Search: RBAC-gated command-palette quick actions (Open Workflows / Workflow Approvals). i18n: command.action.*, eventGroup.workflow. 15 execution-service tests (permission-denied, permission-allowed, failure-notification); full green gate.
- Workflow Builder Phase 10 — security, performance, docs & regression (feature complete). Retention: a @Interval sweep prunes terminal executions (finished after 7 days, failed kept 30 for diagnosis; node executions + approvals cascade). Performance rests on the Phase-2 composite indexes ([status,resumeAt]/[status,expiresAt]/[heartbeatAt,status] drive the resume tick; [workflowExecutionId,nodeId] drives the planner reload) plus the graph-size ceiling and validate-time DoS limits. Docs: WORKFLOW_BUILDER.md (flagship) + WORKFLOW_SECURITY.md (10-threat model); SECURITY.md + README docs table updated. Full regression: backend 1607 tests / 149 suites green, frontend 258 tests / 30 suites green, BE+FE tsc/build clean, Nest boot verified — Automation Engine, Jobs Center, and all prior subsystems unchanged. Closes the 10-phase Visual Workflow Builder.
- Workflow Builder Phase 2 — domain models, state machines & graph contract. Additive

### Fixed
- Trash & Recovery is now a live view of what can actually be restored, not a history log. A file removed with "Delete permanently (skip Trash)" no longer appears there at all, and a file whose retention window has passed leaves the list instead of lingering as an unrestorable tombstone. Fixes the underlying join too: the resolution journal stores an absolute path while TrashItem.originalPath is root-relative, so the two never matched and EVERY row rendered as "no longer in Trash", including files that were sitting in Trash and were perfectly restorable. Adds real Trash retention, which did not exist before despite the UI copy referring to a retention window: files.trashRetentionDays (default 30, 0 disables) drives an hourly sweep that permanently removes expired items and reclaims the disk a soft delete was still holding. Every Trash entry now carries an absolute expiresAt, and both the Files trash drawer and the Duplicate Center panel show a live "Nd hh:mm:ss" countdown that drops the row the moment it reaches zero; listings withhold already-expired items so a Restore button is never offered for something about to fail.

## [0.41.1] - 2026-07-22

### Fixed
- Fix duplicate cleanup failing with "Path is outside the allowed roots" whenever the file-manager Default Root Path is narrowed to a subtree that holds no media library.

## [0.41.0] - 2026-07-21

### Added
- Unified Jobs Center Phase 2 — the platform job engine (core). Adds the normalized
- Unified Jobs Center Phase 3 — reliability controls. Adds retry (exponential
- Unified Jobs Center Phase 4 — REST API + real-time channel. Adds fifteen jobs.*
- Unified Jobs Center Phase 5 — the Jobs Center UI. A new Jobs Center in the System
- Unified Jobs Center Phase 6 — schedules, workers & settings (honest, read-only).
- Unified Jobs Center Phase 7 — producer migration (adapters). MediaProcessingQueueService
- Unified Jobs Center Phase 8 — platform integration. The frontend consumes the
- Unified Jobs Center Phase 9 — retention, docs & hardening (feature complete).

## [0.40.0] - 2026-07-21

### Added
- Duplicate Center Phase 5 — the duplicate show-folder workflow becomes a plan the operator approves, and stops destroying subtitles.
- Duplicate Center Phase 6 — detection becomes a cancellable background job, and stops redoing work nothing has changed.
- Duplicate Center Phase 7 — events, automation, notifications, docs, and test coverage.
- Duplicate cleanup: remove only the media file, and add an optional permanent delete.
- Duplicate Center — per-file Keep and Delete buttons on each copy in a group.
- nav(Phase 6): module landing hubs. Each navigation domain gets an at-a-glance
- nav(Phase 7): contextual sub-nav + entity-aware breadcrumbs. A domain-aware
- nav(Phase 8): mobile redesign. A bottom domain switcher (`MobileDomainBar`,
- Navigation redesign — Phase 1: information-architecture re-group.
- Navigation redesign — Phase 3: sidebar features (collapse-all, badges, domain-switcher flyout).
- Navigation redesign — Phase 4: pinned, favorites and recent pages (per-user).
- Navigation redesign — Phase 5: command palette searches actions and live entities, not just pages.
- nav(Workspace Phase 2.1): re-slot the navigation registry into the approved 9
- nav(Workspace Phase 2.2): the workspace shell. A fixed global `WorkspaceRail`
- nav(Workspace Phase 3): workspace Overviews, Quick Actions, and a jobs aggregator.
- nav(Workspace Phase 4): command palette — fuzzy matching, scoped search, more
- nav(Workspace Phase 5): visual hierarchy, breadcrumbs, motion. The workspace

### Fixed
- Fix: three different movies sharing a contaminated external ID no longer group as duplicates.
- Fix: the movie matcher no longer confuses a film with its same-year sequel.
- Fix: the movie matcher no longer assigns one film's external IDs to a different film.
- nav(Phase 10): tests sweep. Adds IA-invariant tests over the real NAV_GROUPS
- Navigation redesign — Phase 2: registry-driven rail.
- nav(Workspace Phase 6): documentation & certification. New WORKSPACE_ARCHITECTURE.md

## [0.39.0] - 2026-07-20

### Added
- Duplicate Center Phase 4 — Quick Clean and bulk cleanup, with partial results reported as partial.

## [0.38.0] - 2026-07-20

### Added
- Duplicate Center Phase 3 (part 3) — the cleanup UI and Trash & Recovery, completing the Scan → Review → Keep Best → Preview → Clean Up → Verify loop.

## [0.37.1] - 2026-07-20

### Fixed
- Duplicate cleanup now handles sidecars instead of orphaning them — and never deletes a subtitle that exists nowhere else.

## [0.37.0] - 2026-07-20

### Added
- Duplicate Center Phase 3 (part 1) — a deterministic, explainable best-copy recommendation engine, wired into detection.
- Duplicate Center Phase 3 (part 2) — server-generated cleanup previews and trash-first execution.

### Fixed
- Fix the recommendation engine treating a filename claim as a measurement — it would have trashed larger, genuinely-measured files on the strength of a name.

## [0.36.1] - 2026-07-20

### Fixed
- Fix the Duplicate Center opening on an empty screen.

## [0.36.0] - 2026-07-20

### Added
- Duplicate Center Phase 2 (backend) — server-side search, filtering, sorting, an overview aggregate, group detail, and persistent ignore/reopen.
- Duplicate Center Phase 2 (UI) — the `/media/duplicates` page becomes a tabbed centre with server-side search and sorting, a side-by-side comparison, and persistent "not duplicates".

## [0.35.0] - 2026-07-20

### Added
- Duplicate Center Phase 1 — a durable domain model, and detection that no longer destroys human decisions.
- The manual "Scan" action now enriches, not just indexes and renames. Previously `POST /api/media/libraries/:id/scan` ran only the scanner (index files, record show folders, import on-disk sidecars) followed by the organiser (rename/move into `Show/Season NN`) — it never identified items, fetched provider metadata, or downloaded artwork. So a library whose `scanIntervalMinutes` was null (the default, "manual scans only") had **no** path to metadata/artwork at all: the file got renamed, but the episode stayed `unmatched` with no poster, because provider enrichment ran only from the post-download workflow or the periodic scheduler.

## [0.34.9] - 2026-07-20

### Fixed
- Phase 0 of the Duplicate Center work: fix the data-integrity bug that made duplicate detection unsafe, and close two security defects found in the same review.

## [0.34.8] - 2026-07-19

### Fixed
- Stop the renamer moving a show's `theme.mp3` into a season folder.

## [0.34.7] - 2026-07-19

### Fixed
- Fix every episode in a tinyMediaManager-tagged folder being skipped as "invalid naming template".

## [0.34.6] - 2026-07-19

### Fixed
- Three fixes found by previewing renames across the whole TV library.

## [0.34.5] - 2026-07-19

### Fixed
- Fix the per-episode title lookup handing one show another show's episode title. The map was keyed on `"{season}-{episode}"` alone, but a folder can hold more than one series — which is exactly how `FBI (2018)` accumulated FBI International files. `FBI International S02E13` was therefore named `Payback`, the title of `FBI S02E13`, and the batch `meta.seriesTitle` stamped the batch's series name onto it as well. A wrong name is worse than a missing one, because a rename writes it to disk.

## [0.34.4] - 2026-07-19

### Fixed
- Fix the per-episode title lookup skipping entire show folders. The lookup was gated on the batch `kind`, which is derived from parsing `sourceName` — and a show folder like `FBI (2018)` carries no `SxxEyy` but does carry a bare year, so it classifies as a *movie* and every episode inside was skipped. The gate is now per file (has a season and an episode), which is self-limiting: a genuine movie batch produces no keys and returns nothing, as before.

## [0.34.3] - 2026-07-19

### Fixed
- Fix the Renamer dropping the episode title from every name in a folder preview, and surface files sitting in the wrong show folder.

## [0.34.2] - 2026-07-19

### Fixed
- Fix the Renamer producing one destination for every file in a show folder, reported as a chain of duplicate-destination warnings.

## [0.34.1] - 2026-07-19

### Fixed
- Fix Missing Episodes counting on-disk episodes as missing when a show is only *partially* enriched.

## [0.34.0] - 2026-07-18

### Added
- Library scan now records a show folder that exists on disk but holds no media yet, so it can be monitored for acquisition before any episode is downloaded. Previously a MediaShow row was only created from folders containing video files, so a metadata-only setup — a tinyMediaManager/Kodi show folder with a `tvshow.nfo`, artwork and empty `Season NN` dirs (e.g. an `Ozark (2017)` folder awaiting its first grab) — never appeared in the add-from-library picker and could not be added to the Missing-Episode watchlist. The scan now also walks the library root's direct child folders and records any that (1) carry a `tvshow.nfo` and (2) resolve to an IMDb series id (from that nfo, else the local catalogue) as a MediaShow with `episodeCount: 0`. The IMDb-verification gate keeps junk directories out — an empty folder with no `tvshow.nfo` or no resolvable id is not recorded. Such a show surfaces in the picker as monitorable, and once added, the missing-episode sweep finds every episode missing and searches for it.
- Security hardening pass (remediating the internal security/vulnerability/code review). **Auth & secrets:** the boot-time weak-secret gate now also covers `JWT_REFRESH_SECRET` (previously a deploy could silently sign refresh tokens with the public default) and fails closed outside an explicit `NODE_ENV=development`; access tokens are now re-validated against the DB on each request (cached ~15s, fail-open on DB error) so a deleted/deactivated user or a revoked role/permission takes effect promptly instead of lasting the full token TTL; and accounts now lock for 15 minutes after 5 consecutive failed password/2FA attempts, closing the distributed-brute-force gap the per-IP throttle left open. **SSRF:** the automation `webhook` action and the artwork/newsletter-image fetches now route through a shared outbound-URL guard (blocks internal/metadata/private addresses unless allow-listed via `SSRF_ALLOW_HOSTS`, refuses redirects). **Dependencies:** `nodemailer` 6→9 (clears SMTP/CRLF-injection + TLS-bypass advisories) and `multer` 1.x→2.2 tree-wide via an override (clears the deprecated-line DoS advisories). **Transport & infra:** nginx now serves the SPA/docs with `X-Frame-Options`/`X-Content-Type-Options`/`Referrer-Policy`/CSP headers; the newsletter-preview iframe is sandboxed; CORS no longer has a credentialed-wildcard fallback; graceful shutdown drains connections on redeploy; the Prisma pool is explicit and tunable; deleting a media-server integration now cleans up its sessions/libraries/users/sync-runs atomically instead of orphaning them; and the RSS upgrade path records the new hold before removing the superseded torrent so a write failure can't trigger a re-grab loop. **CI:** `npm audit`/Trivy now block on critical, plus a CodeQL SAST workflow and Dependabot. No breaking API changes.

## [0.33.0] - 2026-07-17

### Added
- File Manager move/copy intelligence: a move/copy is now preflighted against the destination. When the same file is already there (matched by size + partial content hash) or the same TV episode exists as a different release, the operator gets a per-conflict decision — Replace, Keep both, Keep existing & delete source, or Skip — with the release quality of each side laid out and the smarter default pre-selected (identical → delete redundant source; better release → replace). Displaced files route through Trash by default, with a permanent-delete toggle. Episode identity and quality comparison reuse the RSS/acquisition engines (releaseIdentity, compareQuality) so 'same episode' means the same thing everywhere. New endpoints POST /files/move-conflicts (read-only analysis) and POST /files/resolve-conflicts (per-item execution, same result envelope as bulk).
- Settings hub: a directory of every settings area (linked + described, permission-filtered) plus a read-only Infrastructure section that surfaces the deployment environment variables — what each one is, its group, and whether it is set — via GET /settings/environment. Secret values (DB password, JWT/encryption keys, provider keys) are never returned, only set/not-set; non-secrets show their value. Read-only by design: these live in the deploy env, several apply only after a restart.
- Newsletter recipients can now be picked from the users synced off your media server, not just typed in. The "add recipients" box keeps free-text entry (type an email, Enter/comma/space to add; recipients show as removable chips) and gains a picker of synced users below it. A user the server gives an email for — Plex accounts, fetched from plex.tv — is one click to add. For servers whose accounts carry no email (Jellyfin/Emby have no email field at all), the user is still listed with an inline field so an admin can enter their address; it's saved back onto the user and reused next time, and never overwritten by a later sync. The user sweep now also pulls each connection's provider account list, so people who have never watched anything still appear. New `MediaServerUser.email` column, a `provider.getUsers` capability (Plex/Jellyfin/Emby; Kodi unsupported), and `GET/PATCH /media-server-analytics/newsletters/recipient-options` (gated on manage_newsletters).
- Library scan now resolves a show's series IMDb id at scan time instead of leaving it null until a later heal pass. For a show folder whose episodes were never identified, the scan takes the id from an explicit `tvshow.nfo` entry first (authoritative — a human/tool stated it, so it can't be fooled by two same-named series), then falls back to matching the folder title (+year) against the local IMDb catalogue. The resolved id is written to the MediaShow row and backfilled onto the folder's still-null episodes (guarded so a matched/user-corrected item is never clobbered), so the field the rest of the system keys off — missing-episode sweeps, subtitle fingerprinting — is present immediately. Best-effort: a missing sidecar, an unresolvable title, or a resolver failure leaves the id null and the show is simply retried on the next scan.

### Fixed
- Subtitle Intelligence: a global Settings page with real controls for the automation knobs (scan interval, auto-download, auto-sync) plus an in-product explainer of the whole config model; adds autoSync and defaultLanguages settings behind a typed SubtitleSettingsService.
- File Manager: a multi-select move/copy that failed reported success. /files/bulk returns 200 with per-item errors in the body, and callers treated any resolved promise as success — so moving files onto ones that already exist toasted "Moved 2 items" while nothing moved. Failures in the body are now surfaced at every bulk call site (move, copy, delete and Clean up selected): a partial run warns with a count and the distinct reasons, a total failure errors and holds its state — dialog open, selection intact — so it can be retried with overwrite. The read is centralised in a shared `bulk-result` module rather than re-derived per caller.

## [0.32.0] - 2026-07-15

### Added
- Add Subtitle Intelligence core module (phase 1): video fingerprinting with OpenSubtitles movie hash, progressively-relaxed multi-provider search, 0-100 candidate scoring, pure SRT/VTT/ASS validation, and media-server-correct sidecar installation that never overwrites originals. OpenSubtitles provider with encrypted credentials; per-library language policy; RBAC + audit.
- Subtitle Intelligence phase 2: automatic (FFsubsync) and manual-offset subtitle synchronization behind a provider abstraction (inert-safe without the binary; original always preserved), runtime cross-check validation, Synchronization + Validation UI, and an idempotent installer for the optional ffmpeg/ffsubsync/mediainfo binaries plus an opt-in Docker build arg.
- Subtitle Intelligence phase 3: SubDL and Local Repository providers (with a dependency-free ZIP extractor for SubDL and hard-root-confined filesystem access for Local), plus a per-library Language Policy UI (required/preferred/forced languages, HI, machine translation, preferred providers, minimum score, auto-replace).
- Subtitle Intelligence phase 4: automation triggers/actions, a decoupled missing-subtitle scan that keeps libraries healthy (Notification Center + optional auto-download), provider-health and missing-scan @Interval schedulers, a bulk scan endpoint, and a Downloads/History UI.
- Subtitle Intelligence: three more real providers — Podnapisi (unofficial JSON API), YIFY Subtitles and SubtitleCat (scraping-based, verified live end-to-end). All keyless, host-allow-listed, validated-before-write; parsers unit-tested against live-captured markup.

### Fixed
- Subtitle Intelligence phase 5 (hardening): add the security test proving provider credentials are encrypted at rest and redacted, and complete the documentation (API.md, SECURITY.md, README, Media Manager cross-link, and the Docusaurus module page in both locales).

## [0.31.0] - 2026-07-14

### Added
- feat(media): a scan honours exclusion markers, and an item can be locked against every automated path
- feat(media): metadata is resolved through a provider chain, and TheTVDB joins it
- feat(media): the Universal scraper composes an item from every provider, field by field
- feat(media): Trakt.tv — collection, watched state, ratings, watchlist and scrobbling

### Fixed
- fix(media): the renamer carries a file's .nfo and artwork sidecars instead of orphaning them
- fix(media): saving a provider key or Trakt credentials refreshes what it derives, without a page reload
- fix(media): Trakt and TVDB send a User-Agent — Cloudflare 403s requests without one
- fix(media): Trakt sync pulls every page — a large history was silently truncated to its first 1,000
- fix(media): the Trakt collection push batches instead of sending 29k items in one request
- fix(media): the Trakt backfill matches the real episode, and pushes episodes by show+season/number
- fix(media): scrobble/backfill match Plex's login and display names as the same user

## [0.30.4] - 2026-07-14

### Fixed
- fix(media): the probe stops condemning a file for being slow — a timeout is retried, not held against the file

## [0.30.3] - 2026-07-14

### Fixed
- fix(media): the library scan records a two-part episode's span, so it stops reading as a missing episode

## [0.30.2] - 2026-07-14

### Fixed
- fix(media): a wrong-show grab traced to three identity bugs — cross-series ownership, unrepresentable two-part episodes, and an inherited series id nobody checked

## [0.30.1] - 2026-07-14

### Fixed
- fix(torrents): torrent parking is no longer a one-way trip — the probe queue could starve, stranding every parked torrent as permanently paused
- fix(torrents): the Torrents table stops wrapping and its rows stop changing height

## [0.30.0] - 2026-07-14

### Added
- feat(analytics): every chart on the Analytics Dashboard drills into the plays behind it
- feat(media): the Media Manager now reads what a media file actually **is** (codec, resolution, real bitrate, HDR — measured from the container via mediainfo) instead of trusting what its filename calls it
- feat(media): a library scan now tells you when two folders hold the same show

### Fixed
- fix(media): the external-id collision guard now covers TVDB and TMDB, not just IMDb
- fix(media): NFO external ids are no longer read out of the cast list
- fix(media-server-analytics): watch history is imported per library, so the Libraries report stops attributing everything to Unknown
- fix(media-server-analytics): imported plays now carry their stream quality, so Quality Distribution stops reading 99% Unknown

## [0.29.1] - 2026-07-13

### Fixed
- fix(media-acquisition): the profile size field now shows the real size as you type

## [0.29.0] - 2026-07-13

### Added
- feat(media): find duplicate show folders and let the operator decide which is real
- File Manager: pick the Move/Copy destination by browsing, instead of typing a path
- feat(media): the library is the source of truth for where a TV show lives
- feat(media-acquisition): an auto-download profile can cap release size

### Fixed
- Missing-episode auto-acquisition now honours the filters it was configured with, and
- fix(indexers): an apostrophe in a show title no longer makes it un-grabbable
- Fix the dashboard's download/upload counters flickering to a dash, and the throughput
- Fix three defects in the bundled documentation:
- Replace the 126 placeholder slates in the documentation with real screenshots captured
- test: fix two suites that were asserting stale/environment-dependent behaviour
- fix(media): one post-download library workflow at a time, not one per torrent
- fix(torrents): dead magnets no longer starve the torrent-name repair
- fix(media): an IMDb episode id claimed by two shows is dropped from both
- Missing-episode search: episodes stranded by a restart are now released at boot. The sweep flips `searchStatus` to `searching` *before* calling the indexers, and nothing ever reset it — so a backend restart or redeploy in the middle of a sweep left those rows marked `searching` permanently. The sweep only ever selects `idle`, `no_results` and `failed`, so a stranded row was **never searched again** and its episode could never be acquired, silently and forever (found in production: 20 episodes on one host, 3 on the other, stranded by a day of deploys). Anything still `searching` at startup was interrupted by definition, so it is reset to `idle` and picked up by the next sweep. Wanted movies carry the same column and are reconciled too.
- A show-status lookup no longer invents an answer, and a legacy RSS rule's regex no longer
- fix(media-acquisition): stop the missing-episode sweep inventing duplicate show folders
- fix(media): a release subfolder is no longer mistaken for a show of its own
- Missing-episode acquisition no longer grabs the wrong show, and a dead media server no
- fix(media): a show's IMDb id must be a SERIES id, never an episode's
- fix(torrents): a completed torrent can no longer wedge the entire sync loop

## [0.28.0] - 2026-07-12

### Added
- Ship the documentation inside the frontend image. The full manual is now served at

### Fixed
- Fix the bundled Caddy reverse-proxy profile returning 502. `deploy/Caddyfile` proxied to
- **Bundled documentation: every section landing page was unreachable.** Docusaurus emits both a `develop.html` page and a `develop/` directory (holding that section's leaf pages), and nginx's `try_files $uri $uri/ $uri.html` matched the *directory* first — so `/docs/develop` 301'd to `/docs/develop/`, which has no `index.html`, and returned **403**. Only deep links like `/docs/help/faq` worked. Trying `$uri.html` first fixes it. Two related fixes in the same block: the 301 no longer leaks the container's internal `:8080` into an absolute redirect (which sent browsers to a port that isn't published), and a category folder with no landing page now serves the docs site's own 404 page instead of a bare 403.
- Fix torrents that display an infohash instead of their name. A magnet is named

## [0.27.3] - 2026-07-12

### Fixed
- Parking queue: also park torrents that have moved **nothing for hours with no seed connected**, even when their tracker claims seeders exist. Tracker seeder counts are frequently stale — on one host 66 of the 100 active download slots were held by torrents whose tracker advertised a seeder while they sat at zero bytes for 24 hours, which the seeder-count rule alone could never free. The stall rule judges only hard evidence (zero throughput, zero connected seeds, for `stalledAfterMinutes`, default 3h), so a merely-slow torrent is never touched. Revival is likewise now evidence-based — a seed actually connecting or bytes actually moving — because reviving on the tracker's claim would re-park the torrent on the very next tick, forever.

## [0.27.2] - 2026-07-11

### Fixed
- Audit log entries now name the show and episode they acted on. Previously the Target column showed only an opaque id (a uuid or torrent info-hash), so you couldn't tell what an entry was about without looking the id up. Each entry now also shows a readable name — for example "Silo (2023) — S01E03" — both in the collapsed row and beside the raw target in the details.
- **qBittorrent 5 support: pause, resume, start and stop now actually work.** qBittorrent 5.0 (WebAPI 2.11) renamed `pause`/`resume` to `stop`/`start` and *removed* the old endpoints, so against a 5.x server every one of those four calls hit a `404 Endpoint does not exist` — pausing or resuming a torrent from the UI, and automation rules that pause, all failed silently. The provider now reads the server's WebAPI version once and speaks whichever dialect it implements, keeping `pause`/`resume` for pre-5.0 servers.
- New **parking queue** for dead torrents. A torrent engine has a limited number of active-download slots (qBittorrent's `max_active_downloads`), and a magnet with no seeders can never even fetch its metadata — yet it occupies a slot the entire time it tries. Grab enough dead releases and every slot fills with torrents that will never finish, while every healthy torrent behind them waits in the queue forever. Seen in production: 100 slots held by dead magnets, 1,034 torrents queued behind them, zero bytes moving.
- The IMDb search indexes are now built in the background while the app runs, instead of during database migration. Building them on a fully imported catalogue takes minutes, and doing that inside a migration blocked startup — worse, if the build was interrupted the app would refuse to boot at all. They now build concurrently and idempotently after startup, with no downtime, and a build interrupted by a restart is detected and retried.

## [0.27.1] - 2026-07-11

### Fixed
- Automation: `torrent.completed` rules (e.g. "delete on complete") now fire for torrents that were already complete when first seen, that finished while the app wasn't polling, or that completed before the rule existed. Previously the trigger was a one-shot rising edge on the persisted progress snapshot (`<1 → ≥1`), so any torrent already past 100% at its first snapshot was permanently past the edge and its completion rules never ran — leaving completed torrents seeding forever. `AutomationEngine.reconcileCompleted` now re-evaluates already-complete torrents against every enabled `torrent.completed` rule each sync cycle, using `AutomationLog` as an idempotency ledger (shared with the edge path) so each rule runs at most once per torrent; a failed run isn't recorded as done, so a rule blocked by a transient error retries next cycle.
- rTorrent: the `delete` / `delete_with_data` actions now verify the torrent is actually gone and retry, instead of trusting `d.erase`'s return value. rtorrent (observed on 0.9.8) intermittently accepts `d.erase`, returns no error, yet leaves the download loaded and seeding — especially during bursts of erases (an automation "delete on complete" rule firing across many finished torrents at once). The old one-shot `removeTorrent` recorded a phantom `success`, so the torrent seeded forever and the automation ledger marked it done, never retrying. `removeTorrent`/`removeTorrentAndData` now erase, confirm removal via a cheap one-field `d.multicall2`, and retry a few times; if the torrent survives they throw, so the automation run logs a real `failure` and reconcile retries it on the next cycle. `removeTorrentAndData` only deletes the data once removal is confirmed (never while the torrent is still loaded). A transport error during the check is treated as "still loaded" so a transient blip can't be mistaken for a successful removal.
- Recent activity noise cleanup: (1) stop writing an audit entry every time the Prowlarr settings page is read — a polled GET was flooding the audit trail and activity feed; only changes are audited now. (2) The activity feed now also collapses repeated user-attributed events (e.g. a polled read, or several torrent adds) into a single "· actor — N events" line, while keeping renames and downloads individual so they still name their show/release, and grouping automation runs by rule so a busy rule reads "Automation: <rule> — N events" instead of many lines.
- Dashboard "Recent activity" now collapses bursts of identical background events into a single line. The metadata/artwork/IMDb enrichment sweeps write one audit entry per media item, which used to flood the feed and push out everything else; those recurring system events are now shown once with an "N events" count, while user actions and one-off events are unchanged. This keeps the feed representative — a few enrichment lines plus the automation runs, renames, and downloads you actually want to see.
- Audit trail: the expanded row details now show metadata in plain language instead of a raw JSON dump. Keys are turned into readable labels (e.g. "Library path", "IMDb ID") and values are formatted by type — byte sizes, counts, dates, Yes/No, and comma-joined lists. Genuinely nested values (objects or lists of objects) are still shown as formatted JSON, since there's no lossless flat form for them.
- Show identification now handles accented titles and shows with no year. A series like "90 Day Fiance" never matched IMDb's "90 Day Fiancé" — the accent was being stripped rather than folded to a plain "e" — and the matcher only ran for shows that had a year, which this one didn't. Both are fixed, so accented shows (90 Day Fiancé, Pokémon, …) and year-less entries now resolve to the correct series and start reporting their missing episodes.
- Fixes library scans that would freeze partway and never finish. Case-insensitive title lookups against the IMDb catalogue were scanning the entire 8.9-million-row table (measured at ~48 seconds per lookup), and because those lookups run per media item they saturated the database and stalled everything else. Adding trigram indexes brings the same lookup down to ~180ms. Separately, background jobs interrupted by a restart or deploy used to stay "running" forever; they are now marked as interrupted at startup instead of piling up.
- Library shows with no IMDb id now self-heal from the local IMDb catalogue. A show identified against TVDB (or never identified) had no tconst, which made it unmonitorable in the add-from-library picker and invisible to missing-episode scans. The picker now heals a bounded batch in the background on load, and `POST /media-acquisition/watchlist/library/resolve-imdb` runs the whole backlog in one pass; resolved ids are written onto the show's items, so the fix is permanent and also repairs owned-episode matching.
- Missing episodes: a monitored series whose IMDb id was accidentally an episode (or other non-series) id used to scan to a permanent zero — no episodes, nothing missing. The scanner now detects this (the id resolves to 0 catalogue episodes), re-identifies the show from its title against the local IMDb catalogue, and persists the correction, so it self-heals on the next scan instead of silently showing nothing.
- Missing episodes: the automatic show-identification now also matches titles that differ only by punctuation. Shows added from RSS rules often have punctuation stripped from their names (e.g. "FBI Most Wanted" vs "FBI: Most Wanted", "Chicago PD" vs "Chicago P.D."), which previously failed to resolve and left the show scanning to nothing. These now self-heal to the correct IMDb series on the next scan.
- Release-name parser: titles that legitimately contain dots are no longer mangled. Because scene releases use dots as word separators, every dot was being turned into a space, which broke names like "L.A.'s Finest" (became "L A 's Finest") and "Chicago P.D." (became "Chicago P D"). Acronyms are now preserved while ordinary scene separators still collapse as before, so shows display with their correct titles.
- Library scanner: newly scanned episodes now store the real series title with their season and episode number, instead of the raw filename with no episode info. Previously a show could fragment into one entry per episode, owned-episode detection failed to match, and the "add from library" picker offered individual episodes as shows. Existing unidentified episodes are also corrected automatically on the next library scan.
- Missing-episode auto-download sweep: a wanted episode that gets deleted mid-sweep (which happens when a library/watchlist scan runs at the same time) no longer aborts the entire sweep pass. Previously one vanished row threw a "record not found" error that stopped the whole batch, silently skipping the rest of that run's episodes; now it's skipped gracefully and the sweep continues.
- Watchlist / Missing Episodes: a downloaded episode can no longer be added or listed as its own TV show. Episode-formatted titles (e.g. "90 Day Fiance - S12E09") are now collapsed to the series name ("90 Day Fiance") when added to the watchlist and when grouped in the "add from library" picker, so the Missing Episodes list shows one entry per show instead of one per episode. Clean show names (including numeric ones like "9-1-1") are left untouched.
- Watchlist: editing an item and saving an IMDb id had no effect — the edit dialog sent it and the API accepted it, but the update never wrote `externalIds` to the database, so the id was silently dropped and the show stayed unmonitorable for missing-episode scans. The update now persists it, merging the submitted ids over the stored ones so an imdb-only edit can't wipe a `tvdb`/`tmdb` id the form never showed; clearing the field clears just that provider.

## [0.27.0] - 2026-07-10

### Added
- Library scan now organizes in-place files. For a library in `rename_in_place`/`rename_move` mode, a scan (and a new on-demand action) moves files loose in the show root into `Show/Season NN/` per the library template and applies junk cleanup (delete-globs, samples/extras, leftover .torrent, empty dirs — the existing cleanup rules), leaving link/copy/preview libraries untouched. New `POST /media/libraries/:id/organize` runs it standalone; `?dryRun=1` previews every move + delete without touching disk. Files already correctly placed are skipped, so a re-run is a near no-op.
- Media Manager: library scans are now asynchronous with live progress. The scan endpoint returns a job id immediately (fixing the 504 Gateway Time-out on large libraries where the synchronous request exceeded the gateway timeout), and the scanner streams a completion percentage plus a per-file action log (added/updated, prune, artwork/metadata import, final summary) over the `media_manager.job.progress` WS event. The Libraries page renders a progress bar + scrolling action log while a scan runs (hideable — the scan keeps running server-side), driven by the WS events; the dashboard "Scan all" fires background scans.
- Media libraries now scan and auto-populate on a schedule. A new periodic scanner runs each enabled library on its own `scanIntervalMinutes` cadence (never scanned, or `lastScanAt` older than the interval), so folders you add manually or drop in externally get identified and enriched without waiting for a download. For every item still missing identity, metadata, or a poster it fills the gap (identify → fetch metadata → fetch artwork), leaving already-enriched items alone so repeat scans do almost no work. Unlike the post-download workflow, the periodic scan never renames or moves your files — it enriches them in place. It's opt-in per library: a library with no scan interval (null/zero) is only ever scanned manually, so existing setups are untouched until you set an interval.
- Rename/move can now clean up junk before moving files. A new global **Cleanup rules** setting (Media → Settings) lets you delete unwanted files during a rename in place / move: filename **glob patterns** (e.g. `YTS*.txt`, `RARBG.txt`, `www.*`, `*.jpg`) and a **subtitle language keep-list** (e.g. keep only `en`, `es` — other-language subs are deleted, untagged subs are kept). It can also prune the source folder if it's left empty and remove a leftover `.torrent`. Cleanup is opt-in and deliberately safe: it only runs for the two relocating modes (never copy/hardlink/symlink, where the source is your seeding copy), never deletes a primary video file even if a pattern would match it, is constrained to the allowed storage roots, never removes a library or root folder, and shows every deletion in the rename preview without touching disk.
- Media library TV browsing is now a proper Show → Season → Episode hierarchy. The `/media/series` show list groups episodes by their show FOLDER (falling back to title only for files at a library root) instead of by `MediaItem.title`, so a folder of episode-titled files reads as one show rather than one "show" per episode — no more loose episodes at the top level. A new `GET /media/series/episodes?key=…` returns a show's episodes already grouped into ordered seasons (specials last) with per-season posters (`season_poster` artwork, falling back to the show poster). The browser's collapsible tree consumes these: click a show to expand its seasons, a season to expand its episodes, an episode to open its detail. Movies are unaffected (they stay a flat list).
- Add the qBittorrent engine provider (Web API v2) behind the existing engine abstraction — the sturdier alternative to rTorrent for large libraries. New cookie-auth HTTP client (`infrastructure/qbittorrent/qbittorrent-client.ts`) and `QbittorrentProvider` (`infrastructure/engine/qbittorrent/qbittorrent.provider.ts`) implementing the full `TorrentEngineProvider` contract over the v2 API, with native→normalized mappers (state, file priority, trackers, infinite-eta sentinel), the magnet-aware add-confirm behaviour, and SSRF-safe URL adds. `EngineConnectionConfig` gains `baseUrl`/`username`/`password` and `EngineProviderFactory` now instantiates it for kind `qbittorrent`. This is the provider core only — encrypted-credential storage, the add-engine UI form, and a bundled qBittorrent compose service are follow-ups, so it is not yet operator-configurable from the UI.
- Make the qBittorrent engine operator-configurable end to end. Encrypted credential storage (AES-256-GCM `password` in the engine config via the shared `__encrypted` convention, decrypted only when the provider connects; `list()` never returns it), the DTO gains `baseUrl`/`username`/`password` (with `mode` now optional), the Engines page offers a qBittorrent kind with a base URL / username / password form (blank password on edit keeps the stored one), and a profile-gated `qbittorrent` Docker Compose service (`lscr.io/linuxserver/qbittorrent`, reached at `http://qbittorrent:8080`) with `.env`/docs. Enable it with `docker compose --profile qbittorrent up -d`, then add the engine under Infrastructure → Engines.
- Torrent fetching: add an `SSRF_ALLOW_HOSTS` allowlist (comma-separated hostnames, IPs, or IPv4 CIDRs) so a self-hosted indexer on the LAN or Docker network — e.g. a Prowlarr that hands back `.torrent` proxy links on a private IP — can be fetched, while arbitrary internal URLs stay blocked. Empty by default (full SSRF protection unchanged); scheme allow-list, redirect refusal, and size caps still apply to allowlisted hosts. Fixes auto-downloads silently failing with "Torrent URL resolves to a blocked internal address" when the indexer's results carry no magnet.

### Fixed
- Media Acquisition → Settings now has an "Auto-download missing episodes" toggle, plus "Search interval (minutes)" and "Max searches per sweep" fields (shown when enabled). Previously `autoSearchMissing` was only settable via the API; it's now controllable in the UI. Backed by the existing `AcquisitionSettings` + `PATCH /media-acquisition/settings`. en-US + es-PR i18n.
- Version badge: always surface the git commit, even for a plain `docker compose build`. The commit previously reached the image only via the `GIT_SHA`/`GIT_TAG`/`BUILD_TIME` Docker build args, so an image built without them (a bare `docker compose build`) reported `gitSha: null` and the UI showed the version with no commit. Now the build stamps a baked-in `build-info.json` (`ops/scripts/stamp-build-info.js`) that the backend reads at runtime — `resolveBuildInfo()` resolves each field env (build args) → baked file → null — so `GET /api/system/version` and the version badge can always render `v<version> - (<short-sha>)`. Stamping is automatic via `ops/scripts/docker-build.sh` and the `.githooks` (installed with `ops/scripts/install-git-hooks.sh`) that refresh the stamp on `git pull`/checkout/commit.
- Automation rule executions are now recorded in the audit trail and the dashboard's Recent activity, not just the rule's own run history. Each run (success or failure) is mirrored as an `automation.rule.executed` audit entry carrying the rule name, the actions it ran, and the torrent it acted on (or the failure reason). Both screens humanize it — e.g. "Automation: Remove torrent after download" with the torrent as a detail line, and a red "failed" state with the error when a run errors.
- Dashboard "Recent activity" now spells out what media is being handled and what was attempted, instead of a bare "Media rename". Media rename/organize events read "Renamed media for 9-1-1 (2018)" with a `from → to` detail line (or applied/skipped/failed counts when there's no single move); Smart Download events read "Downloaded/Upgraded {release}" and "Download failed for {release}" with the error as detail. Backed by enriched audit metadata — `MediaService.apply` records the media name (title + year) and a representative from/to, and the download executor records the release name — plus a new optional `detail` line rendered under each activity row.
- Missing-episode auto-download: resolve the save path with a layered fallback so grabs land in the show's folder even when the watchlist item isn't linked to an RSS rule (the common case). Falls back from the linked rule → an RSS rule matched by show title → the show's existing library folder → `<TV library>/<Title> (Year)`, only using the engine default `/downloads` when none resolve.
- Missing episodes: show a TV airing-status badge (Returning / Ended / Cancelled / Continuing / …) beside each series in the Smart Download "Missing episodes" overview. The status is read from the shared show-status cache (no provider calls on load) and warmed in the background for shows not yet resolved, so a later refresh fills in the badge. Reuses the existing RSS show-status badge and labels.
- Fix TV episode releases whose name embeds a bare year (e.g. `Hijack.2023.S02E03`). The name parser now treats a bare four-digit year sitting immediately before the season/episode marker as the series year rather than part of the title, so it resolves to `Hijack` + year `2023` instead of `Hijack 2023`. This stops the show folder/title from forking into `Hijack 2023`, lets the provider lookup find the episode titles, and yields clean `Show - SxxEyy - Title` filenames. A leading year (`2020.S01E01`) and a year away from the marker (`Class of 2023 …`) are left intact. Also fixes library **organize** (and organize-on-scan) silently holding every such show as `needsReview`: it now previews each move under the library's real mode (in-place destinations reuse the file's existing show folder) instead of mode `preview`, which mis-rooted the destination under the library and tripped the same-show-folder guard. A new `dryRun` flag on the rename request builds the faithful plan without touching disk.
- qBittorrent client: accept the modern login contract. qBittorrent 5.x answers a successful `POST /api/v2/auth/login` with `204 No Content` (not `200 "Ok."`) and sets a `QBT_SID_<port>` session cookie (not `SID`). The client now treats `204` or `200 "Ok."` as success, extracts the cookie by name (`QBT_SID`/`QBT_SID_<port>`/`SID`), and echoes the full `name=value` back on every request — previously it hard-coded `SID=` and auth failed. Found via a live smoke test against `lscr.io/linuxserver/qbittorrent`.
- Renamer: never move a primary video onto a corrupt-template path. A library naming template corrupted to a bare `{` (an unclosed token, which also isn't an illegal filename char) rendered every episode's destination to the literal `{`, so renames clobbered each file to `<show>/{` and episodes overwrote one another. `buildRenamePlan` now validates the rendered path with a new `isRenderedPathSafe()` helper (non-empty, no unresolved `{`/`}`, basename ends in the file's extension) and skips the file with an "invalid naming template" warning instead of destroying its name.
- RSS feed history: downloading an item now prompts for the save location. The "Download" action on a history row opened the grab straight into the engine's default directory with no way to choose where it lands. It now opens a dialog with a directory `PathPicker` (remembered across grabs in the session); the chosen path is passed through `POST /rss/history/:id/download` → `downloadHistoryItem(savePath)` → `addToEngine(link, savePath)`. Leaving it blank keeps the previous behaviour (engine default). en-US + es-PR i18n.
- rtorrent: don't record a magnet add as failed just because it isn't registered within the ~6s confirm window. A magnet carries only the info-hash; rtorrent doesn't list it until it fetches metadata from DHT/peers, routinely far longer than 6s. `confirmTorrentLoaded` now treats a confirm-timeout for a **magnet** as accepted/pending (logs and returns; the 2s torrent-sync reconciles when it registers) while **.torrent file** adds still throw on timeout (metadata is present, so a real failure is meaningful). This eliminates a flood of false `media_acquisition.download.failed` records for magnets that download fine (observed: 256/257 "failures" actually loaded, median ~53s later) and the associated duplicate-add risk.
- Bundled rTorrent stability mitigations. The engine is jesec `v0.9.8-r16` (the newest rtorrent build), whose `internal_error: priority_queue_insert(...) called on an invalid item` is an unfixed upstream 0.9.8 bug fired on tracker-announce scheduling that grows more frequent with the active-torrent count. Disable UDP tracker announces in `deploy/rtorrent/rtorrent.rc` (`trackers.use_udp.set = no`) to remove the secondary `TrackerList::receive_failed` crash variant (HTTP/HTTPS trackers + PEX still find peers), add a Compose healthcheck on the rtorrent service (SCGI port-listen) to surface a wedged-but-running engine, and document the limitation and its mitigations (keep the active-torrent count modest, or use a sturdier engine for large libraries) in `docs/DOCKER.md` and `docs/INSTALL.md` — also correcting stale DOCKER.md references (the rtorrent image is built locally from `deploy/rtorrent/`, not `crazymax/rtorrent-rutorrent`, and session state lives in the shared `downloads` volume at `/downloads/.session`, not a separate `rtorrent_data` volume). No fix for the dominant `priority_queue_insert` crash exists in the 0.9.8 lineage.
- Fix `smart_episode_match`/`smart_movie_match` over-matching. The title check used set-membership (every pattern token appears *somewhere* in the release's show-title region), so a rule for **"Rise"** grabbed `The.Pendragon.Cycle.Rise.of.the.Merlin.S01E04…`, and **"9-1-1"** grabbed the **9-1-1 Lone Star** spinoff. The pattern must now **equal the release's pure title** — the show-region tokens up to the first release year or quality/format token. This rejects both mid-title bleed ("Rise") and prefix-spinoff bleed ("9-1-1 Lone Star" ≠ "9-1-1"), while still matching `9-1-1`, `9-1-1 2018`, `The.Equalizer.2021.S05E05` (leading article ignored, trailing year/quality stripped), and letting a "9-1-1 Lone Star" rule match Lone Star. A leading year is kept as a title (`2020`). `contains_text` (deliberately loose subset matching) is unchanged.
- Default the torrent-fetch SSRF allow-list to the bundled Prowlarr so auto-downloads work out of the box. `docker-compose.yml` now sets `SSRF_ALLOW_HOSTS: ${SSRF_ALLOW_HOSTS:-prowlarr}`. Previously the default was empty, so any grab from the bundled Prowlarr (which returns `.torrent` proxy links on a private Docker IP) failed with *"Torrent URL resolves to a blocked internal address"* and auto-downloads silently did nothing — even though the Prowlarr connection test passed (the health check trusts private hosts; the torrent fetch is a separate, stricter guard). Documented the requirement and this "passing test / failing downloads" trap in `.env.example`, `docs/DOCKER.md`, `docs/INSTALL.md`, `docs/PROWLARR.md`, and `docs/SECURITY.md`. Override the variable to trust additional self-hosted indexers (keep `prowlarr` in the list when using the bundled one, e.g. `SSRF_ALLOW_HOSTS=prowlarr,indexer.lan`).
- The sidebar version badge now always shows the abbreviated commit hash (short git SHA) in white next to the version, including on exact releases. Previously it showed the `git describe` tag and hid the suffix entirely when the build sat on an exact release tag, so a released build displayed no commit at all.
- Sidebar version badge now shows the full `git describe` release tag (e.g. `v0.26.0-3-ge877a84`) next to the version instead of only the short commit, and colorizes the two: the version in light green and the release tag in white. Falls back to the short commit when the tag just repeats the version, and shows the version alone on a build with no git stamp.
- Media Acquisition: the watchlist now lists items alphabetically by title (case-insensitive, via `normalizedTitle`) instead of by priority + newest-first, which read as an arbitrary order.

## [0.26.0] - 2026-07-08

### Added
- Approval Queue shows the release file size (persist sizeBytes on evaluations + surface it in the queue and evaluation detail)
- Missing Episodes page: remove a show from the watchlist inline (trash button, manage_watchlist-gated)

### Fixed
- RSS matching: `contains_text` and the smart match types now match title words as whole tokens against the release's show-title region (before the SxxEyy), not as substrings of the whole name. Fixes two false-match classes the single-char fix missed: multi-char substring bleed (a "The Boys" rule grabbing "…Cowboys…") and episode-title collisions (a "Severance" rule grabbing a Law & Order episode titled "Severance"). Quality/format words are still matched anywhere in the release.
- Missing-episode scan now self-heals a monitored TV series that has no IMDb id: on each scan it resolves the series' tconst from the local IMDb catalogue by exact title (+year when known), preferring the candidate with the most catalogued episodes (so the real long-running series wins over a same-named stub), then persists it onto the watchlist item — so the scheduled scan auto-enables monitoring instead of skipping the show forever. No confident match (no title match, or no candidate has any episodes) leaves the item unscannable as before.

## [0.25.2] - 2026-07-08

### Fixed
- RSS match engine: extend `contains_text` whole-token matching to single-character words (previously only numeric). A separator-heavy short title like "M.I.A" normalizes to "m","i","a", which as substrings appear in almost every release ("megusta" alone supplies "m" and "a") — the same over-match class as "9-1-1". Single-letter pattern words now require a standalone title token; also does the right thing for acronym titles (S.W.A.T, M.A.S.H).
- Build tooling: git commit/tag/build-time stamping is now folded into a canonical `ops/scripts/docker-build.sh` wrapper used by every build path (new `npm run build:docker`, the `package` script, and the deploy scripts), so images self-stamp their commit without remembering to pass build args. A bare `docker compose build` still works and falls back to the plain version (correct for throwaway dev builds).
- Show the short git commit next to the version in the sidebar version badge and the About menu entry (e.g. `v0.25.1 · 4045eef`), so two deploys reporting the same version number but running different commits are distinguishable at a glance. The commit/tag/build-time are stamped into the backend image at build via the `GIT_SHA`/`GIT_TAG`/`BUILD_TIME` build args (new `BUILD_TIME` arg added); when unstamped, only the version shows (unchanged behavior).

## [0.25.1] - 2026-07-08

### Fixed
- RSS match engine: `contains_text` now matches numeric pattern words against whole title tokens instead of loose substrings. A hyphenated numeric show title like "9-1-1" normalizes to the words "9","1","1", which as substrings appear inside almost every release ("S09E07", "1080p", …) — dissolving the title constraint and causing the rule to grab unrelated shows. Numeric words now require a standalone token match; alphabetic words keep substring matching.
- Media identification: for episodic files in a `Show/Season NN/episode` layout, take the series title from the show folder instead of the filename (which often carries only the episode title). Fixes shows like "9-1-1 (2018)" fragmenting into one series per episode. A loose scene release not inside a season container keeps its filename title.

## [0.25.0] - 2026-07-08

### Added
- Add-from-library picker shows each show's TV airing-status badge (cached tv_show_status + bounded background warm)

### Fixed
- Media identification: make the library's declared kind authoritative for movie-vs-TV classification, and strip a parenthesized `(Year)` from episode titles. Fixes shows like "9-1-1 (2018)" scanning as a movie (and titled "9-1-1 2018") while their episodes still grouped into seasons.
- Missing-episode auto-downloader now saves grabbed episodes into the parent Show Rule's download directory (RssRule.savePath) instead of the torrent engine's default /downloads. Falls back to the engine default when the show isn't linked to an RSS rule or the rule has no save path.

## [0.24.0] - 2026-07-08

### Added
- Per-show RSS-rule picker: flat GET /api/rss/rules endpoint + 'Auto-download from RSS rule' dropdown in the watchlist dialog, wiring rssRuleId end-to-end (Phase 2 follow-up)

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
