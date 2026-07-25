# Domain Events & Notifications Rebuild — Phase 1 Gap Analysis

**Status:** audit only — no implementation code changed.
**Date:** 2026-07-25 · **Baseline:** v0.47.0 (`d0ba2ea`)
**Scope:** what the notification teardown actually removed, what survived, and the
exact infrastructure the rebuild must supply.

Everything below was **measured against the working tree**, not inferred from
`ARCHITECTURE.md`. Where the doc and the code disagreed, the code won.

---

## 1. Teardown confirmed

| Claim | Verified how | Result |
|---|---|---|
| No notification engine | `grep -ri notification apps/backend/src packages/shared/src apps/frontend/src` | 57 hits, **all comments** — zero live code |
| No domain-event bus | `grep -rn "@OnEvent\|this\.eventBus\." --include=*.ts` | **0 publishers, 0 subscribers** |
| Shared contracts gone | `NOTIFICATION_BUS_CHANNEL`, `NOTIFICATION_EVENTS`, `DomainEventEnvelope` | absent from `packages/shared` |
| Tables gone | migration `20260725060000_remove_notification_engine` | 23 dropped |
| Permissions gone | `permissions.ts` | 37 `NOTIFICATIONS_*` removed |

The teardown is complete. Nothing half-removed is load-bearing.

---

## 2. What survived — the rebuild's foundations

This is the important half of the audit: **most of what Phase 1 needs is already
here**, and the plan should build on it rather than reinvent it.

| Asset | Where | Why it matters |
|---|---|---|
| **`EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })`** | `app.module.ts:42` | Still wired, just unused. The **transport** survives; only the abstraction over it was deleted. `@nestjs/event-emitter@^2.1.1` is still a dependency. |
| **User-scoped socket room** | `realtime.gateway.ts:64-65` — `client.join(\`user:${payload.sub}\`)` | Joined from the **JWT subject**, never a client-supplied id. This is exactly the requirement for `user:<id>:notifications`; the hijacking threat is already closed. |
| **`toUser()`** | `realtime.gateway.ts:108` | Per-user emit already exists. |
| **`SecretCipher`** | `common/crypto/secret-cipher.ts` | AES-GCM, in use elsewhere. Channel configs need no new crypto. |
| **`AccountController`** | `modules/account`, `@Controller('account')` | Already hosts profile / password / 2FA. `/api/account/notifications/*` belongs here, and this same file is the **producer** for three security events. |
| **`MediaServerSession`** | schema | Carries `playbackState`, `progressPercent`, `playbackMethod`, codecs, `resolution`, `device`, `client`, `showTitle`, `season/episodeNumber`, `year`, `artPath` — every fact the playback cards need. **No new columns required.** |
| **`MediaArtwork`** | schema | `poster · fanart · season_poster · episode_thumbnail` + `selected` flag — the artwork resolution order in the brief is satisfiable as specified. |
| **i18n** | 25 namespaces, en-US + es-PR, parity test enforced | Add one namespace; the gate already exists. |

---

## 3. The gaps

### 3.1 No domain-event abstraction (the whole of Phase 1)

The transport exists; nothing else does. Missing: `DomainEventBus`,
`DomainEventEnvelope`, `DomainEventCatalog`, `DomainEventPublisher`,
`DomainEventSubscriber`, typed keys, payload validation, idempotency,
correlation, and subscriber failure isolation.

Note the old bus had **none of these either** — it was a raw
`eventBus.emit(CHANNEL, {event, payload, at})` with no validation, no idempotency
and no isolation. The rebuild is not restoring what was lost; it is building the
thing that should have been there.

### 3.2 🔴 Workflow event-waits are dead — precisely

`workflow-execution.service.ts:437` still sets `waiting_for_event` for a
`control.wait` node. The **only** code that can end that state is
`workflow-resume.service.ts:47-56`, which resumes on `expiresAt` — a *timeout*.
There is no event path. A workflow waiting on an event today always expires.

This is the single highest-value fix in Phase 1 and should be the first
subscriber wired.

### 3.3 Automation has no fan-in

Automation still fires, via **direct calls** from five sites:
`torrent-sync.service.ts:171`, `media-processing.service.ts:74`,
`rss.module.ts:153`, `rss-show-status-refresh.service.ts:194`,
`subtitle-trigger.service.ts:22`. Rules on those paths work. What is gone is the
generic path — a new producer cannot trigger automation without editing it.

### 3.4 No producer for storage events

