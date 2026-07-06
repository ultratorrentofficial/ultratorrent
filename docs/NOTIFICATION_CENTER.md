# Notification Center

A **core** UltraTorrent module (id `notification_center`, frontend route
`/notifications`, REST `/api/notifications`, RBAC `notifications.*`) — the
**centralized, provider-driven messaging platform** for the entire application.
Every module publishes events; configurable **rules** decide **if**, **when**,
**how**, and **to whom** a notification is delivered. **Nothing is hardcoded** —
every notification is an editable rule.

> Supersedes the legacy `notifications` module: the Notification Center now owns
> `/api/notifications` and the delivery engine. The old `NotificationsService`
> stays as the in-app (toast) primitive and now also **publishes onto the event
> bus** (`legacy.notification`) so the Center can route it.

## Architecture

```
Module → eventBus.emit(NOTIFICATION_BUS_CHANNEL, { event, payload })
      → NotificationCenterService  @OnEvent(NOTIFICATION_BUS_CHANNEL)   (sole subscriber)
      → RuleEngine.match(event, payload)         (enabled rules + conditions)
      → RecipientService.resolve()               (recipients + groups + event-user)
      → channelsFor()                            (rule channels / preferred / defaults)
      → preferences opt-out check
      → TemplateEngine.buildMessage(kind)        (per-channel body + rich card)
      → DeliveryService.enqueue()                (dedup + NotificationDelivery + NotificationQueue)
      → @Interval delivery worker                (quiet-hours, rate-limit, retries, escalation)
      → NotificationProvider.send()              (Email / SMS / Telegram / WhatsApp / …)
      → status transitions + history + WS (notification.*) + audit
```

There is a real **in-process event bus** (`@nestjs/event-emitter`,
`EventEmitterModule.forRoot({ wildcard: true })`). Modules stay fully decoupled —
they only `emit()` an envelope on `NOTIFICATION_BUS_CHANNEL` (`'notification.event'`)
and never reference the Center.

## Providers

`NotificationProvider` (`notification-provider.ts`) is the abstraction; business
logic never touches a provider API. Every provider implements `connect`,
`disconnect`, `testConnection`, `healthCheck`, `validateConfiguration`,
`validateRecipient`, `normalizeRecipient`, `send`, `sendTemplate`, `sendBulk`,
`cancel`, `getStatus`, and the full `supports*()` capability set (rich cards,
images, buttons, markdown, attachments, scheduling, priority, read receipts,
templates, media, typing, threads, reactions). `BaseNotificationProvider` supplies
defaults so a concrete provider implements only what's distinct.

| Provider | Kind | Backend | Rich rendering |
|---|---|---|---|
| Email | `email` | SMTP (nodemailer) | Responsive HTML card (poster, badges, buttons) + plain-text |
| SMS | `sms` | Twilio Messaging API | Concise plain text (`cardToSms`) |
| Telegram | `telegram` | Bot API | Photo + Markdown caption + inline-keyboard buttons |
| WhatsApp | `whatsapp` | Twilio WhatsApp | Rich text + poster media |

**Adding a provider** (Discord, Slack, Teams, Signal, Matrix, ntfy, Gotify,
Pushover, FCM/APNs, generic webhooks, …) is a new class + one `DESCRIPTORS`
entry in `provider-registry.ts` — no business-logic change. The registry drives
the `GET /providers` catalog (capabilities + config schema) and which config
fields are encrypted (`secretFieldsFor`).

