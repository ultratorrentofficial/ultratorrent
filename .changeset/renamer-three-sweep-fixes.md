---
"ultratorrent": patch
---

Three fixes found by previewing renames across the whole TV library.

**Hidden directories are no longer walked.** `gatherPathFiles` descended into dot-directories, so tinyMediaManager's `.deletedByTMM` trash and QNAP's `.@__thumb` caches were planned as real media — `.@__thumb/Season 2/default9-1-1 - S02E14.mkv` was a genuine plan item, and `.deletedByTMM` alone raised 38 misfiled-show warnings. Renaming a file out of another tool's trash also resurrects a deleted episode into the library.

**The misfiled-show warning no longer fires on correctly-filed files.** It compared the file's immediate show folder, but `showFolderRoot` climbs past `Season NN` and not past a release directory, so `FBI International (2021)/FBI.International.S01E01…[TGx]/file.mkv` looked misfiled. 27 of the 36 warnings on the live library were this false positive. The check now asks whether the file sits anywhere beneath its series' known folder, with segment-aware matching so `/FBI` never matches `/FBI2`.

**Provider id tags are stripped from the canonical show key.** tinyMediaManager, Jellyfin and Emby write `Show (2021) {tvdb-396564}`. The tag survived `normalize` as ordinary words and pushed the year out of trailing position, so the folder `4400 (2021) {tvdb-396564}` keyed as `"4400 2021 tvdb 396564"` while the episodes inside keyed as `"4400"` — they never matched, and all 40 episodes of that show lost their titles. `showCanonicalKey` now drops `{tvdb-…}` / `{tmdb-…}` / `[imdbid-…]` before normalising. This key is a shared identity gate (scanner, watchlist, missing-episode sweep, duplicate detection), so the renamer additionally computes keys fresh from the show title rather than reading the stored `canonicalKey` column — that column is only rewritten by a scan, and the fix would otherwise not take effect until every library was rescanned.
