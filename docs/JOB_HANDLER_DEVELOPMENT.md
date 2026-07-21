# Writing a Job Handler

How to make a module operation a first-class platform job so it appears in the Unified Jobs
Center with lifecycle, progress, events, retry/cancel, and RBAC. See
[JOB_ARCHITECTURE.md](JOB_ARCHITECTURE.md) and [JOB_LIFECYCLE.md](JOB_LIFECYCLE.md).

## The two pieces

1. A **`JobDefinition`** — metadata: type, owning module/workspace, required permission,
   capabilities, and input validation/summary.
2. A **`JobHandler`** — `execute(input, ctx)` that performs the work through the
   `JobExecutionContext`.

Register both once (at module init) with the `@Global` `JobRegistry`, then enqueue via
`PlatformJobService`.

## Example

```ts
@Injectable()
export class ThumbnailModule implements OnModuleInit {
  constructor(private readonly registry: JobRegistry, private readonly jobs: PlatformJobService) {}

  onModuleInit() {
    this.registry.register(
      {
        type: 'media.thumbnail_generate',
        moduleKey: 'media_manager',
        workspaceKey: 'media',
        labelKey: 'jobs.type.thumbnail_generate',
        requiredPermission: PERMISSIONS.MEDIA_MANAGER_VIEW,
        capabilities: { cancellable: true, retryable: true, pausable: false, resumable: false },
        defaultMaxAttempts: 3,
        validateInput: (i) => thumbnailInputSchema.parse(i),   // throw on invalid
        summarizeInput: (i) => ({ itemId: i.itemId }),          // sanitized, small
      },
      { execute: (input, ctx) => this.run(input, ctx) },
    );
  }

  private async run(input: ThumbnailInput, ctx: JobExecutionContext) {
    const frames = await loadFrames(input.itemId);
    for (let i = 0; i < frames.length; i++) {
      ctx.signal.throwIfCancelled();                 // stop at a SAFE boundary only
      await renderThumbnail(frames[i]);
      await ctx.progress({ current: i + 1, total: frames.length, unit: 'frames' });
      await ctx.heartbeat();                          // so stall detection knows we're alive
    }
    ctx.metric('thumbnails', frames.length);
    return { resultSummary: { count: frames.length } };  // sanitized, persisted
  }
}

// enqueue it (returns immediately; progress/completion arrive over jobs.* WS):
await this.jobs.runDetached({ type: 'media.thumbnail_generate', input: { itemId }, createdById: user.id });
```

## The execution context

| Method | Use |
|--------|-----|
| `ctx.progress({percent \| current/total, unit, phase, messageKey})` | Report progress (DB write throttled; WS more frequent) |
| `ctx.setPhase(phase)` | Name the current phase |
| `ctx.event(type, {level, messageKey, metadata})` | Append a structured event |
| `ctx.warn(messageKey)` | Non-fatal warning → job ends `completed_with_warnings` |
| `ctx.heartbeat()` | Keep-alive for stall detection |
| `ctx.signal.throwIfCancelled()` | Cooperative cancel — call at a **safe boundary** |
| `ctx.isPauseRequested()` + `ctx.saveCheckpoint()` / `throw JobPausedError` | Pause (checkpoint-capable handlers) |
| `ctx.loadCheckpoint()` | Resume from a checkpoint |
| `ctx.metric(name, value)` | Record a metric |

## Rules

- **Never** write job rows directly — route everything through the context / service.
- **Cancellation is cooperative**: check `throwIfCancelled()` only where stopping is safe
  (never mid file/DB mutation). A cancel is recorded as `cancelled`, not `failed`.
- **Capabilities are honest**: set `cancellable`/`pausable`/`resumable`/`retryable` to what
  the handler truly supports — the UI/API only offer supported actions.
- **Destructive work** must set `retryable: false` (or throw `JobNonRetryableError`) so it's
  never auto-retried.
- **Inputs carry no secrets** — resolve credentials from config at run time.
  `inputData` (for retry/rerun/resume) and `inputSummary`/results are redacted; keep them small.
- **Idempotency** — pass an `idempotencyKey` to coalesce duplicate enqueues.
- **Test** the handler like any service; the registry + state machine are already covered.

## Adapting an existing queue

If you own an in-process queue, make it a thin adapter (as `MediaProcessingQueueService` /
`SubtitleQueueService` did): keep your public API, register a definition per type, and run
the caller's closure via the platform's **inline executor** while still emitting your legacy
WS events. Callers stay unchanged; work now appears in the Jobs Center.
