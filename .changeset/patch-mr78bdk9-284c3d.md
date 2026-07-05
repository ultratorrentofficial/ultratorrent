---
"ultratorrent": patch
---

fix(files): translate mkdir failures (EACCES/EROFS/ENOSPC/…) into actionable errors instead of an opaque 500 when creating a directory
