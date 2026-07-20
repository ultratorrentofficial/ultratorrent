---
"ultratorrent": minor
---

Duplicate Center Phase 3 (part 2) — server-generated cleanup previews and trash-first execution.

Duplicate **files** could be detected, scored and compared, but never acted on: the old page's keep/remove selection was React state with no backend behind it. `POST /api/media/duplicates/:groupId/preview` now builds and persists a plan, and `POST /api/media/duplicates/resolutions/:resolutionId/resolve` executes it. Redundant copies go to **Trash**, never `rm` — `FilesService.remove({ permanent: false })` writes a restorable `TrashItem`.

Three properties close defects recorded in the redesign review:

**The plan that executes is the plan that was approved.** The existing show-folder merge recomputes its plan at execute time, so if the disk changed between preview and confirm, the operator approved something other than what runs. Here the preview is persisted and read back at execution, pinned to the group `version` it was built against. Detection bumps that version on every re-detection, so a plan built against an older membership is refused outright with `stale_plan` rather than applied to files nobody reviewed.

**Every path is revalidated immediately before it is touched**, not merely at preview: hard-root confinement, library-root protection, existence, and file size. A preview is a statement about the past. A file whose size changed since the preview is **skipped, not trashed** — the operator approved removing a specific file, not whatever now occupies that path. A vanished file is skipped without failing the run. And if the copy being *kept* has disappeared, the whole resolution refuses, because trashing the redundant copies then would leave no copy at all.

**The journal is written before the filesystem is touched.** A database transaction cannot roll back a file that has already moved, so each `MediaDuplicateResolutionAction` row is created in `running` state before its step and updated to `completed`/`failed`/`skipped` after. A crash mid-operation leaves a row naming exactly what was in flight.

A review-required group has no recommendation by design, so previewing one requires an explicit `keepItemId`; the chosen id must belong to that group, or a caller could nominate an outsider and have every real member trashed. Partial outcomes report as `partial` and never mark the group resolved. Execution requires `media_manager.delete`; preview requires only `view`.

16 tests, almost all of them refusals — a cleanup that works is worth far less than one that declines to act when the world moved underneath it.
