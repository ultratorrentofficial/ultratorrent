---
"ultratorrent": patch
---

Dashboard "Recent activity" now collapses bursts of identical background events into a single line. The metadata/artwork/IMDb enrichment sweeps write one audit entry per media item, which used to flood the feed and push out everything else; those recurring system events are now shown once with an "N events" count, while user actions and one-off events are unchanged. This keeps the feed representative — a few enrichment lines plus the automation runs, renames, and downloads you actually want to see.
