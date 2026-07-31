---
"ultratorrent": patch
---

Missing-episode search now retries a title without its punctuation, then with the show's year, and searches aliases instead of only validating against them. Indexers tokenize a query, so a stored '9-1-1' is not the '9 1 1' their index holds — on synoplex all 113 wanted episodes of that show sat at no_results while its own folder was full of matching releases. The first query is unchanged and the loop stops at the first one with results, so a show that already worked still issues exactly one search; a total indexer outage stops the widening immediately and is still recorded as failed rather than no_results.
