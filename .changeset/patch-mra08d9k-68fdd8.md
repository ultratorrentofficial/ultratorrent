---
"ultratorrent": patch
---

Duplicate detection: for TV/episodic items, scope the external_id key by show title + episode number. Provider external ids on episode rows are unreliable — series-level, and in some data the SAME id repeats across completely different shows — so external_id matching was grouping unrelated shows' first episodes together. External ids remain the strong entity-level signal for movies; for TV the title+episode scope prevents corrupt shared ids from collapsing distinct shows/episodes while still matching two files of the same episode.
