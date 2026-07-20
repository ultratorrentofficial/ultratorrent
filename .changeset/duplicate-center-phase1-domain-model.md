---
"ultratorrent": minor
---

Duplicate Center Phase 1 — a durable domain model, and detection that no longer destroys human decisions.

**Groups now survive a rescan.** `detect()` ran `deleteMany({})` across every group before rebuilding, so a group's id changed on every run. That made the "this is not a duplicate" decision impossible to persist rather than merely missing — there was nothing durable to attach it to — and an interrupted run stranded member-less rows (5 orphans on one live host, 15 on another). `MediaDuplicateGroup` gains a unique `groupKey` derived from the detection signal itself, so the same real-world group keeps one identity across scans, and detection upserts on it. Groups detection no longer produces are dropped **only when `status = 'open'`**: an ignored group is retained precisely so the same false positive does not return, and a resolved one is retained as history.

**The model the rest of the redesign needs.** `MediaDuplicateGroup` gains `groupType`, `status`, `confidence`, `requiresReview`, `potentialSavingsBytes`, `recommendedItemId`, `recommendation`, `warnings`, `version`, and the ignored/resolved actor+timestamp pairs, with indexes for every filter the Duplicate Center will offer. Three new tables: `MediaDuplicateCandidate` (per-membership rank, reasons and chosen action, with `path`/`fileSize` snapshotted so a resolution stays auditable after the item row is gone), `MediaDuplicateResolution` (the server-generated preview persisted with the `groupVersion` it was built against, so a stale plan can be refused instead of applied to files the operator never approved), and `MediaDuplicateResolutionAction` (the execution journal — a database transaction cannot roll back a file that has already moved, so recovery needs a record written before each step).

`confidence` and `requiresReview` are deliberately separate fields: a group can be high-confidence and still unsafe to clean automatically (conflicting metadata, different editions). Detection signal, confidence, and cleanup safety are three different things.

Fully backward-compatible: every existing column is untouched, every new column is defaulted or nullable, `MediaItem.duplicateGroupId` is unchanged, and the existing list endpoint keeps working. Existing group rows are backfilled with a `legacy:<id>` key — unique by construction — which the first detection run replaces with real signal-derived keys. The migration was rehearsed against a copy of a live table (107 rows, 107 unique keys, no collisions).
