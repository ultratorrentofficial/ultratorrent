---
"ultratorrent": patch
---

Missing episodes: re-check whether an episode is already in the library immediately before grabbing it, and schedule the owned/missing rescan that never had a scheduler. A stale missing verdict - on one install seven weeks old - made the auto-grab sweep re-download a season three times, descending the quality ladder each round as the previous release was blacklisted as dead.
