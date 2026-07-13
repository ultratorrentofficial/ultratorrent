---
'@ultratorrent/backend': patch
---

fix(media): an IMDb episode id claimed by two shows is dropped from both

A `.nfo` sidecar is written by whatever media manager last touched the library, and it
can be confidently, systematically wrong. On a real library **eighteen unrelated Apple
TV+ shows** — Ted Lasso, Servant, Dickinson, Hawkeye, See, Physical, Schmigadoon! … —
each carried `<uniqueid default="true" type="imdb">tt13701758</uniqueid>` in their
S01E01 sidecar. That tconst is **Acapulco S01E01**: the generator had matched episodes
by title, so every show's "Pilot" collided.

We imported it verbatim, so one show's episode ids landed on eighteen shows, and
everything keyed on IMDb identity inherited the lie — show grouping, duplicate
detection, and the acquisition path's id anchor.

An episode tconst identifies exactly one episode of exactly one series. So an id filed
under **two different show folders** is provably wrong for at least one of them — and
since we cannot tell which, neither keeps it: the id is refused on import and stripped
from the rows that already hold it.

**The catalogue's series title is deliberately NOT used to judge this.** It looks like
the obvious check and it is wrong: a library legitimately files "Andor" as
`Star Wars Andor`, and AMC renamed "Interview with the Vampire" to "The Vampire Lestat"
mid-run. A title comparison flagged 36 perfectly good ids across those two shows before
the collision rule replaced it. The collision cannot produce a false positive.
