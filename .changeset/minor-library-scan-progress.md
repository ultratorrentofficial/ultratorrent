---
"ultratorrent": minor
---

Media Manager: library scans are now asynchronous with live progress. The scan endpoint returns a job id immediately (fixing the 504 Gateway Time-out on large libraries where the synchronous request exceeded the gateway timeout), and the scanner streams a completion percentage plus a per-file action log (added/updated, prune, artwork/metadata import, final summary) over the `media_manager.job.progress` WS event. The Libraries page renders a progress bar + scrolling action log while a scan runs (hideable — the scan keeps running server-side), driven by the WS events; the dashboard "Scan all" fires background scans.
