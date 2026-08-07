---
"ultratorrent": patch
---

The [dupN] restore preview no longer promises a rename it cannot perform. It checked only that the destination name was free, so a stale index row pointing at a file no longer on disk previewed as 'restore' and then reported 'nothing was renamed'. Both paths now verify the source exists and report it identically.
