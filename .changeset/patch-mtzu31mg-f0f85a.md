---
"ultratorrent": patch
---

Media Acquisition: pack-aware backfill — when a whole season (or the whole series) is missing, the Add-Series backfill grabs ONE season/series pack (reusing the existing indexer search, match-preference quality rules and grab path) and lets intake fan it out to episodes, instead of per-episode searches that can't match packs. Configurable with conservative defaults (fully-missing seasons only); falls back to per-episode when no pack is found.
