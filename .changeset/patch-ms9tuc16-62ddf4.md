---
"ultratorrent": patch
---

The RSS duplicate guard was blind to items published without a magnet. It matches history on infoHash, and the extractor read only magnets — so a feed offering just a .torrent URL recorded a NULL hash, and NULL matches nothing. Measured on a live install: 96 of 351 downloaded rows had no hash, and one film re-downloaded 18 days later. The hash was rarely absent, only unread: YTS links are literally /torrent/download/<40 hex>. The extractor now reads a link as well as a magnet, history records the engine's own hash when the feed supplies none, and a migration recovers the hash for rows already written.
