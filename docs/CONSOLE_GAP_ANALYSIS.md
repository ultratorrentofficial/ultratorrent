# UltraTorrent Console — Phase 1 Architecture Audit & Gap Analysis

**Status:** Phase 1 complete. Written against the tree at `630586d4` (v0.85.7).
**Authoritative source:** [ARCHITECTURE.md](ARCHITECTURE.md) and the code it
describes. Everything below was verified by reading the implementation, not
inferred from the doc.

The Console is an **observability client, never a management client**. This
document establishes what UltraTorrent already knows, so that the Console reuses
it rather than growing a parallel copy.

---

## 1. What already exists

### 1.1 Transport and identity

| Concern | Reality | Verdict |
|---------|---------|---------|
| REST | NestJS, global `/api` prefix, ~34 controllers, OpenAPI/Swagger | **Reuse** |
| Realtime | `RealtimeGateway` — Socket.IO on `/ws`, JWT handshake, permission-scoped rooms (`apps/backend/src/modules/realtime/realtime.gateway.ts`) | **Reuse** |
| AuthN | `POST /api/auth/login` → `{ accessToken, refreshToken, user }`; `POST /api/auth/refresh` rotates; optional TOTP; `GET /api/auth/me` | **Reuse** |
| AuthZ | `JwtAuthGuard` + `PermissionsGuard` + `@RequirePermissions(...)`; SUPER_ADMIN short-circuits in the guard | **Reuse** |
| Permission catalog | `packages/shared/src/permissions.ts` — ~180 dot-namespaced keys, 5 system roles | **Reuse** |
| Domain events | `DomainEventBus` over `EventEmitter2`, single channel `domain.event`, catalogued + validated + deduped (`modules/domain-events/`) | **Reuse** |
| Audit | `AuditLog` model; `GET /api/audit` (paged, `audit.view`) | **Reuse** |

The JWT carries `{ sub, username, roles, permissions, type:'access' }` and the
gateway reads `permissions`/`roles` off the handshake token to decide room
membership. The Console therefore gets RBAC on the socket for free.

### 1.2 Operational data the backend already owns

Every question in the Console brief maps to state a service already holds:

| Console view | Existing source | Endpoint(s) |
|--------------|-----------------|-------------|
| Overview | `DashboardService.summary()` / `.recentActivity()` | `GET /api/dashboard/summary`, `/activity` |
| Downloads / Seeding | `TorrentSyncService` → normalized `TorrentWithPlatformState` (incl. `parked`, `intake`) | `GET /api/torrents`, WS `torrents:update`, `stats:update` |
| Queue | `torrent_scheduler` module — decisions, policies, engine modes, overrides | `GET /api/torrent-scheduler/preview[/:engineId]`, `/policies`, `/engines`, `/history/:engineId` |
| Media Intake | `MediaIntakeService` + `media_intake_jobs` / `media_intake_events` | `GET /api/media/intake/summary`, `/jobs`, `/jobs/:id` |
| Media | Media Manager (libraries, items, health, rename history) | `GET /api/media/...` |
| Live Activity | `MediaServerSessionService.liveActivity()` — already IP- and `artPath`-redacted | `GET /api/media-server-analytics/live` |
| Jobs | Unified Jobs Center (`platform_jobs`), visibility-scoped per caller | `GET /api/jobs/overview`, `/list`, `/:id`, `/:id/events` |
| Automation | `AutomationRule` + `AutomationLog` | `GET /api/automation/rules`, `/rules/:id/logs`, `/catalog` |
| Acquisition / RSS | Feeds, rules, `RssHistory`, `RssAcquisition`, match evaluations | `GET /api/rss/feeds`, `/rules`, `/feeds/:id/history`, `/rules/:id/match-history` |
| Infrastructure | Engine health, `Indexer.status`, Prowlarr status, subtitle provider health, `MediaServerIntegration.status` | `GET /api/engines/health`, `/api/indexers`, `/api/integrations/prowlarr/status`, `/api/subtitle-intelligence/providers`, `/api/media-server-analytics/connections` |
| Notifications | `UserNotificationDelivery` (status/attempts/lastError/suppressedReason) | `GET /api/account/notifications/inbox` (own only) |
| System | `SystemService.health()` — process uptime/RSS/load/cpus, engine health, per-root `statfs` | `GET /api/system/health`, `/version`, `/live`, `/ready` |

### 1.3 Secret hygiene already in place

