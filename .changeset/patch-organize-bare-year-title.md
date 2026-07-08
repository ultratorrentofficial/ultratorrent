---
"ultratorrent": patch
---

Fix TV episode releases whose name embeds a bare year (e.g. `Hijack.2023.S02E03`). The name parser now treats a bare four-digit year sitting immediately before the season/episode marker as the series year rather than part of the title, so it resolves to `Hijack` + year `2023` instead of `Hijack 2023`. This stops the show folder/title from forking into `Hijack 2023`, lets the provider lookup find the episode titles, and yields clean `Show - SxxEyy - Title` filenames. A leading year (`2020.S01E01`) and a year away from the marker (`Class of 2023 …`) are left intact.

Also fixes library **organize** (and organize-on-scan) silently holding every such show as `needsReview`: it now previews each move under the library's real mode (in-place destinations reuse the file's existing show folder) instead of mode `preview`, which mis-rooted the destination under the library and tripped the same-show-folder guard. A new `dryRun` flag on the rename request builds the faithful plan without touching disk.
