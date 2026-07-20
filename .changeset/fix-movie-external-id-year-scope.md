---
"ultratorrent": patch
---

Fix: three different movies sharing a contaminated external ID no longer group as duplicates.

Reported live: "The Maze Runner" (2014), "Maze" (2017) and "The Runner" (2015) were grouped as one duplicate. Their metadata was contaminated — a mis-identification had stamped the same `imdb:tt1790864` / `tmdb:198663` onto all three — and the detector collapsed them because the MOVIE `external_id` key was not year-scoped. Three films with three different release years merged on a shared id, violating the "different release years must not collapse" rule the title and filename keys already enforce.

The movie external-id key is now scoped by year, mirroring how the TV key is scoped by show + episode. Same id + same year still groups (external_id's real job — catching one film whose filenames parse to different titles), but different years never collapse on a shared id.

Two tests pin it: the three-Maze contamination produces zero groups, and a genuine same-film-different-parsed-title pair on a shared id + year still groups.

Note: the underlying metadata is still wrong — two of those three films carry an external ID that isn't theirs. That is a separate identification issue; this change stops the bad ID from causing a false duplicate, it does not correct the ID.
