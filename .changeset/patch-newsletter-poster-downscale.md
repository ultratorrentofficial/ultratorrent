---
"ultratorrent": patch
---

Downscale newsletter poster attachments so they actually render. Full-size library posters run 250KB–1MB+, but the newsletter's inline size cap (MAX_POSTER_BYTES, 500KB) silently dropped anything larger — so most show/movie cards fell back to the gradient placeholder even after their poster was found (a real test send showed 4 correct show cards but only 1 poster, 3 placeholders). `loadPoster()` now resizes each poster to a small JPEG (240px wide, via sharp) before attaching — the card slot is only ~84–120px, so a full-resolution poster was massive overkill. Real posters drop from 250KB–1.1MB to ~20KB, so every card gets its artwork and a full 30-poster email stays well under 1MB. Falls back to the original image (if within the cap) when resizing fails.
