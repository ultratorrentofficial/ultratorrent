---
'@ultratorrent/backend': patch
---

fix(torrents): dead magnets no longer starve the torrent-name repair

`TorrentNameRepairService` takes the first `MAX_PER_TICK` (5) placeholder-named
torrents on each 2-second sync tick. A magnet whose metadata hasn't arrived can't be
renamed — there is nothing to rename it *to* — and the loop `continue`d past it
**without recording that anywhere**.

So the same dead magnets were reconsidered on every single tick, permanently occupying
the whole per-tick budget, and the torrents that *could* be repaired were never
reached. On a real host: **221 metadata-less magnets sitting ahead of 15 fixable
torrents — not one name was ever repaired**, and the service logged nothing, because
the skip path is silent.

A metadata-less magnet is now backed off for 5 minutes. It is still not *settled* (it
may yet resolve), but it stops consuming the budget.

Engine calls in the repair also gained a 10s timeout. The repair runs inside the sync
tick, whose re-entrancy guard is cleared in a `finally` — so a call that never settles
doesn't merely delay a rename, it wedges the entire sync loop (no torrent updates, no
state transitions, no automation triggers) until the process restarts. A timeout turns
that into a logged failure.
