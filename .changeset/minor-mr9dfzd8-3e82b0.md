---
"ultratorrent": minor
---

RSS feed history: add filtering. The history view can now be filtered by status (Downloaded / Matched / Seen) via clickable summary tiles and by a case-insensitive release-title search. GET /rss/feeds/:id/history gains optional status + search query params; pagination total reflects the active filter while the count tiles stay scoped to the search (never the status) so they keep the full breakdown and double as toggles. i18n en-US + es-PR
