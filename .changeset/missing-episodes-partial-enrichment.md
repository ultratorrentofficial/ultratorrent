---
"ultratorrent": patch
---

Fix Missing Episodes counting on-disk episodes as missing when a show is only *partially* enriched.

Ownership is resolved in `MissingEpisodesService.ownedEpisodeSet` by two lookups: the structured `seriesImdbId` link, and a title match for items that carry no series id. The title lookup ran only as a **fallback**, gated on the id lookup returning zero rows. That made enrichment all-or-nothing per show, which real libraries never are — a folder accumulates files over years, and only the ones a later scan touched come back with a `seriesImdbId`. A single enriched item was enough to make the id query non-empty, which suppressed the title lookup entirely, so every un-enriched sibling was reported missing while sitting on disk. The wanted-episode sweep then went searching for episodes the library already had.

The two lookups are now **unioned** rather than chained. Both guards on the title half are unchanged and still necessary — an item anchored to a different tconst is excluded, as is one whose year contradicts the series' start year (±1), which is what stops a same-titled other series (*The Librarians* 2007 vs 2014) from owning these episodes. Neither guard depended on the id query having come back empty, so the union is as tightly bounded as the fallback was.

On a live 137-series library this recovered 137 episodes across 27 shows that were present on disk but reported missing — e.g. *Ghostwriter* 10 → 35 owned, *Euphoria US* 9 → 24, *Godfather of Harlem* 20 → 31 (S03–S04 had been enriched, S01E01 and all of S02 had not).
