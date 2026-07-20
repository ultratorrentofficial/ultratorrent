# Duplicate Media — Implementation Review & Redesign Plan

**Status:** Phase 1 (review) complete. No production code changed by this document.
**Date:** 2026-07-19
**Scope:** `MediaDuplicateService`, `MediaShowDuplicateService`, their controllers, Prisma
models, the `/media/duplicates` page, and every integration point named in the redesign brief.

This review separates, as instructed, **detection correctness**, **data-model**, **API**,
**performance**, **presentation**, and **workflow** problems. Findings are evidence-based:
where a claim is measurable it was measured against the two live deployments (`synoplex`,
`ehr-qnap`) rather than inferred from code.

---

## 0. Executive summary — read this first

Three findings should change the redesign plan before any UI work begins.

### 0.1 On one live host, 99.3% of duplicate groups are phantoms

`ehr-qnap` reports 145 duplicate groups. Of the 140 that have members:

| | groups |
|---|---|
| All members share the **same path** (not duplicates at all) | **139** |
| Members have genuinely distinct paths | 1 |

The cause is not the detector. `media_items` on that host contains **139 paths with two rows
each** (139 surplus rows). The two rows are the same file in the same library, created three
seconds apart:

```
path      /downloads/Movies/HD Movies/Hotel Mumbai (2019)/Hotel Mumbai (2019) [1080p].mp4
id        e40cbf70…   createdAt 2026-07-05 00:18:31.129
id        c35eb7e4…   createdAt 2026-07-05 00:18:34.198
```

The detector then correctly observes that two `MediaItem` rows share a title and year, and
groups them. It is behaving as designed on corrupt input.

`synoplex` is the control: **0 duplicate-path rows**, and 107 of 112 populated groups have
genuinely distinct paths. So this is a host-specific data-integrity failure, not a universal
one — but nothing in the schema prevents it. `MediaItem` has **no unique constraint on
`(libraryId, path)`** (`schema.prisma:710-761`; indexes are on `libraryId`, `mediaType`,
`title`, `year`, `matchStatus`, `seriesImdbId`, `duplicateGroupId` only).

**Implication for the redesign:** a Duplicate Center built on this data would confidently
present 139 groups, recommend a winner in each, compute "reclaimable storage" from a file
counted twice, and offer to trash the copy — where "the copy" is *the same inode as the
keeper*. Quick Clean over this dataset is the single most dangerous thing this project could
ship. **Deduplicating `MediaItem` rows and adding the unique constraint is a prerequisite,
not a follow-up.**

### 0.2 Duplicate *files* have no resolution path at all — the feature cannot act

The brief assumes an existing cleanup workflow that is "cumbersome". For duplicate **files**
there is no workflow to improve: there is no resolve, delete, trash, ignore, or dismiss
endpoint. The frontend's keep/remove selection is React `useState`, with an explicit comment:

```tsx
// Client-side keep/remove marking (no destructive backend action exists).
```
— `MediaDuplicatesPage.tsx:123`

and a user-facing footnote telling the operator to go and do it by hand somewhere else:

> "Selecting a keeper marks the rest as removal candidates. Remove files from disk via the
> rename engine or your media server."

Only the **show-folder merge** actually mutates anything. So the work is closer to a
greenfield build than a refactor, and the estimate in §9 reflects that.

### 0.3 Every scan destroys all prior human decisions

`detect()` wipes the world before rebuilding it (`media-duplicate.service.ts:194-199`):

```ts
// Reset prior grouping.
await this.prisma.mediaItem.updateMany({
  where: { duplicateGroupId: { not: null } },
  data: { duplicateGroupId: null },
});
await this.prisma.mediaDuplicateGroup.deleteMany({});
```

Group IDs are not stable across runs. This makes the brief's persistent-ignore requirement
**impossible on the current model** — there is nothing durable to attach an ignore to. It also
explains the orphaned rows observed live (5 empty groups on `ehr-qnap`, 15 on `synoplex`):
`deleteMany` + per-group `create` runs outside a transaction, so an interrupted run strands
group rows with no members.

---

## 1. Current architecture

Two independent services with no shared model, no shared vocabulary, and different maturity.

