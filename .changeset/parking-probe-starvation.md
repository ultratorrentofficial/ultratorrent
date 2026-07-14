---
'@ultratorrent/backend': patch
---

Torrent parking is no longer a one-way trip: the probe queue could starve, stranding every
parked torrent as permanently paused.

Parking pauses a torrent whose swarm looks dead so it stops holding an active-download slot,
then force-starts a small batch of parked torrents each tick to re-check whether their swarm
came back. That probe loop is the *only* way out of parking — a paused torrent never
announces, so its seeder count can never refresh on its own. If probing stops, parking is
permanent.

`startProbes` ranked candidates by `lastProbedAt` ascending, took a fixed window of
`probeBatchSize * 4` rows, and only then filtered that window for due-ness. But due-ness is
governed by an exponential backoff scaled by `probeCount` (capped at 24h), so the two orders
are opposites at the head: **the torrents probed longest ago are exactly the torrents with the
longest backoff, and they are never due.** They squat on the entire window, every tick,
forever — while the freshly parked torrents that *are* due sort last and are never even
fetched. Accumulate ~80 long-dead torrents and probing stops permanently.

Observed on synoplex: 512 parked torrents, 510 of them stopped in qBittorrent, **90 due for a
probe and 0 probed per tick** — the whole download queue frozen at the same 521 torrents for
days, while a second host on the identical build kept cycling because 2 of its window rows
happened to still be due.

The candidate query now considers **every** parked torrent and ranks them by
`nextProbeAt()` — when the next probe actually falls due — which is also the function
`isProbeDue()` is now expressed in terms of, so the selection order and the eligibility
predicate cannot drift apart again. A newly parked torrent (never probed) sorts ahead of
anything already in backoff, and when more torrents are due than fit in a batch, the most
overdue go first.

The unit tests could not have caught this: their Prisma mock ignored `orderBy` and `take`, so
the truncated window it returned was always the full table. The mock now honours both, and a
regression test pins the case directly — one due torrent behind 80 never-due ones still gets
probed.
