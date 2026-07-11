---
"ultratorrent": patch
---

Library shows with no IMDb id now self-heal from the local IMDb catalogue. A show identified against TVDB (or never identified) had no tconst, which made it unmonitorable in the add-from-library picker and invisible to missing-episode scans. The picker now heals a bounded batch in the background on load, and `POST /media-acquisition/watchlist/library/resolve-imdb` runs the whole backlog in one pass; resolved ids are written onto the show's items, so the fix is permanent and also repairs owned-episode matching.

The title matching moved into a shared `ImdbSeriesResolver`, which indexes the catalogue's TV slice (~325k rows) in memory instead of matching with SQL `ILIKE` — no index can serve that, so every lookup was a parallel seq scan of all 8.9M titles (~8s **per show**). One 7s load now answers every show at ~7ms each, which also speeds up the existing missing-episode scan self-heal that paid the same cost.

The resolver also copes with folder names the renamer never touched, trying the name as-is first and only then progressively cleaned variants: a scene release (`Ahsoka.S01E03.WEB.x264-TORRENTGALAXY[TGx]`), a season pack whose season token the release parser leaves in the title (`Criminal.Minds.S18…` → "Criminal Minds S18"), a tracker stamp (`www.UIndex.org - …`), a country qualifier IMDb doesn't carry (`The Office (US)` — the year then picks the right version), and a studio brand it doesn't carry either (`Marvel's The Punisher` is catalogued as plain "The Punisher"). Result on the two production hosts: **654/654** and **211/212** shows now monitorable.
