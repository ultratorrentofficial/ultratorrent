---
'@ultratorrent/backend': patch
---

fix(indexers): an apostrophe in a show title no longer makes it un-grabbable

Release names drop apostrophes — `Grey's Anatomy` ships as `Greys.Anatomy.S21E07` —
but the apostrophe was carried straight through to both the indexer query and the
title match, and it broke each of them independently:

- **The search found nothing.** `q` went to Torznab verbatim. Measured against a live
  Prowlarr/EZTV: `q="Grey's Anatomy"` → **0 results**, `q="Greys Anatomy"` → **18**.
  It returned `no_results` rather than an error, so it never looked like a fault.
- **The match rejected what it did find.** `normalize()` treated the apostrophe as a
  separator, giving `grey s anatomy`, which is not token-equal to the `greys anatomy`
  on the wire. So even a release that came back was discarded.

Both are fixed: apostrophes are now elided (not spaced) in `normalize()`, and the
indexer query is sanitised through `toSearchTerm()`.

This was silently costing 20 monitored shows every grab — Law & Order: SVU (600 wanted
episodes), Grey's Anatomy (467), Marvel's Agents of S.H.I.E.L.D (136), Schitt's Creek,
Happy's Place — roughly **1,880 wanted episodes with zero grabs between them**.

Only the apostrophe is stripped. Ampersands, dots and colons are harmless —
`q="Law & Order Special Victims Unit"` returns results unchanged — so removing them
too would risk dropping a real token for no gain.
