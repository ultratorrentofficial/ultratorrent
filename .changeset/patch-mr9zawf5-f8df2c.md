---
"ultratorrent": patch
---

Duplicate detection: separate UNIDENTIFIED episodes (null season/episode columns) whose filename still carries the SxxEyy marker and that share a series-level external id. The episode discriminator now derives season/episode from the title when the structured columns are null (and falls back to the title for any other non-movie without markers), so e.g. 248 Chicago P.D. episodes sharing one IMDb series id no longer collapse into a single duplicate group. Two files of the same episode still group.
