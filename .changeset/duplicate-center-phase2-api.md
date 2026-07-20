---
"ultratorrent": minor
---

Duplicate Center Phase 2 (backend) — server-side search, filtering, sorting, an overview aggregate, group detail, and persistent ignore/reopen.

`GET /api/media/duplicates` previously took only `page`/`pageSize` and returned every group in creation order. It now accepts a validated query: free-text `q` across media title and file path, plus `libraryId`, `mediaType`, `status`, `groupType`, `reason`, `requiresReview`, and a `sort`. Item-level filters reach through the membership (`items.some`), so filtering by library means "this group has a member there" rather than dropping the group. The count uses the same filter as the rows — a total that contradicts the page is worse than no total.

The default sort is **needs-review first, then largest potential reclaim**, and the default status filter is `open`. A landing screen that silently mixes in resolved and ignored groups is how an operator stops trusting the numbers.

`GET /api/media/duplicates/overview` returns the landing-screen counts as database aggregates — status/type/reason breakdowns, needs-review count, potential savings, last detection time, resolution outcomes — without loading a single group row. The old list path pulled whole groups with their items, files and external ids just to render a table.

`GET /api/media/duplicates/:groupId` returns the comparison payload. It deliberately splits **measured** technical data (`width`, `height`, `bitrateKbps`, `durationSec`, `audioChannels`, `frameRate`, read from the container by `MediaProbeService`) from **filename-parsed** claims (`resolution`, `videoCodec`, `hdr`, …). The parsed fields are null on the overwhelming majority of a renamed library — the schema records 96% of files with no `videoCodec` and 100% with no `hdr`, because the renamer strips those tokens — so presenting the two together as equally trustworthy would fill a comparison view with blanks that read as missing data rather than absent evidence.

`POST /api/media/duplicates/:groupId/ignore` and `/reopen` make "these are not duplicates" durable: the decision is recorded against the group's stable identity from Phase 1, with actor and reason, and detection only deletes groups still `status = 'open'`. Both require `media_manager.match` rather than `view` — recording a judgement about media identity is not a read.

Route ordering puts `duplicates/overview` ahead of `duplicates/:groupId` so the literal path cannot be captured as an id.
