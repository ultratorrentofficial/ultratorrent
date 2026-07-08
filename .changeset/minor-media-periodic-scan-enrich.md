---
"ultratorrent": minor
---

Media libraries now scan and auto-populate on a schedule. A new periodic scanner runs each enabled library on its own `scanIntervalMinutes` cadence (never scanned, or `lastScanAt` older than the interval), so folders you add manually or drop in externally get identified and enriched without waiting for a download. For every item still missing identity, metadata, or a poster it fills the gap (identify → fetch metadata → fetch artwork), leaving already-enriched items alone so repeat scans do almost no work. Unlike the post-download workflow, the periodic scan never renames or moves your files — it enriches them in place. It's opt-in per library: a library with no scan interval (null/zero) is only ever scanned manually, so existing setups are untouched until you set an interval.
