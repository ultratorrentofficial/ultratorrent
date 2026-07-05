---
"ultratorrent": minor
---

Library scans now import existing sidecar artwork and metadata. When a scanned media directory already contains Kodi/Jellyfin-style artwork (poster.jpg, fanart.jpg, folder.jpg, banner, logo, clearart, landscape/thumb, and <name>-poster.jpg style suffixes) the files are imported in place (referenced, not copied; source 'local', auto-selected one per type). Adjacent .nfo files (<basename>.nfo, movie.nfo, tvshow.nfo) are parsed for title/overview/year/runtime/rating/genres/studios/certification/original-title/directors/writers/cast and external ids (imdbid/tmdbid/tvdbid or Kodi <uniqueid>), filling metadata gaps without clobbering provider data and recording external ids + a MediaNfoFile. Runs per item at the end of a scan, skips already-enriched items, is idempotent, and reports artworkImported/metadataImported counts in the scan summary + toast.
