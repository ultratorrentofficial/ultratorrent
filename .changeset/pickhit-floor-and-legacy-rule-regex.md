---
'@ultratorrent/backend': patch
---

A show-status lookup no longer invents an answer, and a legacy RSS rule's regex no longer
disappears on the missing-episode path.

**Show-status similarity floor.** A provider's search is fuzzy: ask TMDB about a show it
has never heard of and it still answers, ranked by its own relevance rather than by
whether the title is the one you asked for. `pickHit()` fell back to `hits[0]` whenever
nothing matched exactly, so a miss did not yield "unknown" — it yielded *a different
show*, which was then cached under this title and written onto the rule as its airing
status. A non-exact hit must now clear a title-similarity floor; when nothing does, the
lookup falls through to the next provider and ultimately reports `unknown`. An honest
"unknown" is recoverable, a confident wrong answer is not. Exact matches, and the year
tie-break between same-titled shows, are unchanged.

**Legacy rule regex.** An RSS rule filters in one of two ways, and the feed path picks
exactly one: its match candidates if it has any, else its `includeRegex`/`excludeRegex`.
`rssCandidates()` only ever read the candidates, so a rule that filters purely by regex
contributed **nothing** to missing-episode acquisition: it resolved to an empty list,
fell through to the auto-download profiles and then the global defaults, and an
operator's `excludeRegex` — an explicit "never grab this" — was silently discarded along
with the rule that was supposed to filter the show. Such a rule is now expressed as a
single candidate (matching the feed path's own fallback), and the match engine gains an
`excludeRegex` on a candidate, since `excludedTerms` are plain substrings and cannot
represent one. A rule with neither candidates nor regex still yields nothing rather than
a match-everything candidate, and an unparseable regex excludes nothing rather than
everything.