### Provider Development Guide
1. Extend `BaseNotificationProvider`; set `kind` + `capabilities()`.
2. Implement `validateRecipient` / `normalizeRecipient` (the address field you use),
   `testConnection`, and `send` (render the `NotificationCard` to your channel's level).
3. Add a `DESCRIPTORS[kind]` entry: `factory`, `name`, `recipientField`, `configFields`
   (mark secrets `secret: true` → auto-encrypted).
4. Done — channels, rules, templates, queue, health and the UI pick it up.

## Rich notifications

A provider-agnostic `NotificationCard` (poster, backdrop, title, subtitle,
overview, metadata badges, rating, genres, runtime, action buttons, footer,
timestamp) is built from the event payload (and any template overrides). Each
provider renders it to its capability level; **SMS collapses to concise text**
(`cardToText` / `cardToSms` / `cardToMarkdown`, all pure + unit-tested). The
flagship **"User Started Watching"** card carries full movie/episode info
(title, episode, quality, user, device, playback method, codecs, bitrate) and
**View / Open buttons** where supported — seeded **disabled by default**.

## Rule engine

`NotificationRule` fields: `enabled, name, description, priority, severity, event,
conditions[], recipients{}, channelIds[], templateId, variables, quietHoursOverride,
dedupeWindowSec, retryPolicy, escalationPolicy, rateLimitPerHour, schedule, tags`.
Conditions (`evaluateConditions`, pure) support `eq/neq/gt/gte/lt/lte/contains/in/
exists/regex` (AND). Admins create unlimited rules; the **default catalog** (47
rules across Media Server / Downloads / RSS / Media Manager / System) is **seeded
once** (idempotent, when no system rules exist) and fully editable — never
clobbered.

## Template engine

`template-render.ts` (pure): `{{var}}` interpolation + `{{#if}}` / `{{#unless}}`
blocks, per-channel bodies (subject/title/subtitle/html/text/markdown/sms/whatsapp/
telegram), a rich-card builder, localization, and a preview endpoint. Variables
include `{{userDisplayName}} {{mediaTitle}} {{episodeTitle}} {{overview}}
{{posterUrl}} {{rating}} {{serverName}} {{device}} {{playbackMethod}} {{bitrate}}
{{watchUrl}} {{torrentName}} {{rssRule}} {{errorMessage}} {{eventTime}}` …

## Recipients & groups

Recipients hold display name, email, phone, Telegram chat id, WhatsApp number,
language, timezone, preferred channel, quiet hours, per-event preferences, and an
optional mapped UltraTorrent user. Rules address recipients directly, by **group**
(seeded: Administrators, Operators, Media Users, Developers, Support, Executives),
or by **the event's user** (`mapEventUser`).

## Delivery queue

`NotificationDelivery` carries the full lifecycle; the `@Interval` worker
(`notification_delivery_worker`, gated on the module being enabled) processes due
deliveries with **priorities, retries + exponential backoff, per-channel rate
limiting, quiet hours (with rule override), a dedup window, and provider health**.
Statuses: `queued · sending · sent · delivered · failed · cancelled · skipped ·
retrying · throttled`. A separate `notification_provider_health` worker health-checks
channels and emits `notification.provider.online/offline`.

## REST API (`/api/notifications`)

`GET dashboard` · `GET providers` · `GET/POST/PATCH/DELETE channels` +
`POST channels/:id/test` · `GET/POST/PATCH/DELETE recipients` ·
`GET/POST/DELETE groups` + `PUT groups/:id/members` ·
`GET/POST/PATCH/DELETE templates` + `POST templates/preview` ·
`GET/POST/PATCH/DELETE rules` · `GET history` · `GET queue` ·
`POST history/:id/retry` · `GET preferences/:recipientId` + `PUT preferences` ·
`GET/PATCH settings` · `POST test`. Every route is RBAC-gated; **secrets are
encrypted at rest and redacted from every response**; destinations are masked in
list views.

## RBAC

`notifications.` + `view, manage_channels, manage_templates, manage_rules,
manage_recipients, manage_groups, view_history, retry, send_test,
manage_preferences, manage_settings, admin`. Enforced server-side
(`@RequirePermissions` + `PermissionsGuard`, super-admin bypass) and frontend-side
(nav + route gating). Auto-synced to the `Permission` table at boot.

## Realtime

`notification.sent · failed · retry · queue.updated · provider.online ·
provider.offline · rule.triggered`, scoped to the `notifications.view` room
(`RealtimeGateway.roomForEvent`).

## Media Server Analytics integration

MSA publishes `media_server.user_started_watching`, `user_finished_watching`,
`transcode_detected`, `newsletter_sent`, `newsletter_failed` onto the bus (session
poller + newsletter dispatcher). Remaining catalog events (`media_added`,
`server_online/offline`, `high_bandwidth`) and the Downloads / RSS / Media Manager
/ System publishers are the next integration wave — the rules are already seeded
and become live the moment those modules emit.

## Security

Credentials AES-256-GCM encrypted (`SecretCipher`), redacted from responses;
HTML escaped; recipients validated/normalized per provider; per-channel rate
limiting + quiet hours + a dedup window prevent notification storms/loops; full
bodies are **not** logged by default; RBAC-gated throughout; every channel/rule/
template/recipient/preference change + manual send + retry is audited
(`notification.*` actions).

## Examples

- **Notify admins when a media server goes offline** → the seeded *Media Server
  Offline* rule (critical) targets the Administrators group; configure an Email
  channel and it delivers.
- **Telegram now-playing cards** → add a Telegram channel (bot token), a recipient
  with a chat id, then enable *User Started Watching* and point its rule at the
  Telegram channel.
