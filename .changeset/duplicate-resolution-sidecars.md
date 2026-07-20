---
"ultratorrent": patch
---

Duplicate cleanup now handles sidecars instead of orphaning them — and never deletes a subtitle that exists nowhere else.

Found by previewing a real group before running anything: the plan kept a 1080p release and trashed an organised copy, but planned only the `.mp4`. Beside it sat `…- Jane Foster.nfo`, `…-thumb.jpg` and `…- Jane Foster.por.srt`. Resolving would have left all three behind — the metadata describing a file that no longer existed, and **the only Portuguese subtitle for that episode in the library**, now attached to a deleted video while the copy being kept had no subtitle at all.

Sidecars are now matched **structurally** — basename plus an optional `-`/`.` suffix — the same rule the renamer's sidecar pass uses, so the two agree about what belongs to what. That rule is also what keeps show-level files out: `poster.jpg`, `fanart.jpg`, `tvshow.nfo`, `season01-poster.jpg` and `theme.mp3` are named after the *folder*, not the episode, so they never match and are never touched. A longer-named neighbour (`drop2.mp4` beside `drop.mp4`) is likewise not a sidecar.

Metadata sidecars are trashed with the video they describe, and their bytes count toward the reclaim estimate. **Subtitles are treated as content, not metadata**: one whose language the keeper already has is trashed as redundant, but one that exists only beside the copy being removed is neither deleted nor silently orphaned — it is left in place and reported in `orphanedSubtitles` with a preview warning naming the file, so the operator can decide. Deleting it would be data loss; saying nothing would be a silent orphan.

6 new tests cover the sidecar rules, show-level exclusion, the prefix-collision case, and both subtitle paths.
