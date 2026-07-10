---
"ultratorrent": patch
---

Missing episodes: the automatic show-identification now also matches titles that differ only by punctuation. Shows added from RSS rules often have punctuation stripped from their names (e.g. "FBI Most Wanted" vs "FBI: Most Wanted", "Chicago PD" vs "Chicago P.D."), which previously failed to resolve and left the show scanning to nothing. These now self-heal to the correct IMDb series on the next scan.
