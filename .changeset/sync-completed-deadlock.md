---
'@ultratorrent/backend': patch
---

fix(torrents): a completed torrent can no longer wedge the entire sync loop

The 2-second sync tick derived transitions by diffing the engine against the last
snapshot, then **acted on them before recording the new state**. So a side-effect that
was slow — or that hung — left the snapshot unwritten, and the *same* transition was
detected again on the next tick.

Observed live. One torrent sat at `0.9999570` in the snapshot while the engine reported
`1.0`, which made it a permanent rising edge. Every 2 seconds it re-fired
`torrent.completed` and **awaited the full post-download media pipeline** (scan →
identify → metadata → artwork → subtitles → rename). That pipeline ran **5,284 times**
before finally blocking on an external metadata fetch.

The tick's re-entrancy guard is cleared in a `finally`, so that one stuck await killed
the whole sync loop: no torrent updates, no state transitions, no automation triggers,
and no name repair — silently, with no error, until the process was restarted. Fifteen
repairable torrent names sat broken behind it.

Three changes:

- **Persist the snapshot BEFORE firing side-effects.** The baseline is read first, the
  new state is written, and only then are transitions applied — so an edge fires at
  most once no matter what the side-effects do.
- **Don't await the media pipeline.** It runs for minutes and calls external providers;
  it has no business blocking a 2-second tick. It queues its own jobs, so nothing in
  the tick needs its result.
- **Timeouts** (15s) on `listTorrents`/`getGlobalStats`, and a `catch` on the completion
  notification — a throw there previously aborted the whole tick.
