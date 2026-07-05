---
"ultratorrent": patch
---

fix(rss): dedupe auto-downloads by torrent info-hash so a release re-posted under a rotated guid or seen on a second feed is never grabbed twice (poll + backfill)
