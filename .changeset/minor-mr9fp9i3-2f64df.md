---
"ultratorrent": patch
---

Media artwork: cached poster thumbnails for fast grid rendering. Full-size posters (often several MB) were streamed for every grid cell via a per-item authenticated fetch, so lists showed the stub placeholder while images slowly loaded. New MediaArtworkService.thumbnail() lazily generates a small WebP thumbnail (width 400, via sharp) on first request and caches it under .ultratorrent/media-artwork/thumbs/ (a dot-dir the scanner ignores), regenerating when the source changes and falling back to the original if resizing fails. Served via GET /media/artwork/:id/image?thumb=1. MediaPoster now requests thumbnails by default (grids/cards) with a size='full' opt-out; adds the sharp dependency
