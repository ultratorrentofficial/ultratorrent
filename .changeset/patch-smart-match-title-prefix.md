---
"ultratorrent": patch
---

Fix `smart_episode_match`/`smart_movie_match` over-matching. The title check used set-membership (every pattern token appears *somewhere* in the release's show-title region), so a rule for **"Rise"** grabbed `The.Pendragon.Cycle.Rise.of.the.Merlin.S01E04…`, and **"9-1-1"** grabbed the **9-1-1 Lone Star** spinoff. The pattern must now **equal the release's pure title** — the show-region tokens up to the first release year or quality/format token. This rejects both mid-title bleed ("Rise") and prefix-spinoff bleed ("9-1-1 Lone Star" ≠ "9-1-1"), while still matching `9-1-1`, `9-1-1 2018`, `The.Equalizer.2021.S05E05` (leading article ignored, trailing year/quality stripped), and letting a "9-1-1 Lone Star" rule match Lone Star. A leading year is kept as a title (`2020`). `contains_text` (deliberately loose subset matching) is unchanged.
