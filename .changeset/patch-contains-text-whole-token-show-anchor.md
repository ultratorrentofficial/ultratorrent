---
"ultratorrent": patch
---

RSS matching: `contains_text` and the smart match types now match title words as whole tokens against the release's show-title region (before the SxxEyy), not as substrings of the whole name. Fixes two false-match classes the single-char fix missed: multi-char substring bleed (a "The Boys" rule grabbing "…Cowboys…") and episode-title collisions (a "Severance" rule grabbing a Law & Order episode titled "Severance"). Quality/format words are still matched anywhere in the release.
