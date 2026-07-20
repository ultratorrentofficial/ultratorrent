---
"ultratorrent": minor
---

Duplicate Center Phase 6 — detection becomes a cancellable background job, and stops redoing work nothing has changed.

Measured on a live 29,558-item library, `POST /api/media/duplicates/detect` took **10.5 seconds inside the HTTP request**. That is a spinner with nothing behind it, and on a larger library a gateway timeout.

| | before | after |
|---|---|---|
| HTTP request | 10,553 ms | **6 ms** (returns `{ jobId }`) |
| Full detection | 10,553 ms | **5,430 ms** |
| Re-scan, nothing changed | 10,553 ms | **967 ms, zero reads of item rows, zero writes** |

The unchanged case is the one that recurs — scheduled scans, and an operator pressing the button twice — and it is now 11× faster than where this started. The full run carries about 665 ms it did not before, because the change digest is computed in SQL *before* the items are loaded rather than derived from rows already in memory. That is a deliberate trade: it is what lets the unchanged case avoid loading anything at all.

**It ran synchronously.** Detection is now a tracked `duplicate_detect` job: progress streams over the existing `media_manager.job.*` events and `POST /api/media/jobs/:jobId/cancel` stops it. Cancellation is cooperative — the job body stops at a boundary it chose, because these runs write rows and a hard abort mid-batch leaves exactly the half-applied state the rest of this feature works to avoid. A cancelled run is recorded as `cancelled`, not `failed`; an operator who pressed Cancel should not be told the job broke.

**It loaded everything.** `include: { externalIds, files }` hydrated every column of 29.5k items plus 63k external-id rows and 29.5k file rows for the sake of eight fields. Now a narrow `select`, paged 5,000 at a time.

**It wrote one statement at a time.** Per group: upsert, updateMany, update, deleteMany, createMany — roughly 2,260 sequential round trips for 452 groups. Group ids are now generated client-side so a bulk `createMany` can be used, and the remaining writes batch into `$transaction` arrays of 50 groups: one round trip per batch instead of about 200.

**It did all of that even when nothing had changed.** A new single-row `media_duplicate_scan_state` stores an md5 over every item's identity, path, total file size and external ids, computed by one query in Postgres. An identical digest skips the run before a single item row is loaded. Two ordering rules make that safe: the digest is taken *before* the rows are read — so a change landing mid-run makes the next run's digest differ and re-run, which is the over-inclusive direction — and it is recorded only after a run that finished, so a cancelled run cannot convince the next one that the database already matches.

`detect()` now returns metrics — items scanned, groups detected/created/removed, duration, whether anything changed — instead of page 1 of a listing. Detection is a command and listing is a query; the old shape meant a caller could not tell what the run had done.

Alongside, in the show-folder path: detection was O(n²) over every show in a library (665 shows is 220k comparisons, and 50M at 10k shows) for a relation that only ever holds between same-key or same-id folders — now bucketed, with the year check preserved inside the name bucket so `Dark Matter (2015)` and `(2024)` still stay apart. `GET /media/shows/duplicates` returned an unbounded array where building each entry walks every member folder recursively; the candidate set is now computed from rows in memory and only the returned page touches disk, with `total` still reported. The scanner's family count asks for a page of one rather than walking 25 directory trees for a number the grouping pass already knows.

Indexes were added for the paths actually queried rather than one column at a time — the default listing is `WHERE status='open' ORDER BY requiresReview DESC, potentialSavingsBytes DESC`, which no combination of the existing single-column indexes serves — plus `media_files(size)` and the two identity shapes `media_items` is looked up by.

**Not attempted: true incremental detection.** `detectDuplicateGroups` keeps a global `assigned` set and walks buckets in priority order, so an item leaving a bucket can drop it below two members, free its co-member, and complete a lower-priority bucket — a cascade that needs a work-list closure to get right, and whose failure mode is silently wrong groupings. It would also only attack the grouping-and-writing portion, not the load; beating the load needs an `updatedAt` watermark, which cannot see deletions. Skipped deliberately in favour of the digest, which captures the recurring case for a fraction of the risk.

**Not addressed:** there is no content hashing anywhere in the codebase, so the `exact_hash` detection reason the brief lists does not exist, and "recompute hashes only when size or modification time changes" has nothing to recompute yet.
