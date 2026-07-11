---
"ultratorrent": patch
---

Show identification now handles accented titles and shows with no year. A series like "90 Day Fiance" never matched IMDb's "90 Day Fiancé" — the accent was being stripped rather than folded to a plain "e" — and the matcher only ran for shows that had a year, which this one didn't. Both are fixed, so accented shows (90 Day Fiancé, Pokémon, …) and year-less entries now resolve to the correct series and start reporting their missing episodes.
