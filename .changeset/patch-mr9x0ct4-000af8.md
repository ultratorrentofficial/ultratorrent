---
"ultratorrent": patch
---

Fix duplicate detection grouping different episodes of a series as duplicates. The similar_filename key used only the show title, and the external_id key used the raw provider id — but providers store a series-level id (e.g. the same TVDB number) on every episode row, so both keys collapsed every episode of a show into one duplicate group. Both keys are now episode-scoped (season/episode appended for episodic items), so distinct episodes never group while two files of the same episode still do. Recomputed on the next Detect run.
