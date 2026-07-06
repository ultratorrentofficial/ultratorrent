---
"ultratorrent": patch
---

Media artwork: display each artwork type at its natural aspect ratio. The detail Artwork tab rendered every type in a 2:3 poster frame with object-cover, so wide banners (and fanart/logos/clearart) were cropped to a vertical slice and looked wrong. MediaPoster gained a fit prop ('cover' default / 'contain'); the Artwork tab now frames posters 2:3, banners 16:3, fanart/thumbnails 16:9, and shows banners + transparent logos/clearart with object-contain (no crop)
