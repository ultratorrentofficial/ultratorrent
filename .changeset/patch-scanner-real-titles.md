---
"ultratorrent": patch
---

Library scanner: newly scanned episodes now store the real series title with their season and episode number, instead of the raw filename with no episode info. Previously a show could fragment into one entry per episode, owned-episode detection failed to match, and the "add from library" picker offered individual episodes as shows. Existing unidentified episodes are also corrected automatically on the next library scan.