| | `MediaDuplicateService` | `MediaShowDuplicateService` |
|---|---|---|
| File | `media-duplicate.service.ts` (270 lines) | `media-show-duplicate.service.ts` (433 lines) |
| Unit | `MediaItem` (a file) | `MediaShow` (a folder) |
| Deps | `PrismaService` only | Prisma, `FilePathService`, `FilesService`, `AuditService` |
| Persists | `MediaDuplicateGroup` rows | nothing — computed per request |
| Can mutate the filesystem | **no** | yes (move, trash, delete) |
| Safety controls | none (nothing to protect) | extensive — see §5 |
| Tests | 87 lines, pure functions only | 292 lines, real temp dirs |
| Background execution | no | detection only, inside library scan |

They are presented on one page but share nothing — not a reason vocabulary, not a confidence
notion, not a group identity.

### Detection keying — items (`duplicateKeys`, `media-duplicate.service.ts:75-121`)

Each item emits several keys; equal keys bucket together. Reason priority resolves overlap:
`external_id (0) → show_season_episode (1) → title_year (2) → similar_filename (3)`, greedy
single-assignment (`detectDuplicateGroups:139-165`).

```ts
// external id — strong for MOVIES. For TV it is unreliable: providers store
// series-level ids on episode rows … so for non-movies we scope the external-id
// key by the show title AND the episode number
const scope = isMovie ? '' : `:${normTitle}${epMarker}`;
keys.push({ reason: 'external_id', key: `external_id:${ext.provider}:${ext.externalId}${scope}` });
```

This scoping is **correct and must be preserved** — it is what stops one contaminated
series-level ID collapsing an entire show into a single group.

Similarly, `title_year` only fires when season and episode are both null, and
`similar_filename` carries an episode-or-year discriminator so *Aladdin (1992)* and
*Aladdin (2019)* cannot merge. Both are load-bearing.

### Detection keying — show folders (`media-show-duplicate.service.ts:143-154`)

```ts
const yearsCompatible = (a, b) => a == null || b == null || a === b;
const sameName = a.canonicalKey === b.canonicalKey && yearsCompatible(a.year, b.year);
const sameId   = !!a.imdbId && a.imdbId === b.imdbId;
if (sameName || sameId) union(a.id, b.id);
```

Equality-based canonical matching (never substring), same-library only, union-find. An
id-only match sets `needsReview: !namesAgree` (`:183-196`). Also correct and load-bearing.

---

## 2. Current user journey

1. Sidebar → **Media Management → Duplicates** (`navigation.ts:201`).
2. Page fires two unrelated queries; two unrelated sections stack vertically.
3. **Show folders** (top): family cards, radio-select the canonical path, **"Preview merge"** →
   modal **"Review the merge"** listing moves / collisions / deletions → **"Merge and delete"**.
   This flow is genuinely good: it previews, it blocks, it explains.
4. **Duplicate files** (below): a 7-column table per group. **"Keep this"** flips a star.
   Nothing is saved. Nothing is deleted. Changing page discards the selection.

The two halves teach contradictory lessons: the top half is a careful destructive workflow;
the bottom half is a decision surface with no consequence.

---

## 3. Current API contracts

All under `@Controller('media')`, `JwtAuthGuard + PermissionsGuard`.

| Method | Path | Permission | DTO validation | Pagination |
|---|---|---|---|---|
| GET | `/media/duplicates` | `media_manager.view` | raw query strings | yes (`parsePage`, cap 200) |
| POST | `/media/duplicates/detect` | `media_manager.view` | no body | returns page 1 |
| GET | `/media/shows/duplicates` | `media_manager.view` | raw query string | **none** — full array |
| POST | `/media/shows/duplicates/preview` | `media_manager.view` | **none** | n/a |
| POST | `/media/shows/duplicates/merge` | `media_manager.rename` + `media_manager.delete` | **none** | n/a |

Two defects:

- **`POST /duplicates/detect` mutates behind a read-only permission.** It runs
  `deleteMany({})` across all groups but is gated by `MEDIA_MANAGER_VIEW`. Any viewer can
  destroy all grouping state and trigger a full-table scan.
- **The destructive merge endpoint is unvalidated.** Endpoints 4 and 5 type the body with an
  inline TS type, not a DTO class. The global `ValidationPipe`
  (`bootstrap.ts:84-90`, `whitelist/forbidNonWhitelisted/transform`) cannot act on a
  non-class type, so it is a no-op. Shape enforcement happens incidentally inside
  `loadShows`.

