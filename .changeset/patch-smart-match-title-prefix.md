---
"ultratorrent": patch
---

Fix `smart_episode_match`/`smart_movie_match` over-matching a show/movie whose title merely *contains* the rule's title as a mid-title word. The title check anchored on set-membership (every pattern token appears somewhere in the release's show-title region), so a show rule for **"Rise"** grabbed `The.Pendragon.Cycle.Rise.of.the.Merlin.S01E04…`. The pattern must now be the **leading tokens** (a prefix) of the show-title region — the pattern IS the title, so it anchors at the start rather than matching a buried word. A trailing region year is still allowed and a leading article ("The") is ignored, so `The Equalizer` still matches `The.Equalizer.2021.S05E05`. `contains_text` (deliberately loose substring/subset matching) is unchanged.
