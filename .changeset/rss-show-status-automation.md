---
"ultratorrent": minor
---

RSS: TV show airing-status awareness (Phase 3b, automation triggers + actions). The automation engine gains an event-context path (evaluateEvent) with five RSS triggers (rule created for inactive show, show status changed, became active, ended, canceled) and four actions (refresh RSS show status, disable RSS rule, convert rule to backfill only, notify admin). RSS actions are delegated to a new RssAutomationActions provider; the show-status refresh job and the inactive-show rule save fire the triggers via ModuleRef. Remaining Phase 3b: frontend status-badge placements (Smart Match Builder / Match Preferences Builder / rule list + detail) and the RSS.md/MODULES.md docs.
