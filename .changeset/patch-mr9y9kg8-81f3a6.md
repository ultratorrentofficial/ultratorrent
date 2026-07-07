---
"ultratorrent": patch
---

Fix duplicate detection grouping different films that share a title (e.g. Aladdin 1992 vs 2019). The similar_filename fallback key was title-only for movies, so same-title/different-year films collided even though title_year already separated them. The fallback is now year-scoped for movies (and episode-scoped for shows), matching the precision of the primary keys.
