---
'@ultratorrent/backend': patch
---

Missing-episode acquisition no longer grabs the wrong show, and a dead media server no
longer reports itself healthy.

**Show identity.** `select()` decided whether an indexer release belonged to the show it
was searching for with a bidirectional substring test
(`t.includes(show) || show.includes(t)`), so it accepted any release whose title merely
*contained* the monitored show's name — or was *contained by* it. Nothing downstream
re-checked: profile- and default-derived preference candidates carry `pattern: null` (a
deliberate pass-through), so quality and size were the only surviving filters. On a real
library this mis-grabbed **132 of 714 episodes (18.5%)** across 15 shows — "Rise" pulled in
*The Pendragon Cycle: Rise of the Merlin*, "90 Day Fiance" pulled in *Before the 90 Days*,
"ted" pulled in *Ted Lasso*, "House" pulled in *House of the Dragon*. Identity is now
anchored with `showTitleMatch` (exported from the RSS match-engine), which requires the
release's *pure title* — its show-title region, minus a trailing year and the quality tail
— to equal the monitored title token-for-token. It is the same rule the RSS engine already
applied to `smart_episode_match`, and the two paths now agree.

**Title aliases.** Some shows are published under a different title than the one they are
monitored as — Riverdale ships as `Riverdale US`, The Bad Batch as `Star Wars The Bad
Batch`. Token equality alone would reject those and silence the show, so a watchlist item
gains `titleAliases`: additional titles that count as this show. Each alias is anchored by
the same rule, so an alias widens *which* titles match without loosening the comparison —
an alias on "Rise" still cannot readmit *Pendragon*.

**Media-server health.** `status` was only ever written by `healthCheck()`, and nothing
called it on a schedule. The library refresh runs from the download pipeline, so a media
server was contacted only when a torrent happened to finish — and when those refreshes
failed, they were audited but never recorded as a health signal. A Plex server that had
been down for four days sat at `status: 'online'` through 479 consecutive failures, with
the dashboard reporting it healthy throughout. Now every path that talks to the server
records what it learned (`refresh`, `test`, `healthCheck`), a failed probe no longer
discards the version/platform it cannot see, `status`/`lastHealthCheckAt` are returned by
the API (they were previously omitted, so the UI could never have shown them), and a new
`MediaServerHealthScheduler` probes each enabled integration every five minutes, logging
transitions rather than a heartbeat.
