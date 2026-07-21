---
"ultratorrent": patch
---

Fix: the movie matcher no longer confuses a film with its same-year sequel.

Follow-up to the title+year movie-match fix. That gate rejects a candidate whose year is more than a year off, and a candidate whose title is too dissimilar — but it could not separate a film from its **same-year numbered sequel**. Observed live: "Ultimate Avengers" (2006) and "Ultimate Avengers 2" (2006) — same year, titles differing by only "2" — scored ~0.92 against each other (above the accept bar) and ended up sharing one imdb/tmdb id.

A **sequel gate** now sits beside the year gate: a candidate that is the *same base title but a different trailing sequel number* than the query is dropped as a different film. It unifies arabic and roman numerals, so "Rocky 5" and "Rocky V" are recognised as the same film (not a conflict) while "Rocky" and "Rocky V" are not. It never rejects a correct match — the same film always resolves to the same number — so it only fires between genuinely different franchise entries. When TMDB returns the real sequel it is still picked; when it returns only the wrong entry, the movie is left unmatched rather than mis-matched.

Reusable `titlesAreSequelVariants` helper added to `imdb-match.ts`. 9 new tests (6 unit + 3 provider).