The backend already redacts at the source, which is the posture the Console
needs: `liveActivity()` maps field-by-field and withholds `ipAddress`/`artPath`;
media-server integration secrets are AES-GCM encrypted and redacted in
responses; `Indexer.config` stores `apiKey` as ciphertext; job payloads pass
through `modules/jobs/platform/job-redaction.ts`. **No new redaction framework
is warranted** — the aggregate endpoint must project explicitly rather than
spread, and reuse `job-redaction` where it forwards job payloads.

---

## 2. Gaps — what the Console needs and the platform does not have

### G1. No aggregate operations snapshot *(blocking; Phase 2)*

There is no single endpoint answering "what is UltraTorrent doing right now".
A naive Console would issue **13+ requests per refresh** across
dashboard/torrents/intake/jobs/analytics/scheduler/rss/automation/engines/
indexers/prowlarr/subtitles/system.

**Resolution:** a new read-only `operations` module exposing
`GET /api/operations/snapshot`, which *composes existing services* — no new
queries into other modules' tables, no new polling. Each domain is resolved
independently and degrades to `{ available:false, reason }` rather than failing
the whole response, satisfying both the permission-filtering and the
partial-failure requirements.

### G2. No unified, permission-filtered event stream *(blocking; Phase 2/9)*

`DomainEventBus` is **in-process only**. Nothing bridges it to `RealtimeGateway`,
and the WS event vocabulary is a set of per-module channels
(`torrents:update`, `jobs.*`, `media_manager.*`, `rss.*`, …) with no chronological
merged feed. The event-stream narrative in the brief cannot be built from what
ships today.

**Resolution:** an `OperationsEventBridge` that **subscribes** to the existing
bus (it does not become a second bus), maps each `DomainEventKey` to the
permission required to read it, sanitizes the payload to a bounded projection,
and re-emits via the gateway's existing `emitToPermission()`. Historical depth
continues to come from Audit — the Console must not present the ring buffer as
history.

Note: the bus catalog is currently narrow (~25 keys — playback, torrent
completion/failure, scheduler transitions, storage, workflow, provider, security,
users). Rich per-module lifecycle facts live on the WS channels instead. The
bridge therefore merges **two** sources: bus events *and* the already-scoped
`jobs.*` channel, without adding a producer anywhere.

### G3. `console.view` does not exist *(Phase 2)*

**Resolution:** add exactly one permission, `console.view`, meaning "may use
UltraTorrent Console". It grants **no** domain access: every snapshot domain is
still gated by its existing permission (`torrents.view`, `media_intake.view`,
`jobs.view`, `media_server_analytics.view_live_activity`, `automation.view`,
`rss.view`, `system.view`, `audit.view`, `indexers.view`,
`integrations.prowlarr.view`, `subtitle_intelligence.view`,
`media_manager.view`, `torrent_scheduler.view`, `notifications.view_own`).
Granted to `READ_ONLY`, `POWER_USER`, `USER`, and inherited by `ADMINISTRATOR`.

### G4. API keys are decorative — there is **no** token authentication path

`ApiKeysService` creates, lists and revokes `ApiKey` rows, and
`GET/POST/DELETE /api/api-keys` are wired. **Nothing authenticates with them.**
There is no `ApiKeyGuard`, no passport strategy, and no read of
`prisma.apiKey.findFirst` anywhere outside the module itself (verified by grep
across `apps/backend/src`). `scopes` is stored and never consulted.

This matters for the brief's "extend the existing token mechanism rather than
creating another authentication system": **there is no working mechanism to
extend.** Building one is a new authentication path — precisely what the brief
forbids elsewhere — and it would need its own guard, scope-evaluation, rotation
and revocation story.

**Resolution (recommended):** the Console authenticates with the *existing*
JWT login + refresh-token rotation, exactly as the SPA does. Read-only-ness is
enforced by **the account's role**, which is the platform's actual authorization
boundary: an operator creates a `READ_ONLY` (or custom) account holding
`console.view` plus the `*.view` grants, and the backend refuses every mutation
for it regardless of what binary is talking to it. Only the refresh token is
persisted, in the OS keyring where one is available.

This is recorded as a **known gap, not a Console feature**: making `ApiKey`
actually authenticate is a platform decision that belongs to its own change.

### G5. No version/capability handshake for a non-browser client *(Phase 2)*

`GET /api/system/version` is public and returns `{ product, version, edition,
apiVersion:'v1', gitTag, gitSha, buildTime, node }` — enough to *name* a build,
not enough to negotiate. A console binary needs to know which operations
contract the backend speaks.

**Resolution:** `GET /api/operations/capabilities` (authenticated,
`console.view`) returning the operations contract version, the domains this
backend can serve, and the domains **this caller** is permitted to see — so the
Console hides what it cannot fetch instead of rendering thirteen permission
errors.

### G6. No backend-side CPU metric

