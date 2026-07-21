---
'@ultratorrent/backend': minor
---

Unified Jobs Center Phase 9 — retention, docs & hardening (feature complete).
Retention/cleanup is now a real, observable job: a JobRetentionService @Interval
enqueues a registered jobs.retention_cleanup job that prunes terminal rows
(finished after 7d, failed kept 30d; events cascade). New docs: UNIFIED_JOBS_CENTER,
JOB_ARCHITECTURE, JOB_LIFECYCLE, JOB_HANDLER_DEVELOPMENT, JOB_SCHEDULING, JOB_SECURITY;
SECURITY.md + README updated. Closes the 9-phase Unified Jobs Center.
