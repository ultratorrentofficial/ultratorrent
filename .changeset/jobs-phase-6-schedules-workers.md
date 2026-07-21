---
'@ultratorrent/backend': minor
'@ultratorrent/frontend': minor
---

Unified Jobs Center Phase 6 — schedules, workers & settings (honest, read-only).
Adds GET /api/jobs/{schedules,workers,settings}: a live inventory of the real
@Interval/@Cron schedulers (from Nest's SchedulerRegistry, mapped to modules), the
single in-process worker represented honestly, and the engine's active tuning
constants (single source: job-constants) — all read-only, no fabricated data or
fake controls. Frontend adds the Schedules/Workers/Settings tabs + pages with full
en-US/es-PR i18n.
