---
"ultratorrent": minor
---

RSS: TV show airing-status awareness (Phase 3a, scheduled background refresh). New RssShowStatusRefreshService re-resolves cached show statuses on a per-status cadence (active 24h / hiatus 7d / ended·canceled 30d / unknown 3d); on a status change it updates every rule that snapshots the show, emits rss.show_status.changed (+ rss.show.ended/canceled/became_active), and audits it — it never disables a rule. New WS events + manifest scheduler job. Automation triggers/actions and remaining frontend badge placements are Phase 3b.
