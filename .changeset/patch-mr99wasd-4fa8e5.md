---
"ultratorrent": patch
---

rTorrent engine: confirm a torrent actually registers before reporting an add as successful. addMagnet/addTorrentFile issued a fire-and-forget load.start (which returns 0 immediately and loads asynchronously) and then returned a hash derived from the magnet/torrent — so if rtorrent silently dropped the torrent or crashed mid-announce, the RSS/download flow recorded a phantom 'downloaded' with no torrent in the engine. Both add paths now poll the download list (case-insensitive) until the info-hash appears and throw if it never does, so the manual path surfaces an error and the auto path skips marking it downloaded
