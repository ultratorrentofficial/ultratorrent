---
"ultratorrent": patch
---

New **parking queue** for dead torrents. A torrent engine has a limited number of active-download slots (qBittorrent's `max_active_downloads`), and a magnet with no seeders can never even fetch its metadata — yet it occupies a slot the entire time it tries. Grab enough dead releases and every slot fills with torrents that will never finish, while every healthy torrent behind them waits in the queue forever. Seen in production: 100 slots held by dead magnets, 1,034 torrents queued behind them, zero bytes moving.

A torrent that is active, making no progress, connected to nobody, and whose tracker reports no seeders (after a grace period) is now paused and held in a parking queue, freeing its slot for a torrent that can actually run. Parked torrents are periodically force-started so they re-announce and refresh their seeder count — force-started specifically because a plain resume on a full queue would land them back in the queue where they never announce, making parking a one-way trip. The moment seeders reappear the torrent is released back into the normal queue; if it dies again it is simply re-parked, with an exponential backoff so a long-dead torrent is retried rarely rather than every cycle.

Ships **disabled by default**. Enable via `PATCH /torrents/parking/settings` (`enabled`, `minSeeders`, `deadAfterMinutes`, probe batch/interval); `GET /torrents/parking` lists what is held, and a torrent can be released by hand.
