---
"ultratorrent": minor
---

The manual "Scan" action now enriches, not just indexes and renames. Previously `POST /api/media/libraries/:id/scan` ran only the scanner (index files, record show folders, import on-disk sidecars) followed by the organiser (rename/move into `Show/Season NN`) — it never identified items, fetched provider metadata, or downloaded artwork. So a library whose `scanIntervalMinutes` was null (the default, "manual scans only") had **no** path to metadata/artwork at all: the file got renamed, but the episode stayed `unmatched` with no poster, because provider enrichment ran only from the post-download workflow or the periodic scheduler.

The scan endpoint now runs the same three stages, in the same order, as the post-download and periodic paths: **index → organise/rename → enrich**. Enrichment runs last so it reads the final post-rename paths. It fills only gaps — unmatched items get identified, and matched items missing metadata or a poster get them — so re-scanning a steady-state library does almost no work and never re-hammers providers. Locked items are left untouched.

Implemented by extracting the gap-filling loop out of `MediaProcessingService.processLibrary` into a shared public `enrichLibrary(libraryId, report?)`, which both the periodic scheduler and the manual scan now call, so a hand-triggered scan enriches identically to the scheduled one. The scan job's `{ ...scan, organized }` result gains an `enriched` summary (`identified` / `metadataFetched` / `artworkFetched` / `processed`), and progress is re-weighted across the three stages (scan 0–55%, organise 55–70%, enrich 70–100%).
