---
"ultratorrent": patch
---

Fix the Renamer producing one destination for every file in a show folder, reported as a chain of duplicate-destination warnings.

`buildRenamePlan` derived season, episode, title and kind from a single `parseTorrentName(ctx.sourceName)` call, then reused that one result for every file in the batch. `sourceName` describes the batch — for a library preview it is the show folder, e.g. `FBI (2018)`, which carries no `SxxEyy`. So `season` and `episode` were `undefined` for all 89 files in that folder, the Plex template rendered them as empty strings, and every episode collapsed onto `/downloads/TV/TV_Shows/FBI/Season/FBI - SE.mkv`. The plan came back as one long chain of `Duplicate destination …` warnings, each file duplicating its predecessor.

A second effect compounded it: with no episode markers the batch parse classified the folder as a *movie*, but a library `template` override is applied regardless of kind, so the TV template was still used — while the `kind === 'tv' ? 1 : undefined` season fallback in `buildTokens` never fired.

Identity is now resolved **per file**, from the file's own basename, falling back field by field to the batch parse. The fallback preserves the existing single-file behaviour: a torrent named `Show.S01E05.1080p` whose inner file is `video.mkv` still takes its episode and title from the release name, and a file that names its episode but not its show still inherits the title. `kind`, the selected template and the multi-episode range are derived per file for the same reason. The plan's top-level `parsed` remains the batch identity, since it describes the request as a whole.

Note this does not touch identification: the planner still reads identity from names, never from `media_items.season`/`episode`, which were correctly populated for all 209 FBI rows throughout.