`SystemService.health()` reports `os.loadavg()` and `os.cpus().length`, not a CPU
percentage. The brief's Overview shows `CPU 18%`.

**Resolution:** derive percentage in the Console from load average ÷ core count,
labelled as load — **not** by collecting host metrics from the console process,
which would break the "console observes, never measures" rule. No backend change.

### G7. i18n is frontend-only

`i18next` + typed JSON under `apps/frontend/src/i18n/locales/{en-US,es-PR}/`.
It is React-coupled; nothing is shareable with a Go binary.

**Resolution:** the Console carries its own embedded catalogs (`go:embed`) with
the same two locales and the same key discipline. Duplicated *strings*, not a
duplicated *system* — there is no way to link i18next into a Go binary, and
fetching UI strings from the server would make the Console unusable while
disconnected, which is exactly when its status text matters most.

### G8. No client workspace outside `apps/`

`package.json` declares workspaces `packages/*` and `apps/*`. A Go module must
not be an npm workspace.

**Resolution:** `clients/console/` — outside both globs, so `npm install`,
`npm test --workspaces` and the release tooling never see it, and it builds and
releases independently as the brief requires.

---

## 3. Explicitly *not* built

Per the brief and the platform's own principles:

- **No second event bus** — `OperationsEventBridge` subscribes to `DomainEventBus`.
- **No second monitoring store** — the snapshot reads current normalized state; the ring buffer is client-side and non-authoritative.
- **No second audit system** — `GET /api/audit` remains the historical record.
- **No second auth system** — JWT login/refresh, unchanged (see G4).
- **No second health framework** — Infrastructure projects existing per-provider status columns and health checks.
- **No second torrent sync** — the Console reads `TorrentSyncService`'s fan-out.
- **No direct integrations** — no DB, Redis, engine, media-server, filesystem or provider client exists in Console code; enforced by test in Phase 11.
- **No alert store** — alerts are a **projection** computed from health/job/intake/storage/scheduler state at snapshot time. They are not entities, have no ids that survive a restart, and cannot be acknowledged. Documented as such.

---

## 4. Constraint found during the audit

**Go is not installed on this host and `/` is at 98% (1.4 GB free).** A Go
toolchain plus module cache for Bubble Tea/Bubbles/Lip Gloss is roughly
400–600 MB. The network reaches `proxy.golang.org`. This does not change the
design — it changes whether the Go half can be *compiled and tested here*, and
the brief is explicit that no test may be reported as passing unless it ran.
Raised with the operator rather than resolved unilaterally, since the same disk
already has an unresolved ENOSPC failure (the IMDb trigram index).

---

## 5. Delivery order

| Phase | Content | Depends on Go? |
|-------|---------|----------------|
| 1 | This document | — |
| 2 | ✅ `operations` module: snapshot, capabilities, event bridge, `console.view` | No |
| 3–10 | Console binary: CLI, config, API/realtime clients, state model, views, UX | Yes |
| 11 | Security hardening + no-mutation tests (both halves) | Both |
| 12 | Cross-platform builds, packaging, CI, docs | Yes |

Phase 2 is independent of the toolchain question and is implemented first.

---

## 6. Phase 2 as built (2026-08-22)

G1, G2, G3 and G5 are closed. What shipped differs from the plan above in three
places, each because the audit was written from the doc-level shape of the data
and the implementation met the columns:

- **G1 (snapshot).** Built as designed — 16 domains, each behind its own view
  permission and a 4 s deadline, every list capped server-side. Three contract
  fields were dropped or changed because the platform does not hold them: RSS
  feeds record no `lastError` (poll failures are logged, never persisted), so
  feed health is staleness against `refreshIntervalSeconds`; acquisition events
  take their rule attribution from `RssRuleMatchEvaluation` rather than
  `RssHistory`, which has no rule column; and activity items carry
  `detail`/`level`/`eventCount` instead of an `actor`, which the dashboard's
  collapse step does not preserve.
- **G2 (event stream).** Built as designed, including the two-source merge. The
  gateway needed one addition the audit did not anticipate: `jobs.*` events are
  emitted to `perm:<permission>` rooms, and a console's audience is the
  *intersection* of `console.view` and the domain permission — which a single
  room per permission cannot express. Console sockets therefore join
  `console:<permission>` rooms of their own, and the bridge emits to those.
- **G4 (API keys) remains open and untouched.** The console authenticates with
  the existing JWT login and refresh rotation, as recommended. Nothing here made
  `ApiKey` authenticate anything.

Phases 3–12 still depend on the Go toolchain question in §4. Note that the disk
pressure recorded there has since eased.
