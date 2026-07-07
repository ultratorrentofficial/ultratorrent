---
"ultratorrent": patch
---

Media rename: rename_in_place now keeps files inside the show folder they already live in (the one the RSS rule set), only re-homing them into the correct season subfolder and fixing the filename — instead of relocating the whole series into a divergent, year-less Show/ folder. It reuses an existing season folder (Season 8 vs Season 08) and never re-derives the show-folder name, so a missing series year (or a rate-limited metadata lookup) can no longer fork a library. Series metadata continues to come from TMDB.
