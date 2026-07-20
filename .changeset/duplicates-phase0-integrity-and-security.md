---
"ultratorrent": patch
---

Phase 0 of the Duplicate Center work: fix the data-integrity bug that made duplicate detection unsafe, and close two security defects found in the same review.

**One row per file per library.** The scanner indexed a new file as a check-then-act pair — `findFirst({libraryId, path})` then `create()` — with nothing in the schema making it atomic, so two concurrent scans of one library both read "not present" and both inserted. A live host carried **139 duplicated `MediaItem` rows**, all created within 7 seconds of one another; the control host had zero. Each pair then appeared in the duplicate feature as a group whose two members were the *same file on disk* — 139 of that host's 140 populated groups — so a cleanup would have computed reclaimable space from a file counted twice and offered to trash the copy it was keeping. `MediaItem` gains `@@unique([libraryId, path])` and the scanner's insert becomes an `upsert` keyed on it.

**The migration dedupes before indexing**, keeping the row with the most artwork + NFO, ties to the oldest `createdAt` then lowest id. The rule is derived from the data: across all 139 pairs, files, metadata, external IDs and subtitles were identical and only artwork (79) and NFO (78) differed, so the keeper always holds the superset. It also clears duplicate groups left with fewer than two members, sweeping the orphans that accumulate because `detect()` deletes and recreates every group outside a transaction.

**Security.** `POST /api/media/duplicates/detect` runs `deleteMany({})` across all duplicate groups but was gated on `MEDIA_MANAGER_VIEW`, so a read-only account could destroy grouping state and trigger a full-table scan; it now requires `MEDIA_MANAGER_SCAN`. The destructive `POST /api/media/shows/duplicates/merge` — which moves files and deletes folders — typed its body with an inline TypeScript type, which the global `ValidationPipe` cannot validate, leaving it reachable with unvalidated input; both show-merge routes now take a `ShowMergeDto` with UUID-checked, non-empty, size-capped ids.

The full audit behind this is in `docs/DUPLICATES_REDESIGN_REVIEW.md`.
