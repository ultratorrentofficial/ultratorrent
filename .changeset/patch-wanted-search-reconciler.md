---
"ultratorrent": patch
---

Missing-episode search: episodes stranded by a restart are now released at boot. The sweep flips `searchStatus` to `searching` *before* calling the indexers, and nothing ever reset it — so a backend restart or redeploy in the middle of a sweep left those rows marked `searching` permanently. The sweep only ever selects `idle`, `no_results` and `failed`, so a stranded row was **never searched again** and its episode could never be acquired, silently and forever (found in production: 20 episodes on one host, 3 on the other, stranded by a day of deploys). Anything still `searching` at startup was interrupted by definition, so it is reset to `idle` and picked up by the next sweep. Wanted movies carry the same column and are reconciled too.
