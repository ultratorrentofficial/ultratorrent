---
"ultratorrent": patch
---

Missing-episode auto-downloader now saves grabbed episodes into the parent Show Rule's download directory (RssRule.savePath) instead of the torrent engine's default /downloads. Falls back to the engine default when the show isn't linked to an RSS rule or the rule has no save path.
