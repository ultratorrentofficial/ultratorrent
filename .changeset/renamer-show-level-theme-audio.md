---
"ultratorrent": patch
---

Stop the renamer moving a show's `theme.mp3` into a season folder.

Plex, Jellyfin and Emby all read `theme.mp3` in a show folder as that show's theme tune, the same way they read `poster.jpg` and `fanart.jpg` as its artwork. The sidecar pass already documents it as show-level and leaves it alone — but it never reached that pass: `AUDIO_EXT` classifies it as `music`, so it was planned as a **primary** in the first pass. With no season or episode to render, it came out as `Season/4400 - SE.mp3`. That was a real plan item on the live library; applying it would have moved the theme into a bogus season folder and broken it for every media server.

Show-level audio (`theme`, `theme-music`, `backdrop`, `background`, with an optional numeric suffix) is now skipped as a primary. The check is guarded on the batch containing video: beside episodes, `theme.mp3` is a show's theme, but in a music folder with no video in sight it is an ordinary track and must still be renamed.
