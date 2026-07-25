# Personal Notification Engine — Security Model

**Scope:** the personal notification engine (`modules/notification-center/`) — ownership,
eligibility, channel connections, delivery, and the account-scoped API.

The engine's central security property is simple to state and everything else follows
from it:

> **A notification belongs to exactly one locally authenticated UltraTorrent user.**

The model it replaces had no such property. In-app notifications had a *nullable*
owner and, on a live install, `userId` was null for **all 1,729 rows** — every one a
broadcast to whoever was connected. Recipient resolution performed no permission,
resource or eligibility check of any kind. External delivery used one shared
credential set for the whole install. Those are the holes this document is about.

---

## 1. Trust boundaries

| Boundary | What crosses it | Control |
|---|---|---|
| Browser → API | JWT bearer | `JwtAuthGuard` + `PermissionsGuard`; the acting user is read from the token, never from a parameter |
| API → engine | user id | `NotificationRecipientEligibilityService` — fail closed |
| Engine → provider | decrypted destination | `PersonalTransmitter` only; classified errors out, never the destination |
| Provider → internet | webhook URL | host allow-list applied to the **supplied** host |
| Engine → browser | in-app payload | per-user socket room derived from the token subject |

---

## 2. Identity: who may own a notification

**Eligible:** a row in `users` with `isActive = true`. That table contains only local,
password-authenticating accounts — every row has a `passwordHash` and there is no
federated import path into it — so no `origin` discriminator was added; a redundant
field can drift from reality, and the single authority is
`NotificationRecipientEligibilityService`.

**Never eligible:** `MediaServerUser` (Plex/Jellyfin/Emby viewers), Trakt links, API
keys, service identities. These live in separate tables with separate keyspaces.

Two traps worth naming, because both look like the answer and are not:

- **`User.isSystem` is not a service-account marker.** It means "seeded account that
  cannot be deleted". Filtering on it would silence the primary operator.
- **Email is not an identity.** A Plex account legitimately carries the same address
  as a real operator account. The eligibility service therefore looks up **by primary
  key only** — never by email or username — and a test asserts that no lookup uses
  those fields.

---

## 3. Threat model

Each threat lists the concrete mitigation and, where one exists, the test that pins it.

### Cross-identity

**T1 — An external user receives a notification.**
Eligibility is checked before anything else, including before permissions, so an id
from another namespace never reaches the permission tables. Audience resolution is an
intersection, and the resolver fails closed. *Tested:* external ids for Plex, Jellyfin,
Emby, Trakt, imported playback, service and API-key identities are all rejected.

**T2 — A media-server identity is mistaken for a local account.**
The pre-existing defect: `recipient.service.ts` resolved recipients from
`payload.userId`, while `media-server-session.service.ts` puts a **provider** user id
in that same field. Two namespaces, one unvalidated lookup. Measured as **dormant** (0
of 59 live rules set `mapEventUser`), and structurally removed in the new engine,
where the only recipient source is an audience resolver over `users`.

**T3 — Forged recipient ids from automation.**
`NotificationActionBridge` validates every explicitly named recipient against the
eligibility service and *reports* rejections rather than dropping them silently.

### Cross-user

**T4 — Reading another user's inbox.**
Every inbox query is scoped by the JWT-derived `userId`. A foreign id returns **the
same response as a missing one**, so a reply cannot confirm the object exists.

**T5 — Editing another user's preferences.**
The account controller has **no `:userId` parameter anywhere** — not even optional.
There is no request shape that addresses another person, which is stronger than
checking ownership on a supplied id because it cannot be forgotten on a route added
later.

**T6 — Using another user's channel connection.**
The security boundary of the routing feature. A route names a connection by id;
without validation anyone could route their events through someone else's Telegram
chat, reading that destination and sending to it. Ownership is verified on every route
write and again at delivery. *Tested,* including that the error for "not yours" is
byte-identical to "does not exist".

**T7 — Cross-user bulk actions.**
Bulk operations take event keys, never user ids, and are scoped to the acting user.

**T8 — Delivery through a connection revoked mid-flight.**
The worker re-checks ownership, enabled and verified state at **attempt** time.

### Credentials and secrets

**T9 — Secret leakage through the API.**
Connection config is AES-GCM encrypted at rest and returned by **no** read path.
Listings render from a `destinationMask` computed once on write, so the common case
never decrypts. *Tested:* the raw address does not appear anywhere in a serialized
connection view.

**T10 — Secret leakage through logs.**
`PersonalTransmitter` is the only code that touches a decrypted destination and never
returns one — failures come back as classified error codes. Provider error **bodies
are deliberately not captured**: a webhook echo would put the credential in the log.

**T11 — Undecryptable config after key rotation.**
Treated as an unusable connection rather than delivering to a garbage destination.

**T12 — Verification-token and linking-code theft.**
Telegram linking codes are single-use, expire in 10 minutes, and are stored **only as
SHA-256 hashes** — in memory, so a restart cancels pending links rather than
persisting a bearer credential. *Tested:* the raw code never appears in the store.

**T13 — Linking-code replay.**
The code is consumed on first use, before the rest of the flow runs.

