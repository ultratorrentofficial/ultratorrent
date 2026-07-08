---
"ultratorrent": minor
---

Rename/move can now clean up junk before moving files. A new global **Cleanup rules** setting (Media → Settings) lets you delete unwanted files during a rename in place / move: filename **glob patterns** (e.g. `YTS*.txt`, `RARBG.txt`, `www.*`, `*.jpg`) and a **subtitle language keep-list** (e.g. keep only `en`, `es` — other-language subs are deleted, untagged subs are kept). It can also prune the source folder if it's left empty and remove a leftover `.torrent`. Cleanup is opt-in and deliberately safe: it only runs for the two relocating modes (never copy/hardlink/symlink, where the source is your seeding copy), never deletes a primary video file even if a pattern would match it, is constrained to the allowed storage roots, never removes a library or root folder, and shows every deletion in the rename preview without touching disk.
