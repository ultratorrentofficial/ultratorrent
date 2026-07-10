---
"ultratorrent": patch
---

Missing episodes: show a TV airing-status badge (Returning / Ended / Cancelled / Continuing / …) beside each series in the Smart Download "Missing episodes" overview. The status is read from the shared show-status cache (no provider calls on load) and warmed in the background for shows not yet resolved, so a later refresh fills in the badge. Reuses the existing RSS show-status badge and labels.
