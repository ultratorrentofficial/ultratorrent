---
"ultratorrent": patch
---

Rename preview no longer renames a show folder after an unrelated film. A library show folder (`Title (YYYY)`) parses as a movie — a bare year, no SxxEyy — so the renamer looked it up in TMDB's movie search and preferred that film's year over the folder's own. `All American (2018)` drew "American Dreamer" (2019) and every episode was planned into a new `All American (2019)/`; 664 of 666 folders on a live library carry a year and a quarter of a sample drew a film with a different one. A batch whose files name episodes is now identified by its own folder name, with no provider lookup at all. Separately, `TmdbMetadataProvider.lookup` now verifies its movie hit with the same title+year gate `fetchDetails` has used since the Maze Runner fix, instead of taking `results[0]`.
