---
"ultratorrent": patch
---

Media artwork: import show/season-level art from parent directories for TV. importLocal only scanned each media file's own directory, so a TV episode in 'Show/Season 01/' never picked up the show-level poster.jpg/fanart.jpg/banner.jpg (which live in the show root, a level up) — episodes ended up with only their per-episode '<episode>-thumb.jpg' screenshot, so the grouped TV browser showed no poster and the artwork tab showed the episode still. importLocal now scans each file's directory AND its ancestors up to the library root, and classifies 'seasonNN-poster' as a season_poster (with season number). The scanner's skip-if-enriched check now requires a poster (not just any artwork) so thumbnail-only items get re-processed on the next scan
