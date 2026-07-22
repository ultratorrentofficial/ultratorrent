# Library Cleanup Center — Phase 1: Architecture Review & Gap Analysis

**Status:** Phase 1 — *design only, no implementation.* Await sign-off before code.
**Module:** `library_cleanup` · `LibraryCleanupModule` · `/api/media/cleanup` · Media workspace → **Cleanup Center**
**Authority:** [ARCHITECTURE.md](ARCHITECTURE.md) is canonical. This document records what exists, what is
missing, and the smallest coherent extension that delivers the brief without replacing any subsystem.

---

## 1. The decision this feature is allowed to make

[DUPLICATE_CLEANUP_SAFETY.md §No automated cleanup](DUPLICATE_CLEANUP_SAFETY.md#no-automated-cleanup) records a
deliberate architectural decision: **no destructive automation exists today**, and it names the exact
preconditions a future destructive action must carry. This module is that future action, so it is an
*extension of* the documented decision, not a bypass. Each precondition maps to a deliverable:

| Precondition (existing doc) | How this module satisfies it |
|---|---|
| explicit opt-in | Policies ship **disabled**; `enable` is a separate audited call behind `library_cleanup.policy.enable`. |
| a strict high-confidence policy | Measured-data requirement, mandatory exclusions, ambiguity refusal (§7, §9). |
| preview persistence | `MediaCleanupPlan` — execution takes a `cleanupPlanId` only (§10). |
| Trash-only behaviour | Unattended modes are quarantine/Trash. Permanent delete is manual-only behind its own permission (§11). |
| a dedicated elevated permission | The `library_cleanup.*` block, `permanent_delete` never granted by default (§14). |
| a configurable maximum files/bytes per run | Storage-pressure caps + per-plan caps (§13). |

**Corollary:** the existing duplicate cleanup path stays non-automated. This module does not add a
destructive automation action to the duplicate surface.

---

## 2. Reuse map — what already exists and must NOT be rebuilt

Verified in the working tree. These are the seams this module extends.

| Need | Existing implementation | Decision |
|---|---|---|
| Media identity ("same media") | `duplicateKeys()` — `media-duplicate.service.ts:199-253`. Pure, tested, **scopes external IDs** (`external_id:<provider>:<id>:<year|title+ep>`) after three different films shared one IMDb id. | **Reuse verbatim** for replacement-aware cleanup. No parallel matcher. |
| "Which copy is better" | `recommend()` — `duplicate-recommendation.ts:198-263`. Weighted tiers: measured height **1000** > bitrate **100** > audio channels **10** > size **1** (tiebreak) > mtime > id. | **Reuse** as the replacement comparator. |
| Refusing to rank on mixed evidence | `heightsFor()` — `duplicate-recommendation.ts:121-130`: if *some* candidates are measured and some only filename-parsed, resolution is discarded entirely. | **Reuse**; it is precisely the measured-vs-inferred discipline the brief demands. |
| Persisted plan + staleness | `MediaDuplicateResolution` (`schema.prisma:1110`) with **version pinning** (`duplicate-resolution.service.ts:485-496`) and **fingerprint pinning** (sha256 of path+size, `media-show-duplicate.service.ts:974-986`). | **Mirror the pattern** with a cleanup-specific fingerprint (§10). |
| Journal-before-mutation | `MediaDuplicateResolutionAction` written `status:'running'` **before** the fs step — `duplicate-resolution.service.ts:534-542`. | **Mirror.** Note `TrashService.moveToTrash` moves the file *before* writing its row (`trash.service.ts:192,194`), so cleanup must keep its own journal. |
| Skip-unchanged digest | `inputDigest()` — `media-duplicate.service.ts:766-784`: one Postgres `md5(string_agg(...))` query; taken **before** rows load; stored **only after** a finished run. | **Mirror** with a policy-scoped digest (§16). |
| Resolution classification | `resolutionFromHeight(height, width)` — `media-probe.service.ts:54-63`. **Already width-aware.** | **Extend, don't replace** (§6). |
| Deletion | `FilesService.remove(dto, ctx, scope)` — `files.service.ts:240`. | **Reuse**, always `scope: 'storage'`. |
| Path safety | `storageSafety` (hard roots, never narrowed) vs `safety` (browse) — `file-path.service.ts:90-115`; `assertWithinHardRoots`, `assertDeletable`, `SYSTEM_DIRS`, realpath containment (`path-safety.ts:84-165`). | **Reuse**; system-initiated ⇒ `storageSafety` + `PathScope 'storage'`. |
| Item protection valve | `MediaItem.locked` (`schema.prisma:727-732`). | **Reuse as a mandatory exclusion.** |
| Background work | Jobs Center `PlatformJobService`/`JobRegistry`; `PlatformJob` already has **`mediaItemId`**, `libraryId`, `resourceType/Id` and `ACTIVE_STATUSES` (`job-status.ts:39-50`). | **Reuse**; parent run job + child batch jobs. |
| Condition evaluation | `domain/condition-eval.ts` (8 operators, no `eval`) + `domain/template.ts` — built for the Workflow Builder. | **Reuse verbatim.** No new expression language. |
| Immutable versioning | Workflow Builder's single-mutable-draft → frozen published version → fork-on-edit. | **Mirror** for policies. |
| Approvals | `WorkflowApproval` + `workflows.approve` flow. | **Mirror** (a cleanup plan is its own approvable object; see §17 D-4). |
| Bus / scheduler / notifications / RBAC / nav / i18n | Shared `NOTIFICATION_BUS_CHANNEL`, `@nestjs/schedule`, Notification Center seed catalog, `PERMISSIONS`, `NAV_CONTRIBUTIONS`, i18next namespaces. | **Reuse.** No second anything. |

### Positioning against the existing Cleanup Wizard
`files/file-cleanup.service.ts` already ships a **File Manager** "Cleanup" (categories `sample_files`,
`partial_downloads`, `orphan_subtitles`, …). It is *path-heuristic*, has **no persisted plan, no staleness
check, no journal, and no media awareness**, and takes client-supplied relative paths. The Cleanup **Center**
is a different product: media-aware, policy-driven, plan-executed. They must not be merged or renamed into
each other; the UI copy and nav labels must keep them distinguishable (§15).

---

## 3. Gap analysis

Severity: **S1** blocks safe deletion · **S2** blocks a brief requirement · **S3** quality/scale.

| # | Gap | Evidence | Sev |
|---|---|---|---|
| G1 | **No per-item playback aggregate.** No `playCount`/`lastPlayedAt` column anywhere. Per-item plays exist only as `groupBy(['title'])` over `media_server_watch_history` — **keyed by display-title string**. | `media-server-report.service.ts:186-199` | **S1** |
| G2 | **No FK from any watch/session/history row to `media_items`/`media_files`.** Linkage is title text + external ids only. | `schema.prisma:104,1206,1247` | **S1** |
| G3 | **`MediaUserWatch` can never yield a count** — `@@unique([userId, key])`; a rewatch collapses to one row by construction. | `schema.prisma:122`; `trakt-sync.service.ts:444` | **S1** |
| G4 | **No completion semantics for counting.** A `MediaServerWatchHistory` row is written for a 30-second sample exactly as for a full play; the only threshold in-repo is **80%** (`WATCHED_THRESHOLD_PCT`), not 90%. | `trakt-scrobble.service.ts:31`; `media-server-session.service.ts:147-179` | **S1** |
| G5 | **Active playback is not answerable per file.** Sessions carry no path and no item id, are hard-deleted on stop, and a 15 s poll gap is indistinguishable from a stop. **No deletion path consults sessions at all.** | `media-server-session.service.ts:51,135-173` | **S1** |
| G6 | **Bit-depth/colour fields absent.** `videoBitDepth`, `chromaSubsampling`, `colorPrimaries`, `colorTransfer`, `colorSpace`, `hdrFormat` — zero hits in schema or probe. `hdr` is truncated at the first `/`. | `schema.prisma:780-836`; `media-probe.service.ts:82-116` | **S2** |
| G7 | **Provenance is not written for filename-derived tech.** The scanner spreads filename guesses into `MediaFile` **without** `techSource:'filename'`, so unprobed rows carry `techSource = null`. | `media-scanner.service.ts:46-76,211-222` | **S1** |
| G8 | **A rescan overwrites measured tech with filename guesses** (`update: { ...tech }`) and the row is then never re-probed (`probedAt` non-null excludes it from the backfill working set). **A policy could delete on a guess that clobbered a measurement.** | `media-scanner.service.ts:211-222`; `media-probe-backfill.service.ts:82-90` | **S1** |
| G9 | **No protection registry.** No `protected` flag, no path-prefix exclusion table, no legal hold. | schema-wide | **S2** |
| G10 | **`MediaItem.locked` is NOT checked by the duplicate cleanup path** — detection and resolution never filter it. A locked item's file can be trashed today. | `duplicate-resolution.service.ts`, `media-duplicate.service.ts` | **S1** |
| G11 | **No "is this item busy?" helper.** `PlatformJob.mediaItemId` exists but nothing queries by it; `MediaProcessingJob` is effectively dead (2 references). No `isScanning` flag on a library. | `platform-jobs-query.service.ts`; `media-processing-queue.service.ts:100-106` | **S2** |
| G12 | **`TrashService.restore()` validates through the *browse* safety, not `storageSafety`.** A file trashed by system-scope cleanup from a library outside the narrowed browse root **cannot be restored**. | `trash.service.ts:244-276` | **S1** |
| G13 | **No library-wide last-copy guard.** The existing survivor check is scoped to one duplicate group's stored plan. | `duplicate-resolution.service.ts:498-512` | **S2** |
| G14 | **No ambiguity field.** Only a numeric `confidence`; no `ambiguous` marker to exclude on. | `schema.prisma:735-736` | **S2** |
| G15 | **No tag model.** Tags live as `MediaMetadata.tags Json`; there is no `MediaTag` table to protect or filter by efficiently. | `schema.prisma:858` | **S3** |
| G16 | **No season/episode entities.** Episodes are `MediaItem` rows; "protect a season" must be expressed as a query, not an FK. | `schema.prisma:710` | **S3** |
| G17 | Resolution ladder lacks `576p`/`1440p`/`4320p`; label set is `2160p|1080p|720p|480p|sd` (lowercase). Five *other* ladders exist for other purposes. | `media-probe.service.ts:54-63` | **S3** |
| G18 | `MediaLibrary` has no free-space/utilisation source; storage-pressure triggers need one. | `schema.prisma:637-660` | **S2** |

### The three that must be fixed *before* any technical condition may delete
**G7, G8, G10.** Until provenance is written, measurements survive a rescan, and `locked` is honoured, a
technical or lock-based policy cannot be trusted to make a destructive decision. These are pre-existing
defects in shipped code; this module surfaces them but does not cause them. They are Phase 3 / Phase 6 work
and are called out in the risk register (§18).

---

## 4. Module boundary

A **new NestJS module** `LibraryCleanupModule` under `apps/backend/src/modules/media/cleanup/`, mounted at
`/api/media/cleanup`. Rationale: it is a Media Manager subsystem (brief), but `MediaModule` is already 50+
providers and `@Global`; adding ~12 more providers to it worsens an existing problem. A sibling module that
`imports: [MediaModule, FilesModule, JobsModule-global]` keeps the boundary explicit and testable.

**Required upstream change:** `MediaModule` currently does **not** export `MediaProbeService`,
`DuplicateResolutionService`, `MediaShowDuplicateService`, or `MetadataProviderRegistry` (`@Global` only
globalises the `exports` list). Cleanup needs `MediaProbeService` (re-probe on demand) and the duplicate
identity/recommendation helpers — the latter two are **pure functions** (`duplicateKeys`,
`recommend`) and can be imported directly without DI. So the only export addition needed is
`MediaProbeService`.

---

## 5. Data model (proposed)

Nine tables, all additive. Names follow repo convention (`Media*` + snake_case `@@map`).

```
MediaCleanupPolicy          ── immutable-version parent (mirrors Workflow)
MediaCleanupPolicyVersion   ── frozen document + checksum + versionNumber
MediaCleanupRun             ── one execution of one pinned version (jobId → Jobs Center)
MediaCleanupCandidate       ── per-file evaluation result + reason snapshot + fingerprint
MediaCleanupPlan            ── persisted, approvable, executable-once selection
MediaCleanupAction          ── per-file journal, written BEFORE the fs step
MediaCleanupProtection      ── the protection registry (revocable, never hard-deleted)
MediaCleanupQuarantineItem  ── quarantined file + restore deadline + fingerprint
MediaPlaybackAggregate      ── per-MediaItem normalized playback facts (fills G1–G4)
```

Status vocabularies are **String columns with a documented value list**, matching repo convention
(`MediaItem.matchStatus`, `PlatformJob.status`, `WorkflowExecution.status` are all strings) and enforced in
code by a state machine like `domain/workflow-status.ts`. The brief's candidate states map 1:1.

`MediaCleanupProtection` follows the brief's shape, with the repo's identity discipline: **id is
authoritative, `canonicalPathSnapshot` is audit-only**. Revocation sets `revokedAt`; rows are never deleted.

---

## 6. Resolution classification — decision

**The brief's headline example is already correct today.** `resolutionFromHeight(h, w)` tests
`h >= 850 || w >= 1800` for 1080p, so a 1920×800 cinema encode classifies as **1080p** via its width. No
naïve `height < 1080` comparison exists to fix.

**Decision:** extend the existing function in place rather than add a second classifier — add `576p`,
`1440p`, `4320p`, return a typed union, and expose an **ordinal** for `lt`/`gt` comparison (the brief's
`resolutionClass < 1080p` needs an ordering, which no current ladder exposes to a policy). The five other
ladders (`RES_RANK`, `quality-compare`, `acquisition-match-preference`, `torrent-name-parser`,
`media-server-report.normalizeResolution`) stay untouched — they serve acquisition/reporting and normalising
them is out of scope and would risk regressions.

**Safety rule:** a policy comparing `resolutionClass` must require `techSource='probe'` unless it explicitly
opts into inferred values, because a filename-derived `resolution` may be a guess that overwrote a
measurement (G8).

---

## 7. Measured vs inferred technical data — decision

Provenance already exists conceptually (`techSource`), but is unreliable (G7/G8). Plan:

1. Add the six missing columns (G6) and parse them from mediainfo (`BitDepth`, `ChromaSubsampling`,
   `colour_primaries`, `transfer_characteristics`, `matrix_coefficients`, full `HDR_Format`).
2. Write `techSource:'filename'` in the scanner (G7).
3. Stop the scanner clobbering measured values: when `probedAt != null`, the scanner must not overwrite
   probe-owned fields (G8).
4. A condition definition carries `requiresMeasuredData`. When true and the row is not `techSource:'probe'`,
   the candidate is **excluded** as `excluded_unmeasured` — never matched.
5. Filename hints (`10bit`, `Hi10P`) may be **surfaced** in the UI as an inferred hint and may drive a
   report-only policy, but never an automatic destructive one unless the policy explicitly opts in.

---

## 8. Playback semantics — decision (the largest build)

`MediaPlaybackAggregate` is **net-new required infrastructure**, keyed to `mediaItemId` (FK, cascade).

- **Source rows:** `MediaServerWatchHistory` (one row per completed play, has `percentComplete`,
  `watchedSeconds`) is the counting source. `MediaUserWatch` supplies *boolean* watched state per
  UltraTorrent user (it cannot count — G3). Trakt state rides `MediaUserWatch`.
- **Identity resolution (the hard part):** history rows carry only a display title. Reuse the existing
  `resolveIdentityFromTitle` discipline from `trakt-sync.service.ts:709` — which **returns null rather than
  guessing** on ambiguous strings. Unresolvable history contributes to *nothing*; an item whose aggregate is
  built from unresolved data is marked stale and excluded (`excluded_unmeasured`).
- **Completion threshold:** configurable, **default 90%** per the brief, but the repo constant is 80%
  (Trakt's). Decision: introduce `cleanup.completionThresholdPercent` defaulting to **90**, and *document*
  that it is intentionally stricter than the Trakt scrobble threshold, which stays 80 for Trakt parity. They
  are different questions ("did Trakt consider it watched" vs "is it safe to delete").
- **Heartbeat dedup:** counting is over *history* rows (written once at session end), not session
  heartbeats, so repeated 15 s polls cannot inflate counts. One session ⇒ at most one started and one
  completed play, enforced by `@@unique([importSourceId, providerHistoryId])` upstream plus a per-session
  guard.
- **"Never watched" default:** `completedPlayCount = 0 AND maximumProgressPercent < threshold`. A policy
  option may treat any start as watched.
- **Staleness:** aggregates carry `updatedAt` + `sourceRowCount`; a policy declares a tolerance and an item
  whose aggregate is older/mismatched is excluded, never assumed unwatched. **Absence of data must never
  read as "never watched"** — this is the single most dangerous failure mode in the feature.
- **UI wording:** "Completed plays less than 100", never "Plays less than 100".

---

## 9. Candidate lifecycle & mandatory exclusions

```
discovered → candidate → (pending_approval → approved) → quarantined|trashed → retention_pending → purged
                     ↘ excluded_* | rejected | expired | cancelled | skipped_changed | failed → restored
```

Exclusions are evaluated **server-side** and are absolute for automation: protected, locked (G10),
outside hard roots, symlink escape, system dir, active playback session (G5), incomplete download, in-flight
move/rename/copy/scan/probe, active media-processing job (G11), unresolved duplicate-resolution plan, inside
the grace period, ambiguous identity when identity conditions are used (G14), missing measured data when
required, stale playback aggregate, the final surviving copy, newly protected after candidate creation, and
any fingerprint drift.

---

## 10. Plans, fingerprints, and the execution contract

- Execution endpoints accept **`cleanupPlanId` only**. Never `paths[]`, never `mediaFileIds[]`.
- Plan pins: policy version id, candidate ids, **and each candidate's fingerprint**.
- Fingerprint = sha256 over `mediaFileId | canonical path | size | mtime | identity keys | policyVersionId |
  relevant technical facts | relevant playback aggregate | protection state | replacement state`. Only
  policy-relevant facts are included, so unrelated churn does not invalidate a plan.
- **Protection is re-checked three times**: at evaluation, at plan creation, and immediately before the fs
  step. The third is mandatory (race prevention).
- Fingerprint drift ⇒ `skipped_changed` with the specific differing field recorded. Never delete.
- A plan is immutable after approval, executable once, and expires.
- Every action row is journalled `running` **before** the fs call, mirroring
  `duplicate-resolution.service.ts:534-542`.

---

## 11. Removal, quarantine, restore

**Exact call** (corrected against the tree — the brief's illustrative signature does not match this repo):

```ts
await this.files.remove(
  { path: this.filePath.storageSafety.toRelative(absPath), permanent: false },
  ctx,                       // { userId, ipAddress, userAgent }
  'storage',                 // PathScope
);
```

`DeleteFileDto.path` is **root-relative**; `remove` takes three positional args, not an options bag.

**Quarantine** is a move inside the hard roots to a reserved directory, collision-safe (UUID-prefixed like
`TrashService`), journalled, with the original path + fingerprint + restore deadline preserved. It is not
deletion; a newly-protected quarantined item is exempt from purge.

**Restore** must fix G12 — the restore path has to validate through `storageSafety` for system-scope items,
or cleanup-trashed files become unrestorable. This is a change to `TrashService.restore` (add a scope
parameter defaulting to `'browse'` so existing callers are unaffected).

---

## 12. Replacement-aware cleanup

Reuse `duplicateKeys()` for "same media" and `recommend()`'s tiers for "equal or better". Requirements are
policy-declared (resolution class ≥, codec preference, audio channels ≥, HDR ≥, required subtitle languages
present, probe succeeded, readable, not protected, not itself pending cleanup, not actively playing).
`heightsFor()`'s mixed-evidence refusal applies: if the candidate is measured and the replacement is not,
resolution is **not** comparable and the replacement does not qualify. Never delete the final surviving copy
— and unlike the duplicate path's plan-scoped survivor check (G13), this guard is **library-wide over the
identity key**.

---

## 13. Storage pressure

Trigger on free-space threshold, stop at a recovery target, with hard caps (max bytes, max items, max
runtime, min grace period) and a circuit breaker on error rate. Ranking must be **explainable** — a weighted,
inspectable score (reclaimable bytes, last-play age, completed plays, quality obsolescence, replacement
confidence, added date, size), never an opaque model. G18: free space needs a `statfs`-backed reading of the
library root through `storageSafety`.

---

## 14. RBAC

The brief's `library_cleanup.*` block, added to the shared catalog. Seeding: `SUPER_ADMIN` keeps its
short-circuit; `ADMINISTRATOR` inherits via `ALL_PERMISSIONS` **except** — decision needed (§17 D-5) —
whether `permanent_delete` and `legal_hold` should be excluded from the blanket admin grant. Ordinary users
get nothing destructive; POWER_USER may get `view`/`simulate` only. Runtime jobs re-check permissions at
dispatch (the Workflow Builder's least-privilege pattern), failing closed.

---

## 15. Navigation, i18n, notifications

Nav entries under the **Media** workspace via `NAV_CONTRIBUTIONS` (Cleanup Center, Policies, Candidates,
Protected Content, Quarantine, History), permission- and module-filtered. New i18n namespace `cleanup` in
en-US **and** es-PR, registered in `i18n/index.ts` + `i18next.d.ts`, passing the parity test. Notification
events seeded conservatively (failures/approvals/imminent expiry on; routine completions off) with dedupe
keys. Labels must not collide with the File Manager's existing "Cleanup" wizard.

---

## 16. Performance

Narrow `select`s, paged evaluation (5,000-row pages as duplicate detection uses), batched writes in
`$transaction` arrays, composite indexes on `(runId, status)`, `(policyVersionId, status)`,
`(protectedUntil)`, `(status, expiresAt)`. A **policy-scoped input digest** mirrors
`inputDigest()` — one Postgres `md5(string_agg(...))` over only the facts that policy version reads, taken
before rows load, stored only after a finished run. **It must include protection, playback, replacement and
technical facts**, or a protection added since the last run would be skipped. No transaction spans a
filesystem mutation.

---

## 17. Decisions — RESOLVED 2026-07-22

- **D-1 — Playback identity resolution → conservative match.** Build the aggregate on the existing
  `resolveIdentityFromTitle` discipline (`trakt-sync.service.ts:709`), which returns **null rather than
  guessing** on ambiguous strings. Unresolved history contributes to nothing, and an item whose aggregate
  cannot be resolved is **stale, never "never watched"**. Adding a `mediaItemId` FK to
  `MediaServerWatchHistory` is deferred as a possible follow-up, not a prerequisite.
- **D-2 — Completion threshold → new setting, default 90.** `cleanup.completionThresholdPercent = 90`.
  Trakt's `WATCHED_THRESHOLD_PCT = 80` is left untouched: "did Trakt consider it watched" and "is it safe to
  delete this" are different questions, and the destructive one takes the stricter bar.
- **D-3 — Fix G7/G8/G10/G12 → yes, all four.** They are prerequisites for a trustworthy technical- or
  lock-aware policy, and the fixes also repair the existing duplicate-cleanup path (`locked`) and the Trash
  restore path. Scheduled: G7/G8 in Phase 3, G10 in Phase 6, G12 in Phase 8.
- **D-4 — Approval mechanism → cleanup-native.** A plan-scoped approval object, not `WorkflowApproval`
  (which is bound to a `WorkflowExecution`). A workflow node may still request cleanup approval by
  referencing a `cleanupPlanId`.
- **D-5 — Admin blanket grant → exclude the two high-risk permissions.** `library_cleanup.permanent_delete`
  and `library_cleanup.protection.legal_hold` are excluded from `ADMINISTRATOR`'s `ALL_PERMISSIONS`
  inheritance, which changes the role-seeding shape from a single `SYSTEM_MANAGE` filter to an exclusion set.
  They must be granted deliberately.
- **D-6 — "Protect a season" → stored as `(showId, seasonNumber)`** and resolved by query, since no season
  entity exists (G16).

---

## 18. Risk register

| Risk | Mitigation |
|---|---|
| **Absence of playback data read as "never watched"** — would delete unwatched-*looking* but simply unmeasured media | Stale/unresolved aggregates are an **exclusion**, never a match. Explicit `excluded_unmeasured` state. |
| Filename guess overwrote a measurement (G8) and drives a delete | Fix G8 first; require `techSource='probe'` for destructive technical conditions. |
| Locked item deleted (G10) | Add `locked` as a mandatory exclusion here **and** fix the duplicate path. |
| Cleanup-trashed file unrestorable (G12) | Scope-aware `TrashService.restore`. |
| Race: protection added mid-execution | Third protection check immediately before the fs step + queued-action invalidation. |
| Scope creep into the File Manager cleanup wizard | Distinct module, distinct labels, no shared categories. |
| Feature size | 10 gated phases, each independently buildable/testable (below). |

---

## 19. Implementation phases

Each phase ends green: backend tsc · frontend `tsc` (enforces `noUnusedLocals`) · backend unit tests ·
i18n parity · prisma validate · BE+FE builds · **Nest boot verify** · docs · changeset.

1. **This document** — review, gap analysis, design, sign-off.
2. **Data model & permissions** — 9 tables, migration, shared types, `library_cleanup.*`, role seeding, module manifest.
3. **Technical & playback facts** — 6 probe columns + mediainfo parsing; fix G7/G8; extend the resolution ladder + ordinal; `MediaPlaybackAggregate` + identity resolution + completion semantics + backfill.
4. **Protection Registry** — service, stable-identity matching, permanent/temporary/conditional/legal hold, bulk API, expiry sweep, UI, audit, race tests.
5. **Policy engine** — immutable versions, condition catalog, validation, nested ALL/ANY via the reused evaluator, simulation, human-readable explanations, seed templates (disabled).
6. **Candidate discovery** — scan job, snapshots, fingerprints, mandatory exclusions (incl. G10), replacement checks, ranking, progress events, dashboard.
7. **Plans & approvals** — plan creation, immutability, approve/reject/expire, runtime permission re-checks, audit, notifications.
8. **Quarantine, Trash, restore** — storage-scope removal, quarantine move, restore (incl. G12 fix), retention, collision safety, journaling, rescan/server refresh.
9. **Scheduling & storage pressure** — scheduled runs, free-space trigger (G18), recovery target, caps, circuit breaker.
10. **Jobs/Automation/Workflow, security, docs, regression** — parent/child jobs, non-destructive automation actions, plan-only destructive workflow node, `LIBRARY_CLEANUP.md` + `LIBRARY_CLEANUP_SECURITY.md` (25-threat model), performance pass, full regression, ARCHITECTURE change-log row.

---

## 20. Sign-off gate — CLEARED 2026-07-22

D-1 … D-6 resolved (§17). **G7, G8, G10, G12** are accepted as in-scope fixes. Phase 2 may proceed.
