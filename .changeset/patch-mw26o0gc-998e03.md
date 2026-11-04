---
"ultratorrent": patch
---

Discovery evaluation: thread the evaluation's clock through to the premiere check instead of reading the real one, so importing an unreleased series from review no longer scans it for missing episodes. Also re-date a TMDB provider fixture relative to the clock; as a literal it walked out of the window it was asserted against.
