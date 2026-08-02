import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { WS_EVENTS, PERMISSIONS, type MediaJobEventPayload } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PlatformJobService } from '../jobs/platform/platform-job.service';
import { JobRegistry } from '../jobs/platform/job-registry.service';
import {
  JobCancelledError as PlatformJobCancelledError,
  type EnqueueJobInput,
  type JobExecutionContext,
  type JobResult,
} from '../jobs/platform/job.types';

/** Long-running Media Manager operation types (now platform job types `media.<type>`). */
export type MediaJobType =
  | 'library_scan'
  | 'media_identification'
  | 'metadata_fetch'
  | 'artwork_fetch'
  | 'subtitle_scan'
  | 'rename_execute'
  | 'library_organize'
  | 'nfo_generate'
  | 'media_server_refresh'
  | 'duplicate_detect'
  | 'media_delete_files'
  | 'media_move';

export interface CreateJobOptions {
  libraryId?: string | null;
  itemId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * What a media job says it was asked to do, for the Jobs Center.
 *
 * The old version read ONLY `libraryId` and `itemId` and wrote `null` for each
 * when absent. Bulk operations from Library Browser carry their targets in the
 * PAYLOAD — `{ libraryId: null, payload: { itemIds: [...] } }` — so a perfectly
 * healthy single-item metadata refresh recorded `{ libraryId: null, itemId: null }`
 * and told the operator, in as many words, that it had no idea what to work on.
 * It knew; the summary was looking in the wrong place.
 *
 * Now it reads the payload too, and omits what is genuinely absent rather than
 * asserting a null — absence and "nothing to do" are not the same claim.
 */
export function summarizeMediaJobInput(input: CreateJobOptions | undefined): Record<string, unknown> {
  const payload = (input?.payload ?? {}) as Record<string, unknown>;
  const itemIds = Array.isArray(payload.itemIds) ? (payload.itemIds as string[]) : undefined;
  const out: Record<string, unknown> = {};

  if (input?.libraryId) out.libraryId = input.libraryId;
  // A one-item bulk is the common case from Library Browser, and naming the item
  // is far more useful than reporting a list of one.
  const single = input?.itemId ?? (itemIds?.length === 1 ? itemIds[0] : undefined);
  if (single) out.itemId = single;
  if (itemIds && itemIds.length > 1) out.itemIds = itemIds;

  // Anything else the caller passed is still worth showing — a path, a profile,
  // a flag — but ids are handled above so they are not repeated.
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'itemIds' || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Progress reporter handed to a job body: `report(percent, message?)`. */
export type JobReporter = (progress: number, message?: string) => Promise<void>;

/**
 * Thrown by a media job body when it observes cancellation. Kept as this module's own
 * class (name `JobCancelledError`) because callers and specs depend on it structurally
 * (e.g. `media-duplicate.service` checks `err.name === 'JobCancelledError'`). The
 * adapter translates it into the platform runner's cancellation at the boundary.
 */
export class JobCancelledError extends Error {
  constructor() {
    super('Cancelled by the operator');
    this.name = 'JobCancelledError';
  }
}

/** Handed to a job body so it can stop at a safe boundary (cooperative cancellation). */
export interface JobSignal {
  isCancelled(): boolean;
  throwIfCancelled(): void;
}

/** Every media job type, exported so callers and tests derive it rather than restate it. */
export const MEDIA_JOB_TYPES: MediaJobType[] = [
  'library_scan', 'media_identification', 'metadata_fetch', 'artwork_fetch', 'subtitle_scan',
  'rename_execute', 'library_organize', 'nfo_generate', 'media_server_refresh', 'duplicate_detect',
  'media_delete_files', 'media_move',
];

/**
 * Media Manager background queue — now a **thin adapter** over the Unified Jobs Center's
 * {@link PlatformJobService}. Its public API (`run` / `runDetached` / `requestCancel`) is
 * unchanged, so every existing caller works untouched; internally, each operation is a
 * normalized `platform_jobs` record (so it appears in the Jobs Center with full lifecycle,
 * events, retry/cancel semantics). The legacy `media_manager.job.*` WebSocket events are
 * still emitted alongside the unified `jobs.*` channel, so the existing Media Manager
 * progress UIs keep working with no change. See docs/UNIFIED_JOBS_CENTER_ARCHITECTURE_REVIEW.md §15.3.
 */
@Injectable()
export class MediaProcessingQueueService implements OnModuleInit {
  private readonly logger = new Logger(MediaProcessingQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly platformJobs: PlatformJobService,
    private readonly registry: JobRegistry,
  ) {}

  /** Register a platform job definition per media job type, and clean up legacy rows. */
  async onModuleInit(): Promise<void> {
    for (const t of MEDIA_JOB_TYPES) {
      const type = `media.${t}`;
      if (this.registry.has(type)) continue;
      this.registry.register(
        {
          type,
          moduleKey: 'media_manager',
          workspaceKey: 'media',
          labelKey: `jobs.mediaType.${t}`,
          requiredPermission: PERMISSIONS.MEDIA_MANAGER_VIEW,
          capabilities: { cancellable: true, retryable: false, pausable: false, resumable: false },
          validateInput: (i) => (i ?? {}) as CreateJobOptions,
          summarizeInput: (i) => summarizeMediaJobInput(i as CreateJobOptions),
        },
        // Never invoked — run/runDetached always supply an inline executor (the caller's fn).
        { execute: async () => ({}) },
      );
    }
    // Fail out any pre-migration rows left running by a previous process (harmless if none).
    try {
      await this.prisma.mediaProcessingJob.updateMany({
        where: { status: { in: ['queued', 'running'] } },
        data: { status: 'failed', finishedAt: new Date(), error: 'Interrupted by a service restart' },
      });
    } catch (err) {
      this.logger.warn(`Could not reconcile legacy media jobs: ${(err as Error).message}`);
    }
  }

  /** Run `fn` as a tracked platform job, awaiting completion; rethrows on failure. */
  async run<T>(type: MediaJobType, opts: CreateJobOptions, fn: (report: JobReporter, signal: JobSignal) => Promise<T>): Promise<T> {
    const { result } = await this.platformJobs.run<CreateJobOptions, T>(
      this.enqueueInput(type, opts),
      (_input, ctx) => this.bridge(type, opts, ctx, fn),
    );
    return result as T;
  }

  /** Start `fn` as a detached platform job; returns `{ jobId }` immediately. */
  async runDetached(type: MediaJobType, opts: CreateJobOptions, fn: (report: JobReporter, signal: JobSignal) => Promise<unknown>): Promise<{ jobId: string }> {
    return this.platformJobs.runDetached<CreateJobOptions>(
      this.enqueueInput(type, opts),
      (_input, ctx) => this.bridge(type, opts, ctx, fn),
    );
  }

  /** Request cooperative cancellation of a running job (delegates to the platform engine). */
  requestCancel(jobId: string): Promise<boolean> {
    return this.platformJobs.requestCancel(jobId);
  }

  private enqueueInput(type: MediaJobType, opts: CreateJobOptions): EnqueueJobInput<CreateJobOptions> {
    // A bulk operation over exactly ONE item is the ordinary case from Library
    // Browser, and it carries its target in the payload rather than in `itemId`.
    // Without this the row's `mediaItemId` stays null, so the Jobs Center cannot
    // link the job to what it acted on or filter by it — which is how a healthy
    // refresh came to look like a job that did not know what to do.
    const ids = opts.payload?.itemIds;
    const single = Array.isArray(ids) && ids.length === 1 ? String(ids[0]) : undefined;
    return {
      type: `media.${type}`,
      input: opts,
      name: type,
      source: 'manual',
      libraryId: opts.libraryId ?? undefined,
      mediaItemId: opts.itemId ?? single,
    };
  }

  /** Bridge the caller's (report, signal) closure to the platform execution context, emitting legacy WS events. */
  private async bridge<T>(
    type: MediaJobType,
    opts: CreateJobOptions,
    ctx: JobExecutionContext,
    fn: (report: JobReporter, signal: JobSignal) => Promise<T>,
  ): Promise<JobResult<T>> {
    this.emitLegacy(WS_EVENTS.MEDIA_JOB_STARTED, ctx.jobId, type, opts, 'running', 0);
    const report: JobReporter = async (p, m) => {
      await ctx.progress({ percent: p, messageKey: m });
      this.emitLegacy(WS_EVENTS.MEDIA_JOB_PROGRESS, ctx.jobId, type, opts, 'running', p, { message: m });
    };
    const signal: JobSignal = {
      isCancelled: () => ctx.signal.isCancelled(),
      throwIfCancelled: () => {
        if (ctx.signal.isCancelled()) throw new JobCancelledError();
      },
    };
    try {
      const result = await fn(report, signal);
      this.emitLegacy(WS_EVENTS.MEDIA_JOB_COMPLETED, ctx.jobId, type, opts, 'completed', 100, { result });
      return { result, resultSummary: result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined };
    } catch (err) {
      const cancelled = err instanceof JobCancelledError;
      const message = cancelled ? 'Cancelled by the operator' : (err as Error).message;
      // Legacy behaviour: both cancellation and failure emitted MEDIA_JOB_FAILED.
      this.emitLegacy(WS_EVENTS.MEDIA_JOB_FAILED, ctx.jobId, type, opts, cancelled ? 'cancelled' : 'failed', undefined, { error: message });
      // Route cancellation to the platform runner so it records `cancelled`, not `failed`.
      if (cancelled) throw new PlatformJobCancelledError();
      throw err;
    }
  }

  private emitLegacy(
    event: string,
    jobId: string,
    type: MediaJobType,
    opts: CreateJobOptions,
    status: string,
    progress?: number,
    extra: Partial<MediaJobEventPayload> = {},
  ): void {
    const payload: MediaJobEventPayload = {
      jobId,
      type,
      status: status as MediaJobEventPayload['status'],
      progress: progress ?? 0,
      libraryId: opts.libraryId ?? null,
      itemId: opts.itemId ?? null,
      at: new Date().toISOString(),
      ...extra,
    };
    this.realtime.broadcast(event, payload);
  }
}
