---
"ultratorrent": patch
---

Fix the external-id URL going stale on a metadata re-fetch. media-metadata.service.ts's mediaExternalId upsert rewrote externalId in its update branch but not the url, which is derived from the id — so after a re-fetch corrected 'Ultimate Avengers' from tt0803093 to tt0491703, the 'View on IMDb' link still opened the sequel. The update branch now recomputes url alongside externalId via externalUrl().
