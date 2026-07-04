---
"ultratorrent": patch
---

The Media Manager media list is now a rich, poster-forward view instead of a bare table. Each row shows the poster artwork, title/year, rating, media type + match badges, season/episode, certification, runtime, overview, genres, technical specs from the primary file (resolution/codec/HDR/audio/size/container), and IMDb/TMDB external-id links; rows link to the item detail page. Backed by the list endpoint now eagerly loading metadata/artwork(poster)/externalIds relations, and a new GET /api/media/artwork/:artworkId/image endpoint (MEDIA_MANAGER_VIEW) that streams locally-stored artwork so it renders in the browser (remote provider artwork still loads from its url).
