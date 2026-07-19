---
"ultratorrent": patch
---

Fix every episode in a tinyMediaManager-tagged folder being skipped as "invalid naming template".

The `{tvdb-396564}` tag those tools append broke the renamer in a second, more severe way than the canonical-key mismatch fixed alongside it. `{Series Title}` rendered the tag verbatim into the destination path, and its braces tripped `isRenderedPathSafe` — a brace legitimately means an unresolved token, since that guard exists to stop a corrupt template clobbering files onto a literal `{`. So the whole folder was skipped and left untouched: 13 silently un-renameable files on the live library, reported only as a warning per file.

Titles are now stripped of the tag before they reach a token, so `4400 (2021) {tvdb-396564}` renders as `4400/Season 1/4400 - S01E01.mp4`. `stripProviderIdTag` moved from `series-grouping` into `media-renamer` — `series-grouping` already imports from that module, so keeping the helper there would have closed an import cycle.
