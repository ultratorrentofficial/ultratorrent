---
"ultratorrent": patch
---

File Manager: a multi-select move/copy that failed reported success. /files/bulk returns 200 with per-item errors in the body, and callers treated any resolved promise as success — so moving files onto ones that already exist toasted "Moved 2 items" while nothing moved. Failures in the body are now surfaced at every bulk call site (move, copy, delete and Clean up selected): a partial run warns with a count and the distinct reasons, a total failure errors and holds its state — dialog open, selection intact — so it can be retried with overwrite. The read is centralised in a shared `bulk-result` module rather than re-derived per caller.
