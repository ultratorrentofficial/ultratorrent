---
'@ultratorrent/backend': patch
---

fix(media): reject an NFO's IMDb id that the catalogue says belongs to another show

A `.nfo` sidecar is written by whatever media manager last touched the library, and it
can be confidently, systematically wrong. On a real library **eighteen unrelated Apple
TV+ shows** — Ted Lasso, Servant, Dickinson, Hawkeye, See, Physical, Schmigadoon! … —
each carried `<uniqueid default="true" type="imdb">tt13701758</uniqueid>` in their
S01E01 sidecar. That tconst is **Acapulco S01E01**. The NFO generator had evidently
matched episodes by title, so every show's "Pilot" collided.

We imported it verbatim, so one show's episode ids landed on eighteen shows, and
everything downstream that keys on IMDb identity inherited the lie — show grouping,
duplicate detection, and the acquisition path's id anchor.

The local IMDb catalogue settles it: an episode tconst has exactly one parent series.
If that series is not the one the file is filed under, the sidecar is wrong and the id
is dropped (with a warning naming both shows).

Deliberately conservative — it rejects only on a **positive** contradiction:

- non-`imdb` providers and non-TV items are untouched;
- an id the catalogue doesn't know as an episode is imported as before;
- an alternate title the catalogue carries is not a mismatch (`The Office (US)` is
  catalogued as `The Office`), so a legitimately-renamed folder still matches.
