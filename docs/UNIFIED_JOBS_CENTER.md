# Unified Jobs Center

UltraTorrent's operational control plane for **all asynchronous work** — one place to
see what's running, waiting, scheduled, or failed, why it failed, and what to do next.
Built by generalizing the platform's existing job infrastructure behind one contract, not
by bolting on a competing queue.

- **The design & review:** [UNIFIED_JOBS_CENTER_ARCHITECTURE_REVIEW.md](UNIFIED_JOBS_CENTER_ARCHITECTURE_REVIEW.md)
- **Architecture:** [JOB_ARCHITECTURE.md](JOB_ARCHITECTURE.md) · **Lifecycle:** [JOB_LIFECYCLE.md](JOB_LIFECYCLE.md)
- **Write a handler:** [JOB_HANDLER_DEVELOPMENT.md](JOB_HANDLER_DEVELOPMENT.md) · **Schedules:** [JOB_SCHEDULING.md](JOB_SCHEDULING.md)
- **Security:** [JOB_SECURITY.md](JOB_SECURITY.md)

---

## What it is

Every long-running operation — a library scan, duplicate detection, a subtitle download,
an analytics import, a notification batch — is a **platform job**: a normalized
`platform_jobs` record with a status, progress, structured events, relationships, and
sanitized inputs/results. The Jobs Center reads and controls these through one RBAC-scoped
API and a live UI in the **System** workspace at **`/jobs`**.

It is a **core platform service**, not a Media Manager page renamed "Jobs": modules
*register* their job types and hand execution to the platform; the Jobs Center itself
contains no module-specific business logic.

## For operators — what you can do

From `/jobs`:

- **Overview** — real metrics: running / queued / waiting / scheduled / failed, completed &
  failed today, and today's success rate (never fabricated).
- **Status lists** (All / Running / Queued / Waiting & Blocked / Scheduled / Failed /
  Completed / Cancelled) — one shared, filterable, server-paginated table with search.
- **Per-job actions** — Cancel, Pause, Resume, Retry, Rerun — shown **only** when the
  handler supports them and you're authorized (the server re-checks). Bulk versions report
  partial results.
- **Job detail** — status/progress, sanitized error, parent/child relationships, input &
  result summaries, and a live **event timeline**.
- **Scheduled tasks / Workers / Settings** — an honest, read-only view of the real
  schedulers, the single in-process worker, and the engine's active tuning values.

Everything updates **live** (permission-scoped `jobs.*` WebSocket channel) with a polling
fallback — no manual refresh.

## Statuses

`scheduled · queued · waiting · blocked · running · pausing · paused · retrying ·
completed · completed_with_warnings · failed · cancelling · cancelled · skipped · expired`

Transitions are **server-enforced** by a state machine ([JOB_LIFECYCLE.md](JOB_LIFECYCLE.md));
illegal transitions are rejected. A job that was cancelled is **cancelled**, never reported
as failed.

## Reliability

- **Retry** — retryable failures back off exponentially up to `maxAttempts`; a
  non-retryable error (or a non-retryable job type — e.g. a destructive operation) is never
  auto-retried.
- **Pause/Resume** — only for handlers that persist a real checkpoint; resume re-executes
  from it. No pause button appears where it can't work.
- **Rerun** — creates a new linked job from the original's input, never mutating the original.
- **Stalled / worker-lost** — a running job that stops heart-beating is flagged **stalled**
  (advisory); a process that died mid-job has its orphans reconciled at boot. The single
  in-process worker is represented honestly — no fabricated pool.
- **Retention** — finished jobs are pruned after a week, failed jobs kept ~30 days (longer,
  for diagnosis). Cleanup **is itself a registered, observable job** (`jobs.retention_cleanup`).

## RBAC

Fifteen `jobs.*` permissions gate the Center (`jobs.view`, `jobs.view_all`,
`jobs.view_events`, `jobs.cancel/pause/resume/retry/rerun`, `jobs.bulk_manage`,
`jobs.manage_schedules`, `jobs.view_workers`, `jobs.manage_settings`, `jobs.admin`, …).

Two guarantees:
- **Visibility** — `jobs.view` shows only jobs you may see (public, your own, ungated, or
  gated by a permission you hold). `jobs.view_all` widens this but **never** bypasses
  field-level redaction (`inputData`/`checkpoint` are never exposed).
- **Actions** additionally require the **job's own permission** — you cannot cancel or retry
  a job you could not have started. All actions are audited.

## Integration

- **Notification Center** — jobs publish `job.failed` / `job.stalled` /
  `job.completed_with_warnings` domain events; build notification rules on them.
- **Automation** — `job.*` triggers ("When a job fails/stalls/…") feed the rule engine via a
  decoupled bridge.
- **Command palette** — `Ctrl+K` → Open Jobs Center / View running / View failed / View
  scheduled (RBAC-gated).

## For developers

A module makes an operation a platform job in two steps: **register** a `JobDefinition` +
`JobHandler`, then **enqueue** it via `PlatformJobService`. The existing
`MediaProcessingQueueService` / `SubtitleQueueService` are thin **adapters** over the
platform engine, so their callers were untouched by the migration. See
[JOB_HANDLER_DEVELOPMENT.md](JOB_HANDLER_DEVELOPMENT.md).

## API (summary)

`GET /api/jobs/overview · /catalog · /list · /:id · /:id/events · /:id/children` ·
`POST /api/jobs/:id/{cancel,pause,resume,retry,rerun}` · `POST /api/jobs/bulk/{cancel,retry,rerun}` ·
`GET /api/jobs/{schedules,workers,settings}`. All authenticated, DTO-validated,
pagination-capped, RBAC-scoped, audited. Full reference in [API.md](API.md).

The legacy read-only aggregator `GET /api/jobs` remains for the workspace Jobs widgets.

---

See also: [ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](SECURITY.md) ·
[NAVIGATION.md](NAVIGATION.md)
