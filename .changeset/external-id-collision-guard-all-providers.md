---
'@ultratorrent/backend': patch
---

fix(media): the external-id collision guard now covers TVDB and TMDB, not just IMDb

A `.nfo` is written by whatever media manager last touched the library, and it can be
confidently, systematically wrong. The guard that catches this — an episode id filed
under two different show folders is provably wrong for at least one of them — was
already in place, but it opened with `if (provider !== 'imdb') return false;`.

The other two providers show exactly what that cost. On a real library:

| provider | ids shared across different shows | items affected |
|----------|----------------------------------|----------------|
| imdb     | **0** (guarded)                  | 0              |
| tvdb     | **871**                          | **3,278**      |
| tmdb     | 1                                | 4              |

Dickinson's entire second season — eight distinct episodes — carried a single *Game of
Thrones* episode id, while the correct id sitting in its own (perfectly good) sidecar
appeared nowhere in the database.

It sticks because `importLocalNfo` upserts external ids with `update: {}`, deliberately
never clobbering an existing mapping. A bad id imported once is therefore permanent:
re-importing the corrected sidecar cannot displace it. The guard is the only thing that
removes one, so it has to run for every provider the sidecar carries.