The health monitor was deleted with the bus. `/api/system/health` still computes
per-root disk figures on demand (`system.module.ts:79-95`) but **nothing watches
them**, so `system.storage_warning/critical/recovered` have no source. A small
edge-fired watcher must be rebuilt — and, unlike the old one, it should publish a
domain event rather than own an alerting concept.

### 3.5 No avatar storage

`grep -c avatar schema.prisma` → **0**. Unchanged from the previous analysis.
Initials-in-CSS with a server-derived stable hue remains the only path that does
not invent an upload/storage/moderation feature.

### 3.6 🔴 `liveActivity()` still ships `ipAddress`

```ts
liveActivity() {
  return this.prisma.mediaServerSession.findMany({ orderBy: { updatedAt: 'desc' } });
}
```

An unfiltered `findMany()` — every column reaches the browser, including
`ipAddress`. This was identified before the teardown and deliberately left out of
scope then. **Phase 3 reuses this exact surface for Live Activity**, so it must be
fixed there: the shared presentation model is the natural place to redact.

---

## 4. Producer readiness — the input to Phase 7

The brief says register an event only when a real producer exists. Measured:

| Event | Producer today | Verdict |
|---|---|---|
| `media_server.user_started_watching` | session poll, create branch | ✅ site exists (emit was stripped) |
| `media_server.user_stopped_watching` | `endSession()` | ✅ site exists |
| `torrent.completed` | `torrent-sync.service.ts:171`, edge-fired | ✅ |
| `torrent.failed` | `TorrentState.ERROR` exists | ⚠️ state exists, **no transition watcher** |
| `torrent.stalled` | — | ❌ **no such state**; needs a heuristic (see §5) |
| `system.storage_*` | — | ❌ watcher deleted (§3.4) |
| `workflow.approval_requested` / `execution_failed` / `execution_completed` | `workflow-execution.service.ts` | ✅ |
| `provider.offline` / `recovered` | `EngineService.healthCheck()` returns `{online}` | ⚠️ **no transition watcher** |
| `media_server.refresh_failed` | `media-processing.service.ts:411` | ✅ |
| `security.login_failed` | `auth.service.ts:123` `registerFailedLogin()` | ✅ |
| `security.password_changed` | audit `account.password_changed` | ✅ |
| `security.api_key_created` | `apikeys.module.ts:37` `create()` | ✅ |
| `security.two_factor_disabled` | audit `account.2fa_disabled` | ✅ |
| `user.created` / `user.role_changed` | `users.module.ts:118/137` | ✅ |

**14 of 19 ship immediately. 3 need a transition watcher. 1 needs a definition.**

---

## 5. Decisions needed before Phase 7

1. **`torrent.stalled` has no definition.** There is no stalled state — it would
   be a heuristic (downloading, 0 peers or 0 B/s, for N minutes). Define it or
   drop it; a heuristic with a wrong threshold is a notification people mute.
2. **`provider.offline` / `torrent.failed` need edge-detection state.** Both mean
   "watch a boolean and publish on transition". Where should that live — a small
   shared edge-detector used by both, or one per module?

Neither blocks Phase 1.

---

## 6. Remnants to clear (found, not assumed)

Small, all mine from the teardown, all cosmetic — worth clearing in Phase 1 so
the rebuild starts on a clean tree:

| Site | Issue |
|---|---|
| `media-server-session.service.ts:28` | doc comment with **no method under it** |
| `automation.module.ts:28` | imports `EventEmitter2, OnEvent` — **unused** |
| `automation.module.ts:252-255` | comment describing an emit that no longer exists |
| `platform-schedules.service.ts:18-19` | maps two scheduler names to `notification_center` |
| `permissions.ts:240-241` | orphaned comment in `NEVER_INHERITED_PERMISSIONS` |
| `system.module.ts:85` | "Same reasoning as the health monitor above" — no monitor above |
| `jobs.service.ts:7,73` · `realtime.gateway.ts:30` | comments citing `NotificationQueue` / notifications |

---

## 7. Phase 1 plan

1. Clear the seven remnants (§6).
2. Add `packages/shared/src/domain-events.ts` — envelope, typed keys, catalog types.
3. Add `DomainEventsModule` — `DomainEventBus` over the **existing**
   `EventEmitter2`, with validation, idempotency, correlation, and per-subscriber
   `try/catch` isolation.
4. Wire the first subscriber: **workflow event-waits** (§3.2), restoring
   `resumeWaitingForEvent` against the new bus.
5. Wire the automation bridge as the second subscriber (§3.3).
6. Tests: publish/subscribe, payload validation, idempotency, failure isolation,
   workflow wait→resume, automation bridge.

No notification code in Phase 1.

**No implementation has been performed.**
