---
"ultratorrent": minor
---

RSS: TV show airing-status awareness (Phase 1, backend). Pluggable TvShowStatusProvider (TMDB/IMDb/local) + normalization/recommendation, GET/POST /api/rss/show-status lookup endpoints, RSS-rule status snapshot + migration, save validation requiring allowInactiveShowMonitoring for ended/canceled shows, new rss.show_status.* permissions, WS events, and audit. Frontend + automation + background refresh are Phase 2/3.
