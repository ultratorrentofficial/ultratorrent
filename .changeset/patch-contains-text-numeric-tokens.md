---
"ultratorrent": patch
---

RSS match engine: `contains_text` now matches numeric pattern words against whole title tokens instead of loose substrings. A hyphenated numeric show title like "9-1-1" normalizes to the words "9","1","1", which as substrings appear inside almost every release ("S09E07", "1080p", …) — dissolving the title constraint and causing the rule to grab unrelated shows. Numeric words now require a standalone token match; alphabetic words keep substring matching.
