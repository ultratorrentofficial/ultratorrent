---
'@ultratorrent/backend': minor
---

Unified Jobs Center Phase 2 — the platform job engine (core). Adds the normalized
`platform_jobs` + `platform_job_events` model (additive migration; legacy job
tables untouched), a server-enforced 15-status state machine, secret-redaction and
error-sanitization primitives, a `JobRegistry` (modules declare JobDefinition +
JobHandler), and `PlatformJobService` — the single writer of job rows/events with
a full JobExecutionContext (progress, structured events, warnings, heartbeat,
checkpoints, cooperative cancellation, idempotency). `JobsModule` is now @Global so
any module can register/enqueue without importing it. No producer changes yet.
