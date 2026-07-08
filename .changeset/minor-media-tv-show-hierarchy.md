---
"ultratorrent": minor
---

Media library TV browsing is now a proper Show → Season → Episode hierarchy. The `/media/series` show list groups episodes by their show FOLDER (falling back to title only for files at a library root) instead of by `MediaItem.title`, so a folder of episode-titled files reads as one show rather than one "show" per episode — no more loose episodes at the top level. A new `GET /media/series/episodes?key=…` returns a show's episodes already grouped into ordered seasons (specials last) with per-season posters (`season_poster` artwork, falling back to the show poster). The browser's collapsible tree consumes these: click a show to expand its seasons, a season to expand its episodes, an episode to open its detail. Movies are unaffected (they stay a flat list).
