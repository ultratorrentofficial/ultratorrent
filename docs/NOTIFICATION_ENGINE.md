# Notifications

A personal notification system. It answers exactly two questions for each user:

> **Which events do I want?**
> **Where should I receive them?**

Everything else is decided by UltraTorrent.

- [The product decision](#the-product-decision)
- [What a user sees](#what-a-user-sees)
- [Ownership and eligibility](#ownership-and-eligibility)
- [Recipients are code](#recipients-are-code)
- [Preferences](#preferences)
- [Channels](#channels)
- [Presentation](#presentation)
- [Delivery](#delivery)
- [API](#api)
- [Adding an event](#adding-an-event)
- [Troubleshooting](#troubleshooting)

---

## The product decision

The system this replaces mixed global rules, shared recipients, shared
credentials, automation actions, templates, delivery history, per-user
preferences and the platform's event bus. On a live install it had **1,729 in-app
notifications with a null owner** — every one a broadcast to whoever happened to
be connected.

The rebuild removes the questions that made that possible. There is deliberately
**no** rule builder, audience designer, template editor, routing precedence,
wildcard matching, multi-destination routing, quiet-hours scheduling or digest
engine. Those are not "not yet"; they are the complexity being refused.

---

## What a user sees

```
Account → Notifications
    ├── Inbox      what arrived
    ├── Events     which events, and where       ← the whole configuration
    └── Channels   email · Telegram · Discord
```

Reached from **Dashboard → Notifications** in the nav rail, and from the user menu.
It sits inside Dashboard rather than as its own workspace because the rail is
capped at nine domains by design; a personal inbox is part of "your stuff at a
glance", not a tenth top-level concern. There is **no global settings page**,
because there is no global notification state to configure — and no way for an
administrator to edit another person's preferences.

The **Events** table is one row per event and four switches:

| Event | In-App | Email | Telegram | Discord |
|---|---|---|---|---|
| User Started Watching | On | Off | On | Off |
| Torrent Completed | On | On | Off | Off |
| Storage Critical | On | On | On | On |

A channel column is only usable once that channel can actually deliver. A switch
the platform cannot honour would promise delivery that never arrives.

---

## Ownership and eligibility

**Only a locally authenticated UltraTorrent user may own a notification,
preference, channel connection or delivery.**

`NotificationRecipientEligibilityService` is the single authority, and it looks up
**by primary key only** — never by email or username. A Plex or Jellyfin account
legitimately shares an operator's email address, and the old engine read a
media-server user id from the same payload field as a local user id. Matching on
anything but the primary key reintroduces exactly that confusion.

It fails closed: an id that does not resolve to an *active* local user is not
eligible, with no fallback.

`User.isSystem` is **not** a filter. It means "seeded and undeletable", not
"service identity" — the bootstrap admin is `isSystem`, and excluding it would
silence the one account guaranteed to exist.

Ownership is enforced by the schema: `UserNotification` and
`UserNotificationPreference` carry a NOT NULL `userId` with a cascading FK.

---

## Recipients are code

Each event declares **one fixed strategy**, in code:

| Strategy | Audience | Example |
|---|---|---|
| `affected_user` | The person it happened to | Password changed |
| `resource_owner` | The owner, else permission holders | Torrent completed |
| `permission_holders` | Everyone holding the event's permission | Workflow approval |
| `administrators` | Admin roles | Platform-wide events |

Users decide whether **they** receive an event and where it goes. They never
configure who *else* gets it — that is the audience designer, and it is how a
notification ended up broadcast to everyone.

Two consequences worth stating:

- **Personal security events go to the owner, not administrators.** Password
  changed, 2FA disabled, API key created and failed sign-in are your business.
- **`permission_holders` derives its audience from the permission the event
  itself declares**, so a new role granting it is included with no code change.
  SUPER_ADMIN is matched by *role*, which a permission-row query would miss.

---

## Preferences

Lazy overrides. A user with no rows gets catalogue defaults, so adding an event is
not a data migration across every account, and "reset" is a delete.

**No external channel is ever on by default.** A channel the user has not
connected cannot deliver, so defaulting one on would promise delivery that
silently never happens.

A new override row is seeded from catalogue defaults rather than all-true —
otherwise enabling email on an off-by-default event would quietly switch in-app on
too.

---

## Channels

| Channel | Credential | Verification |
|---|---|---|
| **In-app** | none | always available |
| **Email** | shared SMTP relay, configured once by an operator | test send |
| **Telegram** | the user's own bot, from @BotFather | linking code |
| **Discord** | the user's own webhook | test send |

One active connection per user per channel. The schema stays extensible —
dropping a unique constraint is all multi-destination needs — but exposing it now
would reintroduce the routing questions the rebuild exists to remove.

**Destinations are AES-256-GCM encrypted and never returned.** Endpoints show a
mask (`de••••@example.com`, `#alerts (…5678)`, `@handle`); no read method returns
a real destination.

### Email

One shared relay as infrastructure, one personal address per user. Nobody supplies
SMTP credentials, so there is no per-user secret to leak. Connect and verify are
**one call**: an address stored but never tested is the failure mode where a user
believes they are covered and is not. Re-pointing an address resets verification,
so a typo cannot inherit a working address's trust.

### Telegram

**Each user brings their own bot**, exactly as each brings their own Discord
webhook. This was originally one shared bot an operator configured — the theory
being that a bot token is infrastructure like the SMTP relay. It is not. An SMTP
relay is a server the platform owns; a bot is a Telegram identity the *person*
owns, and making it an operator setting put a personal channel behind an
administrator. The relay stays global for exactly the inverse reason.

Connecting is two steps, because Telegram needs two facts: the token (verified
against `getMe` before storage, so a typo is refused immediately) and a chat.
Storing the token creates the connection but leaves it **unverified** — a working
token proves a bot exists, not that there is anywhere to deliver.

Replacing the token clears any linked chat and resets that user's update
watermark: a chat id belongs to one bot, and a watermark carried across would skip
the very message carrying the next code.

**A user never types a chat id.** A chat id is guessable and unauthenticated, so
accepting one from a form would let anyone route another person's notifications to
their own chat. Instead: a six-digit code, hashed and held in memory, single use,
expiring in ten minutes, rate-limited, with one live code per user and an
advancing `getUpdates` offset so a consumed message cannot be replayed. A chat
already linked to another account is refused.

Linking verifies immediately — redeeming the code *is* proof of chat control.

### Discord

One personal webhook. The SSRF allow-list is applied to the **host as supplied**,
never a resolved address: a resolve-then-fetch check is defeated by DNS rebinding.
Also refused — plaintext, embedded credentials, non-standard ports, non-webhook
paths, and lookalikes like `discord.com.evil.example`. The URL is re-validated at
send time and redirects are refused.

Every payload carries `allowed_mentions: { parse: [] }`, so Discord resolves
nothing — a media title containing `@everyone` cannot page a server.

---

## Presentation

One canonical model backs the in-app card, the Live Activity dashboard, email,
Telegram and Discord. A live session card and a playback notification cannot
describe the same session differently, because they are the same data.

Three rules:

1. **Data, not markup.** `accent: 'stopped'` is a meaning; the colour is the
   renderer's business. `stopped` is distinct from `error` — playback ending is
   red in the design but is not a failure.
2. **Already redacted.** The server decides per recipient what a presentation
   contains, so a renderer cannot leak by rendering too much. Artwork and
   device/quality detail require `media_server_analytics.view_live_activity`.
   `ipAddress` is never read at any permission level.
3. **Artwork is a reference, never a URL.** A link that resolved without a token
   would be permanent unauthenticated access to library artwork.

Presentations are built **once per recipient and stored**. Rebuilding at read time
would let a catalogue change silently rewrite what a historical notification said,
and it freezes the permission decision at the moment it was true.

External channels **omit artwork**. Discord renders images only from
anonymously-fetchable URLs; the same reasoning applies to email and Telegram
rather than reaching into the media integration to attach bytes. A real
limitation, stated rather than hidden.

---

## Delivery

```
domain event → catalogue → fixed recipient strategy → eligible local users
             → personal preference → in-app row (with stored presentation)
             → queued external deliveries → async worker
```

External delivery is asynchronous. A slow or dead provider must never block the
in-app notification, another channel, another user, or the operation that produced
the event.

The worker **re-checks every precondition at send time** — deactivation,
disconnection and key rotation between queue and send are all detected and
**cancelled**, not retried, because retrying cannot fix any of them. Bounded at 3
attempts with 60s/5m/15m backoff; retries are not user-configurable.

Statuses: `pending · sending · provider_accepted · failed · cancelled`.

**`provider_accepted` is not `delivered`.** A provider acknowledges receipt of the
*request*, not receipt by the person, and conflating them makes the history lie.

---

## API

Self-service only. **No route takes a user id** — not even optionally. That is
stronger than checking ownership against a supplied id, because it cannot be
forgotten on a route added later. Inbox ownership violations return *not found*
rather than *forbidden*, so a response cannot confirm another user's ids exist.

```
GET    /api/account/notifications/events
GET    /api/account/notifications/preferences
PUT    /api/account/notifications/preferences/:eventKey
POST   /api/account/notifications/preferences/bulk

GET    /api/account/notifications/channels
POST   /api/account/notifications/channels/email
POST   /api/account/notifications/channels/telegram/bot
POST   /api/account/notifications/channels/telegram/link
POST   /api/account/notifications/channels/telegram/confirm
POST   /api/account/notifications/channels/discord
POST   /api/account/notifications/channels/:type/test
DELETE /api/account/notifications/channels/:type

GET    /api/account/notifications/inbox
GET    /api/account/notifications/inbox/unread-count
POST   /api/account/notifications/inbox/:id/read
POST   /api/account/notifications/inbox/:id/unread
POST   /api/account/notifications/inbox/:id/archive
POST   /api/account/notifications/inbox/mark-all-read
```

Permissions: `notifications.view_own`, `notifications.manage_own`,
`notifications.channels_manage_own` — held by every ordinary role, because
managing your own notifications is part of owning an account.

---

## Adding an event

1. Publish a domain event — see [DOMAIN_EVENTS.md](DOMAIN_EVENTS.md).
2. Add a `NotificationEventDefinition`: category, severity, i18n title/description
   keys, `defaultInApp`, a recipient strategy, a permission if it needs one, and a
   `presentationBuilder`.
3. Give the builder a body, or reuse one.
4. Add the en-US and es-PR strings. The parity test enforces both.
5. Write tests. A registry test asserts every catalogue entry names a real
   builder, and vice versa.

---

## Troubleshooting

**"I get nothing."** Check the event is enabled in **Events**, that the channel
column is on, and that the channel shows **Healthy** in **Channels** — an
*Unverified* connection is never delivered to.

**"Email says not configured."** The shared relay is unset. An operator configures
it once; the Channels page says so rather than failing at test time.

**"Telegram says no code received."** The bot only sees messages sent *to* it.
Send the code, then confirm. Codes expire in ten minutes and are single-use.
Check you are messaging *your* bot — the one whose token you pasted.

**"Telegram says add a bot token first."** Telegram is per-user: create a bot with
@BotFather, paste its token, then link a chat. No administrator is involved.

**"Discord rejected my URL."** Only `discord.com`, `discordapp.com`,
`canary.discord.com` and `ptb.discord.com` are accepted, over https, with no port
or credentials, on a `/api/webhooks/…` path.

**"It arrived twice."** It should not: `(userId, eventId)` is unique for in-app and
`(notificationId, channelType)` for deliveries. Report it.

**"A card looks plain."** A builder declined — usually a payload missing its title
field. The fallback keeps it legible rather than showing a raw event key.
