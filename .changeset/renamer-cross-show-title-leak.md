---
"ultratorrent": patch
---

Fix the per-episode title lookup handing one show another show's episode title. The map was keyed on `"{season}-{episode}"` alone, but a folder can hold more than one series — which is exactly how `FBI (2018)` accumulated FBI International files. `FBI International S02E13` was therefore named `Payback`, the title of `FBI S02E13`, and the batch `meta.seriesTitle` stamped the batch's series name onto it as well. A wrong name is worse than a missing one, because a rename writes it to disk.

Per-episode metadata is now resolved through `RenameContext.episodeMetaFor(seriesTitle, season, episode)`, keyed by series as well as episode, and it carries the library's own show title so a second show in the folder is named for *its* series. Separately, when a file's parsed series differs from the batch's, the batch `seriesTitle` is dropped for that file so it cannot be renamed into the wrong show.