Frontend client exposes exactly five methods (`api.ts:3138-3160`).

---

## 4. Current database models

```prisma
model MediaDuplicateGroup {      // schema.prisma:959-966
  id        String   @id @default(uuid())
  reason    String   // title_year | show_season_episode | external_id | file_hash | similar_filename
  createdAt DateTime @default(now())
  items     MediaItem[]
  @@map("media_duplicate_groups")
}
```

Three columns. No indexes beyond the PK. No `libraryId`, `status`, `confidence`,
`requiresReview`, `resolvedAt`, `ignoredAt`, `updatedAt`, `potentialSavingsBytes`,
`recommendedKeepFileId`, `scanJobId`, or `version`. No stable identity key, so nothing can be
correlated across runs.

`MediaItem.duplicateGroup` (`:747`) declares no `onDelete`, so it defaults to `SetNull`.

The schema comment advertises a `file_hash` reason that **nothing ever produces** — there is
no hashing anywhere in the duplicate path.

Everything the brief's proposed model needs (`MediaDuplicateCandidate`,
`MediaDuplicateResolution`, `MediaDuplicateResolutionAction`) is absent.

---

## 5. Existing safety controls — preserve all of these

These live in the **merge** path and are, on the whole, well built. The redesign must inherit
them rather than reimplement them.

| Control | Location | Note |
|---|---|---|
| Path confinement | `preview:213-218` → `assertWithinHardRoots` (`file-path.service.ts:110-124`) | rejects system dirs and anything outside `FILE_MANAGER_ROOTS` |
| Library-root protection | `preview:220-223` | refuses to delete a library root |
| Self-merge refusal | `preview:224-226` | |
| Blocker enforcement | `merge:295-297` | throws if any blocker exists |
| Trash-first | `merge:299-305` | collision losers trashed **before** winners move in |
| Non-empty folder guard | `merge:314-327` | re-walks the dir; skips deletion if any video remains |
| Watchlist repointing | `merge:330-338` | repoints **before** row deletion, defeating `ON DELETE SET NULL` |
| Audit logging | `merge:340-355` | `media.shows.merged` + `file.deleted` from `FilesService` |
| RBAC on the destructive route | `media.controller.ts:473` | requires `rename` **and** `delete` |
| Argument sanity | `loadShows:367-377` | empty list, canonical-in-duplicates, cross-library all throw |
| Movie year separation | `duplicateKeys:104-118` | `title_year` + year discriminator on `similar_filename` |
| Episode identity | `duplicateKeys:99-103`, `episodeMarker:41-47` | structured columns first, regex fallback |
| External-ID scoping | `duplicateKeys:88-93` | series-level IDs cannot collapse episodes |
| Compatible-year check | `detect:143` | |
| Review requirement | `detect:183-196` | id-only match ⇒ `needsReview` |
| Preview-before-change | `preview` / `MergePreviewDialog` | |

### Gaps in the otherwise-good merge path

- **No transaction, no rollback.** Files move → folders delete → rows delete. A mid-way
  failure leaves disk and DB divergent with no compensation.
- **TOCTOU.** `merge` does not receive the approved plan; it **recomputes** it (`:294`). If
  disk changed between preview and confirm, the operator approved a different plan than the
  one that runs.
- **No idempotency key, no concurrency lock.** Two operators can merge the same family
  concurrently.

---

## 6. Problems, classified

### 6.1 Detection correctness
- **D1 (critical).** Detection trusts `MediaItem` uniqueness that the schema does not enforce
  → 139 phantom groups on a live host (§0.1). *This is a data-integrity bug surfacing as a
  detection bug.*
- **D2.** No hash, size, runtime, or fingerprint signal is used for grouping at all — despite
  `file_hash` appearing in the schema comment. Two different films sharing title+year group;
  two byte-identical files with different titles do not.
- **D3.** `similar_filename` is keyed on the **DB title**, not the filename, so it is not a
  filename signal and adds nothing beyond `title_year`.
- **D4.** No edition/cut awareness. Director's Cut and Theatrical group as one.
- **D5.** Detection has no notion of confidence — reason priority is used as a proxy, and a
  reason is not a safety judgement.

