---
"ultratorrent": minor
---

The **Media Manager** can now fetch artwork online. A new `ArtworkProvider` seam ships with a `TmdbArtworkProvider` that resolves an item's TMDB id and imports the best **poster** and **fanart** from TMDB. Downloads reuse the same magic-byte + 10 MB validation as custom uploads, are restricted to the TMDB image host (SSRF guard), record provenance (`source: 'tmdb'`), and are idempotent per image. Auto-imported art only auto-selects when the item has no art of that type yet, so operator uploads keep precedence. The `media_fetch_artwork` automation action now performs the fetch (falling back to reporting missing art when no TMDB key or match is configured), operators can trigger it manually via `POST /api/media/items/:id/artwork/import`, and the Media Detail artwork panel gains a **Fetch from provider** button (en-US + es-PR).
