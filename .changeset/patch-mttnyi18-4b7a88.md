---
"ultratorrent": patch
---

Release a parked torrent once it finishes downloading. The revival test required a connected seed or active download throughput, and both are structurally zero for a completed torrent, so one that completed while parked was re-parked on every probe forever - and because the scheduler skips parked torrents, its seeding policy and age deadline were never evaluated again.
