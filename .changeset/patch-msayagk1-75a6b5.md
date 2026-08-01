---
"ultratorrent": patch
---

The movie identity repair can now read a scene-style folder. Its parser demanded `Title (YYYY)` at the very END, so `Midas Man (2024) [BLURAY] [1080p] [YTS.MX]` yielded the whole string as a title and no year — and since the repair CLEARS an id it cannot verify, the folders it most needed to read were the ones it read worst, and a good film would have lost its identity over a suffix. Bracketed scene tags and Plex/Emby `{tvdb-…}`/`{edition-…}` markers are stripped, the first `(YYYY)` wins wherever it sits, and bare-year and dot-separated release names are token-walked. `Blade Runner 2049` stays a title.