### 6.2 Data model
- **M1 (critical).** No durable group identity ⇒ persistent ignore is impossible (§0.3).
- **M2.** No status lifecycle (open/ignored/resolved), no reviewer, no timestamps.
- **M3.** No savings accounting, so neither potential nor actual reclaim can be shown.
- **M4.** No candidate-level row, so per-file selection, rank, and reasons have nowhere to live.
- **M5.** No resolution/action journal ⇒ the brief's compensating-recovery requirement cannot
  be met.
- **M6.** Missing unique constraint on `MediaItem(libraryId, path)`; missing indexes for every
  filter the brief requires.

### 6.3 API
- **A1 (security).** Destructive reset behind `MEDIA_MANAGER_VIEW`.
- **A2 (security).** Destructive merge accepts unvalidated body.
- **A3.** `GET /media/shows/duplicates` is unpaginated and unbounded.
- **A4.** No preview/resolve/ignore/bulk endpoints for files.
- **A5.** `detect` returns page 1 of results, conflating a command with a query.

### 6.4 Performance
- **P1.** `detect()` loads **every** `MediaItem` with `externalIds` and `files` — no filter, no
  batching, no streaming.
- **P2.** It runs **synchronously in the HTTP request**. No job, no progress, no cancellation.
  (`MediaJobType` has no duplicate type at all.)
- **P3.** Group creation is a per-group `create` + `updateMany` loop — N+1 writes, untransacted.
- **P4.** Show detection is **O(n²)** over shows and calls `videoFilesIn` (recursive
  `readdir` + `stat` per file) for every member of every family.
- **P5.** `MediaDuplicateGroup` has no indexes for any listing or filtering path.

### 6.5 Presentation
- **X1.** No comparison view — a flat 7-column table; the operator diffs by eye.
- **X2.** No poster/artwork anywhere on the page.
- **X3.** `qualityScore` is computed, returned over the wire, and **never rendered**.
- **X4.** No confidence, and no explanation of why a group exists beyond a bare reason badge.
- **X5.** No storage savings, per group or aggregate.
- **X6.** No technical metadata beyond best-resolution/best-codec — no bitrate, audio, HDR,
  runtime, container, dates.
- **X7.** `libraryId` and `createdAt` are fetched and unrendered.
- **X8.** No filter, no sort, no search. Pagination on files only; show folders unbounded.
- **X9.** No frontend tests exist for either component.

### 6.6 Workflow
- **W1 (critical).** Files: detection with no resolution (§0.2).
- **W2.** Selection is ephemeral React state, lost on paging.
- **W3.** No ignore / not-a-duplicate / reopen anywhere.
- **W4.** No bulk anything.
- **W5.** No trash/recovery surface scoped to duplicate cleanup.
- **W6.** Dead event: `NOTIFICATION_EVENTS.MEDIA_DUPLICATE` is defined (`events.ts:109`) and
  seeded as an enabled rule (`seed.service.ts:59`) but **never emitted** — a rule that can
  never fire.
- **W7.** No WebSocket events for duplicates at all.

### 6.7 Terminology
"Duplicates", "Detect duplicates", "Keep this", "Remove", "Merge and delete", "Needs review",
"families", "groups", "members", "candidates" are used inconsistently across UI, services, and
docs. `reason` doubles as both a detection signal and an implied confidence.

---

## 7. Documentation state

| File | Duplicate coverage |
|---|---|
| `docs/MEDIA_MANAGER.md` | permission row, two endpoints, model row, four reasons, one route line. **No mention of show-folder merge.** |
| `docs/API.md` | lists 2 of the 5 endpoints. The three show-merge endpoints are undocumented. |
| `docs/NAVIGATION.md` / `docs/MODULES.md` | one line each |
| `docs/ARCHITECTURE.md` (**authoritative**) | **no** show-folder section at all; carries `MediaProbeService` material the root lacks |
| `ARCHITECTURE.md` (root) | full show-folder bullet (`:246-258`) — but **gitignored** (`.gitignore:60`), local-only, never in the repo |

**Resolved:** `docs/ARCHITECTURE.md` is the authoritative file (confirmed by the maintainer,
2026-07-20). The root copy is deliberately gitignored and ships to nobody, which is how the two
drifted apart unnoticed.

The consequence for this feature is concrete: **the duplicate show-folder merge — a destructive
workflow that moves files and deletes folders — is entirely undocumented in the authoritative
architecture reference** (`grep -ci "duplicate show" docs/ARCHITECTURE.md` → 0). It was written
up only in the local, ignored copy. That gap is closed as part of this work.

