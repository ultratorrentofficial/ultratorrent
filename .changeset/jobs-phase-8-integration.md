---
'@ultratorrent/backend': minor
'@ultratorrent/frontend': minor
'@ultratorrent/shared': minor
---

Unified Jobs Center Phase 8 — platform integration. The frontend consumes the
permission-scoped jobs.* WebSocket channel (useJobsRealtime) for immediate live
updates; RBAC-gated Jobs Center command-palette entries; PlatformJobService
publishes job.failed/job.stalled/job.completed_with_warnings domain events for the
Notification Center; and four job.* automation triggers + a decoupled
JobAutomationBridge feed job events into the rule engine (Jobs Center never imports
automation).
