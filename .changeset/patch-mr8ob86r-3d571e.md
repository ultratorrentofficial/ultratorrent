---
"ultratorrent": patch
---

Media Manager: add bulk re-identify endpoint (POST /api/media/items/reidentify) to re-run auto-identification across a whole library at once — the recovery path for libraries that scanned as unmatched. Optional { libraryId, matchStatus } body (omit to re-identify all non-manual items, or matchStatus:'unmatched' to retry only failures); runs as a tracked media_identification job with WebSocket progress and returns a { total, matched, unmatched, failed } summary. Manual matches are never auto-overwritten. The Unmatched page gains a "Re-identify all" button (scoped to unmatched items) that reports how many matched; `api.media.reidentifyItems()` client method added. i18n en-US + es-PR