The two files have diverged in **both** directions, so neither is a superset:

| Changelog entry | in `docs/` (authoritative) | in root (ignored) |
|---|---|---|
| 2026-07-13 duplicate show folders (×2) | ✗ | ✓ |
| 2026-07-14 Trakt / scrobbling | ✓ | ✓ |
| 2026-07-15 subtitle settings | ✓ | ✗ |
| 2026-07-17 newsletter recipients, IMDb resolver | ✗ | ✓ |
| 2026-07-18 scan enriches | ✗ | ✓ |

---

## 8. Recommended redesign

Retain the show-folder merge design as the template — it already embodies preview-blockers-
trash-first-audit. Raise the file flow to the same standard, then unify the presentation.

**Model.** Add durable identity: a `groupKey` (stable hash of the detection key) so a group
survives rescans and an ignore can bind to it. Add the lifecycle, savings, candidate and
resolution/action tables from the brief — but only after D1 is fixed, because savings computed
over phantom rows are worse than no savings at all.

**Detection.** Keep every existing guard verbatim. Add size and hash as *grouping* signals
(not just display), computed incrementally and cached against `(size, mtime)`. Separate the
three concepts the current code conflates: **signal** (why we noticed), **confidence** (how
sure), **safety** (is auto-cleanup permissible). A group may be high-signal and unsafe.

**Execution.** Pass the previewed plan token to `resolve`; revalidate identity, size/hash,
roots, and group version at execution; write an action journal before touching disk so a
partial failure is recoverable.

**Presentation.** One Duplicate Center, default **Needs Review**, with the ten group types
distinguished but not merged into one undifferentiated list.

---

## 9. Phasing and honest estimate

The brief's seven phases are correct in sequence. Their size is not one work session.

| Phase | Content | Rough size |
|---|---|---|
| **0 (new, blocking)** | Fix D1: dedupe `MediaItem` rows, add `@@unique([libraryId, path])`, fix the scanner race. Fix A1, A2. | small, high value |
| 1 | This review + unified domain model + migration | medium |
| 2 | Overview, filters/sort/search, group cards, comparison | large |
| 3 | Recommendation engine, preview, single-group resolve, trash | large |
| 4 | Quick Clean, bulk, partial-result handling | medium |
| 5 | Show-folder guided workflow on the new model | medium |
| 6 | Incremental scan, scheduling, indexes, metrics | medium |
| 7 | Automation, notifications, docs, full test coverage | medium |

**Phase 0 is not optional and not deferrable.** Shipping any cleanup UI over the current
`ehr-qnap` dataset would offer to delete files that are the keeper.

---

## 10. Decisions needed before implementation continues

1. ~~Which `ARCHITECTURE.md` is authoritative?~~ **Resolved: `docs/ARCHITECTURE.md`.** The
   duplicate show-folder content has been ported into it. Three unrelated entries (2026-07-17
   ×2, 2026-07-18) remain missing from the authoritative file and one (2026-07-15) from the
   root copy — reconciling those is outside the duplicates scope and awaits a decision.
2. ~~**Phase 0 authorisation.**~~ **Done** — see the 2026-07-20 changelog entry. 139 duplicated
   rows removed on the affected host, phantom groups 139 → 0, no artwork or NFO lost.
3. **Phase 0 authorisation (original text).** Deduplicating 139 `MediaItem` rows on `ehr-qnap` is a data
   migration on a live host. Proposed: delete the newer row of each same-path pair, keep the
   older (preserves `createdAt` history), then add the unique constraint. Reversible via a
   rescan.
3. **Scope of this engagement.** Deliver phases in sequence with review gates, or a narrower
   target (e.g. Phase 0 + 1 + a working single-group resolve) first?

---

## 11. Migration and compatibility plan

- `MediaDuplicateGroup` gains columns, all nullable or defaulted → additive, backward-compatible.
- `@@unique([libraryId, path])` on `MediaItem` **requires** the dedupe in Phase 0 to run first,
  in the same migration, or it will fail on `ehr-qnap`.
- Existing endpoints keep working; new endpoints live under `/api/media/duplicates/*` and the
  five current routes are preserved (`detect` re-pointed at the job queue, its permission
  corrected).
- The frontend page is replaced wholesale; the 61 existing i18n keys per locale are retained
  where wording survives, and parity is enforced by `i18n.test.ts:38`.
