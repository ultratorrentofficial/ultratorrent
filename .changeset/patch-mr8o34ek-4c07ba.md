---
"ultratorrent": patch
---

Media Manager: fix cleanly-organised TV libraries scanning entirely as unmatched. Identification now recovers the series title from the parent folder when the episode filename omits it (Show/Season 01/S01E01.mkv), and confidence is weighted by identity signals (title + season/episode, or movie year) instead of the count of scene tokens (resolution/source/codec/group) — so a tidy personal library matches without needing release-scene junk in the filename
