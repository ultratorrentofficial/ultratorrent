---
'@ultratorrent/backend': minor
---

Unified Jobs Center Phase 3 — reliability controls. Adds retry (exponential
backoff up to maxAttempts, walking the real state machine; JobNonRetryableError
and non-retryable job types are never auto-retried), rerun (a new linked job from
the original's persisted input), pause/resume (checkpoint-based, only for capable
handlers), and stall detection (a periodic advisory flag for running jobs with no
heartbeat; worker-loss reconciled at boot). Additive migration adds inputData.
