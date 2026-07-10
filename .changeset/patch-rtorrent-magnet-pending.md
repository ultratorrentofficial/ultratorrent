---
"ultratorrent": patch
---

rtorrent: don't record a magnet add as failed just because it isn't registered within the ~6s confirm window. A magnet carries only the info-hash; rtorrent doesn't list it until it fetches metadata from DHT/peers, routinely far longer than 6s. `confirmTorrentLoaded` now treats a confirm-timeout for a **magnet** as accepted/pending (logs and returns; the 2s torrent-sync reconciles when it registers) while **.torrent file** adds still throw on timeout (metadata is present, so a real failure is meaningful). This eliminates a flood of false `media_acquisition.download.failed` records for magnets that download fine (observed: 256/257 "failures" actually loaded, median ~53s later) and the associated duplicate-add risk.
