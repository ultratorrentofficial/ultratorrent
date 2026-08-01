---
"ultratorrent": patch
---

A completed torrent now reports its own file or folder, not just the directory it was saved into. qBittorrent has always returned content_path and rTorrent d.base_path; neither was mapped, so the completion event could only name the save path — which is shared. Ten episodes of one show report the same one, and on a live install a movie feed's save path held 3,305 entries, so importing from it meant importing everything in it rather than the release that just finished. The intake trigger now prefers contentPath and falls back to savePath, so an engine that cannot report the item behaves exactly as before.
