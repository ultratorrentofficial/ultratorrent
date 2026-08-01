---
"ultratorrent": patch
---

The TMDB movie matcher no longer lets popularity break a tie. Every result is scored on title+year, but `score > best.score` kept the FIRST of several equal scorers — and TMDB orders by popularity, so the ranking the matcher exists to distrust was silently deciding. Live: searching "Tom" (2022) returns "Little Man Tom", whose ORIGINAL title is literally "Tom", so it ties at 1.00 with the film actually called Tom and outranks it. A candidate whose own title matches now wins over one matching only through an original/AKA title, and a tie that survives that is rejected rather than guessed.
