---
"ultratorrent": minor
---

Media Manager: library scans now show live progress. The scanner streams a completion percentage plus a per-file action log (added/updated, prune, artwork/metadata import, final summary) over the existing `media_manager.job.progress` WS event, and the Libraries page renders a progress bar + scrolling action log while a scan runs (hideable — the scan keeps running server-side).
