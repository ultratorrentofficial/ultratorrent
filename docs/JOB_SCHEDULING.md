# Job Scheduling

How UltraTorrent's scheduled/background work relates to the Unified Jobs Center. See
[UNIFIED_JOBS_CENTER.md](UNIFIED_JOBS_CENTER.md).

## Today: `@nestjs/schedule` intervals

Background schedulers are `@Interval`-decorated methods across the modules (RSS polling,
torrent sync, notification delivery, media library periodic scan, subtitle missing-scan,
media-server session poll, IMDb dataset auto-update, and more; there are no `@Cron` jobs).
Each module manifest also declares logical `schedulerJobs` names.

The Jobs Center's **Scheduled Tasks** page (`GET /api/jobs/schedules`,
`PlatformSchedulesService`) reads these live from Nest's `SchedulerRegistry` and presents an
**honest, read-only inventory**: name, owning module, trigger type, and interval. It does
**not** fabricate next-run/last-run or enable/disable/run-now controls the current interval
model can't back — those require wrapping each scheduler into the platform (a future step),
and the design forbids fake buttons.

## Scheduled work as observable jobs

The pattern for *new* scheduled work — and the model schedulers should migrate toward — is a
scheduler that **enqueues a registered platform job**, so each run is observable in the Jobs
Center with its own lifecycle, progress, and result. The **retention cleanup** already works
this way:

```ts
@Interval('platform_job_retention_cleanup', RETENTION_SCAN_INTERVAL_MS)
async scheduleCleanup() {
  await this.jobs.runDetached({
    type: 'jobs.retention_cleanup',
    input: {},
    source: 'scheduled',
    idempotencyKey: 'jobs.retention_cleanup', // one active run at a time
  });
}
```

A job created this way carries `sourceType: 'scheduled'` and a `scheduleId` link, so the UI
can attribute it to its schedule.

## Retention

The observable `jobs.retention_cleanup` job prunes terminal jobs: finished
(completed/cancelled/skipped/expired) after `RETENTION_DONE_DAYS` (7), failed after
`RETENTION_FAILED_DAYS` (30 — kept longer for diagnosis). `platform_job_events` cascade-delete
with their job. Values live in one place (`platform/job-constants.ts`) and are reported
read-only by `GET /api/jobs/settings`.

## Future: managed schedules

The `platform_jobs.scheduleId` column and the schedule-registry shape are ready for a managed
schedule model (enable/disable/run-now/history, next/last run, overlap policy). Delivering it
means wrapping the interval methods so each is a registered, controllable schedule — done
incrementally, never faked before it works.
