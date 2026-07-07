---
"ultratorrent": patch
---

Library scans now reconcile deletions: items whose file no longer exists on disk are pruned (guarded so an unreadable/unmounted root never wipes a library). Previously scans only added/updated, so files removed on disk (or under a skipped dot-folder like tinyMediaManager's .deletedByTMM) lingered as phantom library items forever. ScanSummary gains a removed count. Combined with the existing dot-directory skip, hidden trash folders are neither indexed nor left behind.
