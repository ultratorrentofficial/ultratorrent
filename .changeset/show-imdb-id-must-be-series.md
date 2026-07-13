---
'@ultratorrent/backend': patch
---

fix(media): a show's IMDb id must be a SERIES id, never an episode's

`reconcileShows` fell back to an item's own `imdb` external id when `seriesImdbId`
was unset. But a `MediaItem` in a TV library is **one episode file**, so its external
id is that *episode's* tconst — never the show's. Storing it as `MediaShow.imdbId` is
a category error.

It produced nonsense on a real library. The episode tconst `tt13701758` ("Pilot", a
`tvEpisode`) had been mis-assigned to **18 different shows' pilots**, so Ted Lasso,
Servant, Dickinson, Hawkeye, See, Physical, Schmigadoon! and eleven others all came out
carrying the same "show" id — and duplicate-show detection duly reported them as one
family of 14 folders to merge. Only the `needsReview` guard (never trust an id whose
folders disagree on their names) kept that from being offered as a safe merge.

Now only `seriesImdbId` is used — the field whose entire job is to hold the *series*
tconst, and which `resolveSeriesImdbId()` sets by mapping an episode to its parent
title. When it is null the show has no id, and null is the honest answer: a wrong id is
worse than none, because everything downstream trusts it.

Note this does not fix the underlying metadata corruption (18 shows' pilots sharing one
episode tconst in `media_external_ids`) — that is a separate identification bug. It
stops that corruption from being laundered into show identity.