**T14 — Connection reassignment / chat hijack.**
A Telegram chat already bound to a different account is **refused**, not silently
re-pointed — re-pointing would divert that person's notifications. Direct creation of
a Telegram connection is rejected outright, because a chat id supplied by a client
could name somebody else's chat.

### Network

**T15 — SSRF via Discord webhook.**
The server fetches the webhook URL, so an unrestricted one reaches cloud metadata
(`169.254.169.254`), loopback, the private network, or any internal service name. A
host **allow-list is applied to the host the user supplied**, not to what it resolves
to — a resolve-then-fetch check is defeated by DNS rebinding. HTTPS and a
`/api/webhooks/` path are also required. *Tested* against seven attack shapes,
including the lookalike `discord.com.evil.example`.

**T16 — WhatsApp destination spoofing.**
Numbers are normalised to E.164 and a number **without a country code is rejected, not
guessed** — guessing a country would silently message a stranger.

**T17 — Provider hang pinning the worker.**
Every provider call is bounded by a timeout.

### Authorization

**T18 — Notification about a resource the recipient cannot see.**
Every event declares a `requiredPermission`; recipients who do not hold it are
filtered out. `SUPER_ADMIN` is matched by role, since it holds permissions implicitly.

**T19 — Delivery after permission revocation.**
Re-checked at attempt time, not trusted from queue time.

**T20 — Delivery after user deactivation.**
Same mechanism: the worker terminates the delivery with **no provider call**.
*Tested* — `transmit` is asserted never to have been invoked.

**T21 — Deep link as a capability.**
A link is a pointer, never an authorization. The destination route re-authorizes
normally; having received a notification grants nothing.

**T22 — Payload information leakage.**
Events carry a `sensitivity` classification; `security`-class events are never
aggregated into digests and never bypassed by quiet-hours defaults.

### Availability and abuse

**T23 — Retry storm / thundering herd.**
Bounded attempts with exponential backoff and **±25% jitter**: without jitter an
outage failing a hundred deliveries would retry all hundred at the same instant and
re-create the herd. A provider's `Retry-After` always wins.

**T24 — Ban through hammering a revoked credential.**
Credential, destination and payload failures are classified **terminal** and never
retried.

**T25 — Notification spam / flooding one inbox.**
Per-user dedupe collapses repeats into a `groupCount` instead of inserting; digest
assembly aggregates further. Dedupe is scoped by user, so one person's suppression can
never silence another's.

**T26 — Event replay / duplicate bus delivery.**
A unique `(userId, dedupeKey)` index makes dispatch idempotent.

**T27 — Delivery amplification.**
Deliveries are created per selected route only; there is no global fan-out to amplify.

**T28 — Digest duplication after a crash.**
The digest period is claimed *before* assembly, under a unique
`(userId, kind, periodEnd)`.

**T29 — Quiet-hours bypass.**
`bypass` is a per-event setting the recipient controls, not something a sender can
assert. Only catalogue defaults mark security/account events as bypassing.

### Administrative surface

**T30 — Admin diagnostics exposing personal data.**
`notifications.admin.view_user_summary` reads another person's activity, so it is in
`NEVER_INHERITED_PERMISSIONS` — an `ADMINISTRATOR` does not receive it with the
blanket bundle and must be granted it deliberately. Diagnostics never expose secrets
and cannot edit anyone's preferences.

**T31 — Global settings overriding personal preference.**
There is no global preference surface. The one admin control that outranks a personal
choice is `NotificationRule.forced`, which is **visible and locked in the UI** rather
than silent, and exists so a security alert cannot be muted. It is a deliberate
product decision, recorded here because "the user always wins" and "an admin can
guarantee a breach notice arrives" cannot both be absolute.

**T32 — Legacy global routing left active.**
Detected, not assumed: `ops/scripts/notification-engine-validate.sql` fails the
cutover while any enabled legacy rule still pins channels or the global credential
blob exists.

### Realtime

**T33 — WebSocket room hijacking.**
Rooms are joined from the JWT subject on connect. Nothing subscribes by a
client-supplied user id, which is precisely how a room becomes hijackable.

---

## 4. Audit

Recorded with actor, target, action, channel type, **masked** destination, event key,
result and correlation: profile changes, preference and bulk preference changes,
resets, connection create/update/verify/enable/disable/revoke, linking-code issue and
confirmation, pause/resume, and migration actions. **Decrypted secrets are never
logged.**

---

## 5. Residual risks

Stated plainly rather than omitted:

1. **Shared infrastructure transports.** Email (SMTP) and the Telegram bot token are
   platform-level. Compromising them affects everyone's delivery — but no *per-user*
   secret exists to leak, which is why this model was chosen over per-user SMTP.
2. **Message rendering is incomplete.** External bodies currently send the event key
   rather than localized text. Not a confidentiality issue, but it means delivered
   content is not yet reviewed for sensitivity per channel.
3. **In-memory linking codes** are lost on restart (a usability cost accepted for a
   smaller blast radius) and are not shared across replicas.
4. **The legacy engine still runs in parallel** until the cutover completes; its
   unowned in-app rows remain until archived.
5. **No rate limiting on channel-test/verification endpoints yet** — bounded by the
   fact that no test endpoint is exposed until it is implemented.
