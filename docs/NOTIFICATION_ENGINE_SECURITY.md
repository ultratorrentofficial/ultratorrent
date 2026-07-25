# Notifications — Security Model

Threats specific to a system that takes internal events, decides who may know
about them, and sends them to destinations users control.

Each entry states the threat, the control, and where it lives. Where a control is
*absent*, that is stated too.

---

## 1. An external identity becomes a recipient

**Threat.** A Plex, Jellyfin, Emby, Trakt or API-client identity owns a
notification profile and receives internal events.

**Control.** `NotificationRecipientEligibilityService` is the single authority and
looks up **by primary key only**. Never email, never username — a media-server
account legitimately shares an operator's email address, and the previous engine
read a media-server user id from the same payload field as a local one.

It fails closed: an id that does not resolve to an *active* local user is not
eligible, with no fallback to "notify the admin instead".

`User.isSystem` is deliberately **not** a filter — it means "seeded and
undeletable", not "service identity", and filtering on it would silence the
bootstrap admin.

*Tested:* external ids rejected; email match does not imply eligibility; the
lookup's `where` clause is asserted to contain only `id`.

---

## 2. Cross-user access

**Threat.** One user reads or edits another's inbox, preferences, channels or
delivery state.

**Controls.**
- **No API route takes a user id** — not even optionally. The acting user always
  comes from the JWT. Stronger than checking ownership on a supplied id, because
  it cannot be forgotten on a route added later.
- Ownership is a NOT NULL column with a cascading FK, not a convention.
- Inbox violations return **not found**, never forbidden, so a response cannot
  confirm another user's ids exist.
- No administrative surface can edit another user's preferences. It does not exist.

---

## 3. Socket room hijacking

**Threat.** A client subscribes to another user's notification stream.

**Control.** The gateway joins `user:<id>` from the **JWT subject** on connect —
never from a client-supplied id. `toUser()` emits only to that room.

---

## 4. Email verification abuse

**Threat.** A user points notifications at an address they do not control, or an
unverified address silently swallows everything.

**Controls.** Connect and verify are one call; a failed test leaves the connection
unverified, and `resolveDestination` refuses anything unverified, disabled or
disconnected. Re-pointing **resets verification**, so a typo cannot inherit a
working address's trust.

**Residual risk.** A test send proves the address *accepts mail*, not that the
person owns it. Meaningful ownership proof would need a click-through token; for a
self-hosted tool where a user configures their own address, this is judged
sufficient. Stated rather than implied.

---

## 5. Telegram code replay and interception

**Threat.** A linking code is reused, guessed, or captured to bind an attacker's
chat.

**Controls.**
- Codes are **SHA-256 hashed** in memory; the plaintext is shown once and never
  stored, so a dump cannot complete someone's linking.
- **Single use** — consumed on redemption.
- **10-minute expiry.**
- **One live code per user** — issuing a second invalidates the first, so a code
  read over a shoulder stops working the moment they retry.
- **Per-user rate limit** on issuance.
- An advancing `getUpdates` **offset**, so a consumed message cannot be replayed.
- Redemption refuses a code belonging to a different user even with the plaintext.

**Residual risk.** Six digits is guessable in principle; single use, a ten-minute
window, per-user rate limiting and the requirement to already control *some* chat
make it impractical here.

---

## 6. Duplicate chat binding

**Threat.** Two accounts point at one Telegram chat and each silently receives the
other's notifications.

**Control.** Linking refuses a chat already bound to a different account. A user
re-linking their **own** chat is allowed. A row that no longer decrypts after key
rotation is skipped rather than blocking a legitimate link.

---

## 7. Discord SSRF

**Threat.** A webhook URL points at internal infrastructure — cloud metadata,
loopback, RFC1918 — turning the server into a request proxy.

**Control.** An **allow-list applied to the host as supplied**, never to a resolved
address. A resolve-then-fetch check is defeated by DNS rebinding: the name
resolves to something harmless when checked and to `169.254.169.254` when fetched
moments later. Pinning the *name* removes the race, because DNS never enters the
decision.

