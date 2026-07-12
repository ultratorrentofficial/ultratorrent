---
'@ultratorrent/frontend': patch
---

Fix the dashboard's download/upload counters flickering to a dash, and the throughput
graph sawtoothing to zero, whenever more than one torrent engine is configured.

The backend broadcasts one `stats:update` per engine on each 2s sync tick, but the
realtime provider stored only the most recent one — so an idle engine's `0 B/s`
overwrote an active engine's real rate twice a second, and `formatSpeed(0)` renders as
`—`. Stats are now kept per engine and aggregated, the chart plots one point per sync
round instead of one per engine, and the engine badge reports online if *any* engine is
up rather than flipping on whichever engine reported last.
