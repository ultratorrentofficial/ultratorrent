---
"ultratorrent": patch
---

Fix the recommendation engine treating a filename claim as a measurement — it would have trashed larger, genuinely-measured files on the strength of a name.

Resolution ranking fell back to the parsed `resolution` label when no measured height was present, and compared the result directly against other candidates' *measured* heights. Those are not the same quantity. A live library held `The.Equalizer.2021.S05E04.720p.HDTV.x265-MiNX.mkv` — no measured data at all, only `720p` in its name — beside an organised copy genuinely measured at **720×402**. The engine scored the label as `720`, the measurement as `402`, declared the **unmeasured** file the higher resolution, gave the group **90% confidence**, and marked it safe to clean automatically. **34 of 452 groups on that host were in this state**, each one recommending that a larger, measured file be trashed in favour of an unmeasured one.

The confidence calculation compounded it: it counted a candidate as "measured" if the parsed fallback produced a number, so a group with no measurements at all could still reach the top confidence band.

Resolution is now ranked on measured height only when **every** candidate was measured, on parsed labels only when **none** were, and not at all when the evidence is mixed — that case raises `incomparable_quality_evidence` and forces review. Confidence counts strictly measured candidates. Label-only groups may still be *ordered* by their labels, but are never auto-safe on that basis.

Found by inspecting what the engine actually decided about real groups rather than trusting a passing test suite; the 18 existing tests all passed against the broken behaviour because none of them mixed the two evidence kinds. Four regression tests now cover it, built from the exact live pair.