Also refused: plaintext (which would send the webhook token in the clear),
embedded credentials, non-standard ports, non-webhook paths, and lookalikes such
as `discord.com.evil.example` that defeat a substring check. **Redirects are
refused** — a redirect could carry the request off the allow-listed host. The URL
is **re-validated at send time**, so a row written before a rule tightened cannot
bypass it.

This is sufficient *because the legitimate destination set is four fixed
hostnames*. A general-purpose webhook feature would need far more.

---

## 8. Secret leakage

**Threat.** SMTP passwords, bot tokens, chat ids or webhook URLs reach a
response, a log or a notification body.

**Controls.** All AES-256-GCM encrypted at rest. Decryption happens only in the
channel service, only for the delivery path and the test route. Endpoints return
masks; **no read method returns a real destination**. The Discord webhook token
never appears, not even partially. The API-key event carries the key *name* only.
Provider errors are surfaced without echoing the URL.

---

## 9. Markup and mention injection

**Threat.** A media title containing markup breaks a message, injects a masked
link, or pages an entire Discord server.

**Controls.** Email escapes every interpolated value. Telegram uses **HTML parse
mode** (five escapes) rather than MarkdownV2 (eighteen, and rejects the whole
message on one miss). Discord escapes Markdown so `[text](url)` cannot become a
masked link, and every payload carries `allowed_mentions: { parse: [] }` so
Discord resolves nothing; the text is additionally neutralised as belt-and-braces.

Truncation is **character-based**, not code-unit — slicing a surrogate pair
produces invalid UTF-8 and a rejected message.

---

## 10. Private artwork exposure

**Threat.** Library artwork becomes publicly fetchable.

**Controls.** The presentation carries an artwork **reference**, never a URL.
In-app images are bearer-fetched through an authenticated proxy. The
notification-scoped proxy reads connection and path from **stored state, never the
request**, so it cannot become a fetch-anything proxy, and it is gated by
ownership **and** permission.

**External channels omit artwork entirely** rather than minting a URL that would
outlive the notification.

---

## 11. Unsafe deep links

**Threat.** A producer aims a notification's link at an arbitrary destination.

**Control.** Deep links are literals in builder code or a fixed server-side map —
**never read from a payload**. The destination route re-authorizes on arrival, so
a link is a hint, never a capability.

---

## 12. Event replay and duplicate delivery

**Threat.** A redelivered event notifies twice, or a poller republishes forever.

**Controls.** `(userId, eventId)` is unique for in-app rows and
`(notificationId, channelType)` for deliveries — a collision is a no-op, not an
error. The bus dedupes by event id and by *fact* within a per-event window, and
polled producers use edge detection so only transitions publish.

---

## 13. Delivery after deactivation or permission removal

**Threat.** A queued delivery is sent after the recipient is deactivated, has
disconnected the channel, or has lost the permission that qualified them.

**Controls.** The worker re-checks **at send time**: active account, and a
connection that still exists, is enabled and is verified. Failures are
**cancelled**, not retried, because retrying cannot fix them.

**Residual risk.** Permission loss between queue and send is *not* re-checked —
the audience is resolved at dispatch. The window is one worker tick (30s), and the
already-created in-app row would remain regardless. Recorded rather than claimed
as covered.

---

## 14. Notification failure breaking the operation

**Threat.** A provider outage fails a download, a workflow, or another subscriber.

**Controls.** `publish()` never throws. Each subscriber is individually wrapped.
The dispatcher isolates per recipient and never throws at the bus. External
delivery is fully asynchronous.

---

## Deliberately absent

- **Ownership proof for email** beyond a successful send (§4).
- **Permission re-check at send time** (§13).
- **Artwork on external channels** — by design, §10.
- **A dead-letter UI.** Exhausted deliveries are `failed` with `lastError`;
  surfacing them is a later decision.
- **Rate limiting on notification volume.** Dedupe windows and edge detection
  bound the common cases; a hostile producer is not in the threat model, since
  every producer is first-party code.
