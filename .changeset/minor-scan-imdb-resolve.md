---
"ultratorrent": minor
---

Library scan now resolves a show's series IMDb id at scan time instead of leaving it null until a later heal pass. For a show folder whose episodes were never identified, the scan takes the id from an explicit `tvshow.nfo` entry first (authoritative — a human/tool stated it, so it can't be fooled by two same-named series), then falls back to matching the folder title (+year) against the local IMDb catalogue. The resolved id is written to the MediaShow row and backfilled onto the folder's still-null episodes (guarded so a matched/user-corrected item is never clobbered), so the field the rest of the system keys off — missing-episode sweeps, subtitle fingerprinting — is present immediately. Best-effort: a missing sidecar, an unresolvable title, or a resolver failure leaves the id null and the show is simply retried on the next scan.
