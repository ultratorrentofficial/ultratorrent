---
"ultratorrent": patch
---

The missing-episode search no longer widens its query when some indexers failed. Widening is a bet that the release exists under a different spelling, and an empty answer from a degraded search is no evidence either way — while the usual reason an indexer fails here is HTTP 429, where asking twice more is exactly wrong. Observed live: EZTV and TPB both throttled to 429 while a third indexer answered emptily, so every episode looked like a clean miss and every miss triggered the full widening, tripling traffic into the service already refusing it. A complete search that finds nothing still widens, which is what the feature is for.
