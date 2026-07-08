---
"ultratorrent": patch
---

Missing-episode auto-download: resolve the save path with a layered fallback so grabs land in the show's folder even when the watchlist item isn't linked to an RSS rule (the common case). Falls back from the linked rule → an RSS rule matched by show title → the show's existing library folder → `<TV library>/<Title> (Year)`, only using the engine default `/downloads` when none resolve.
