---
"ultratorrent": minor
---

Transfer statistics are now a persistent ledger: total downloaded, uploaded and share ratio survive torrent removal, engine restarts and container rebuilds instead of being re-derived from whatever torrents the engine currently holds. Existing history is recovered from qBittorrent's own all-time counter on first run.
