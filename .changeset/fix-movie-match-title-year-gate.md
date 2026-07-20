---
"ultratorrent": patch
---

Fix: the movie matcher no longer assigns one film's external IDs to a different film.

Root cause of the contaminated-external-ID duplicates (reported as "The Maze Runner / Maze / The Runner"): the TMDB movie search took `results[0]` with **no verification**. TMDB ranks by popularity, so a short query title returned a popular longer film first — and its `imdb`/`tmdb` id was written verbatim. On a live library this stamped one id onto many different movies: "Men (2022)" got *Men in Black (1997)*, "The Ring (2002)" got *Fellowship of the Ring (2001)*, "Run (2020)" got *Chicken Run (2000)*, and so on — 50 contaminated ids on one host, 24 on another.

The movie path was missing every safeguard the TV path has. It now applies the same identity discipline the TV matcher learned, as **two independent gates**:

1. **Hard year gate** — a candidate more than one year off the parsed year is a different film and is dropped before scoring (Aladdin 1992 vs 2019; "Men" 2022 vs "Men in Black" 1997). ±1 absorbs a festival-vs-wide-release drift, mirroring the TV `ImdbSeriesResolver.narrowByYear`.
2. **Title-similarity threshold** — every remaining result is scored with the same `scoreTitleMatch` the manual/IMDb path already used, and a weak best is rejected. This catches the same-year near-misses the year gate cannot ("Soft" → "Soft & Quiet" 2022; "The King" → "The Lion King" 2019).

The picker also now scores **all** results and promotes the real match even when a popular wrong film outranks it, instead of only ever looking at the first hit.

A rejected match writes **no** id — a movie with no external id is correct-but-incomplete, while a movie with the wrong id corrupts detection, dedup and every downstream lookup. 10 new tests pin the reported cases and the accept/reject boundary.

Note: this stops NEW mis-matches. Existing contaminated ids are corrected by clearing them and re-fetching under the fixed matcher (a rescan of the movie libraries).
