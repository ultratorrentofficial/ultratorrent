---
"ultratorrent": patch
---

Missing episodes: a monitored series whose IMDb id was accidentally an episode (or other non-series) id used to scan to a permanent zero — no episodes, nothing missing. The scanner now detects this (the id resolves to 0 catalogue episodes), re-identifies the show from its title against the local IMDb catalogue, and persists the correction, so it self-heals on the next scan instead of silently showing nothing.
