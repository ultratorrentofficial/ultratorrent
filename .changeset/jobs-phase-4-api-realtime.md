---
'@ultratorrent/backend': minor
'@ultratorrent/shared': minor
---

Unified Jobs Center Phase 4 — REST API + real-time channel. Adds fifteen jobs.*
RBAC permissions; the /api/jobs/* Jobs Center API (overview, catalog, paginated
list, detail, events, children, single-job cancel/pause/resume/retry/rerun, and
bulk cancel/retry/rerun with a partial-result envelope) reading platform_jobs —
authenticated, DTO-validated, pagination-capped, audited, RBAC-scoped per job
(view never exposes inputData/checkpoint; actions require the job's own
permission). Adds a unified, permission-scoped jobs.* WebSocket channel emitted
across the job lifecycle. Legacy GET /api/jobs aggregator retained.
