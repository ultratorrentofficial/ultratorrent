---
"ultratorrent": patch
---

Repairing a contaminated movie identity now distinguishes "nothing verified" from "several verified equally". A tie is not the absence of an answer, it is more than one — TMDB genuinely holds three different `Aladdin (1992)` and five different `Run (2020)` — so it is no evidence against the id already stored. Providers can now report the tied ids (`ambiguousMovieIds`), and the repair KEEPS a stored id that is one of the tied films while clearing one that is not; across the live library every stored id present in its tied set was the right film and every absent one was the contaminant. Nothing is guessed either way. Also fixes a latent data-loss path: an implicated item's clean ids were omitted from the plan, and apply() replaces ids wholesale, so a clean id would have been deleted alongside the wrong one.
