---
"ultratorrent": patch
---

Media Manager: two identification edge-case fixes. (1) Numeric-title/year collision — a movie whose title is a 4-digit year (e.g. '1917 (2019)') no longer parses the leading number as the year and collapses the title to empty; the parser now prefers a parenthesized (YYYY) release year, falls back to the last year candidate, and never treats a year at position 0 as the title boundary. (2) The library scanner now skips hidden/dot directories (tinyMediaManager '.deletedByTMM'/'.actors', macOS '.Trashes') and Synology '@eaDir' thumbnail folders, which were surfacing phantom unmatchable items
