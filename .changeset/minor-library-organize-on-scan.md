---
"ultratorrent": minor
---

Library scan now organizes in-place files. For a library in `rename_in_place`/`rename_move` mode, a scan (and a new on-demand action) moves files loose in the show root into `Show/Season NN/` per the library template and applies junk cleanup (delete-globs, samples/extras, leftover .torrent, empty dirs — the existing cleanup rules), leaving link/copy/preview libraries untouched. New `POST /media/libraries/:id/organize` runs it standalone; `?dryRun=1` previews every move + delete without touching disk. Files already correctly placed are skipped, so a re-run is a near no-op.
