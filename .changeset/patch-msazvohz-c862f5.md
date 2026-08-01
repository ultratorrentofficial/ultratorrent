---
"ultratorrent": patch
---

TheTVDB's movie search is now verified instead of trusted. It took `data[0]` from a ranked, unfiltered search — the same unguarded pattern that stamped one film's ID onto three different movies via TMDB — and it sits SECOND in the film chain, so it answers precisely when TMDB has already declined and the query is least reliable. Both providers now apply one shared rule (year gate, sequel gate, similarity threshold, and a tie rejected rather than guessed), so the two cannot drift apart. The television branch is deliberately unchanged: TV identity is verified elsewhere and TVDB is the stronger television source.
