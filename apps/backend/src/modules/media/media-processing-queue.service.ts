import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { MediaProcessingJob, Prisma } from '@prisma/client';
import { WS_EVENTS, type MediaJobEventPayload } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/** Long-running Media Manager operation types tracked as MediaProcessingJob rows. */
export type MediaJobType =
  | 'library_scan'
  | 'media_identification'
  | 'metadata_fetch'
  | 'artwork_fetch'
  | 'subtitle_scan'
  | 'rename_execute'
  | 'library_organize'
  | 'nfo_generate'
  | 'media_server_refresh';

export interface CreateJobOptions {
  libraryId?: string | null;
  itemId?: string | null;
  payload?: Record<string, unknown>;
}

/** Progress reporter handed to a job body: `report(percent, message?)`. */
export type JobReporter = (progress: number, message?: string) => Promise<void>;

/**
 * In-process queue for Media Manager background work. Persists each operation as
 * a MediaProcessingJob (status/progress/type) and streams its lifecycle over the
 * RealtimeGateway to the `media_manager.view`-scoped channel (started / progress
 * / completed / failed). No external broker — the existing @nestjs/schedule +
 * async model is sufficient for these bounded, best-effort operations.
 */
@Injectable()
export class MediaProcessingQueueService implements OnModuleInit {
  private readonly logger = new Logger(MediaProcessingQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Reconcile orphaned jobs at boot. Job bodies run **in-process** (see
   * {@link runDetached}) — they are not durable work items a worker picks back up.
   * So any row still `queued`/`running` belongs to a process that is already gone
   * (a deploy, restart or crash): its work died with that process and will never
   * resume, yet the row would otherwise sit "running" forever. Left unhandled they
   * pile up and make the job list meaningless — a live host had 30 of them, some
   * 5+ hours old. Fail them out so the state reflects reality.
   */
  async onModuleInit(): Promise<void> {
    try {
      const { count } = await this.prisma.mediaProcessingJob.updateMany({
        where: { status: { in: ['queued', 'running'] } },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: 'Interrupted by a service restart',
        },
      });
      if (count > 0) {
        this.logger.warn(
          `Reconciled ${count} orphaned job(s) left ${'queued/running'} by a previous process`,
        );
      }
    } catch (err) {
      // Never block boot on this best-effort cleanup.
      this.logger.warn(`Could not reconcile orphaned jobs: ${(err as Error).message}`);
    }
  }

  /** Create a queued job row. */
  async create(type: MediaJobType, opts: CreateJobOptions = {}) {
    return this.prisma.mediaProcessingJob.create({
      data: {
        type,
        status: 'queued',
        libraryId: opts.libraryId ?? null,
        itemId: opts.itemId ?? null,
        payload: (opts.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /** Mark a job running and emit `started`. */
  async start(jobId: string) {
    const job = await this.prisma.mediaProcessingJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date(), progress: 0 },
    });
    this.emit(WS_EVENTS.MEDIA_JOB_STARTED, job);
    return job;
  }

  /** Update progress (0..100) and emit `progress`. */
  async progress(jobId: string, progress: number, message?: string) {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)));
    const job = await this.prisma.mediaProcessingJob.update({
      where: { id: jobId },
      data: { progress: clamped },
    });
    this.emit(WS_EVENTS.MEDIA_JOB_PROGRESS, job, { message });
  }

  /** Mark a job completed and emit `completed`. */
  async complete(jobId: string, result?: unknown) {
    const job = await this.prisma.mediaProcessingJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        progress: 100,
        finishedAt: new Date(),
        result: (result ?? {}) as Prisma.InputJsonValue,
      },
    });
    this.emit(WS_EVENTS.MEDIA_JOB_COMPLETED, job, { result });
    return job;
  }

  /** Mark a job failed and emit `failed`. Never throws (best-effort). */
  async fail(jobId: string, error: string) {
    const job = await this.prisma.mediaProcessingJob
      .update({
        where: { id: jobId },
        data: { status: 'failed', finishedAt: new Date(), error },
      })
      .catch(() => null);
    if (job) this.emit(WS_EVENTS.MEDIA_JOB_FAILED, job, { error });
  }

  /**
   * Run `fn` as a tracked job: create → start → (fn with a progress reporter) →
   * complete, or fail on throw. Rethrows so callers can surface the error while
   * the failure is still recorded + broadcast.
   */
  async run<T>(
    type: MediaJobType,
    opts: CreateJobOptions,
    fn: (report: JobReporter) => Promise<T>,
  ): Promise<T> {
    const created = await this.create(type, opts);
    await this.start(created.id);
    const report: JobReporter = (progress, message) =>
      this.progress(created.id, progress, message);
    try {
      const result = await fn(report);
      await this.complete(created.id, result);
      return result;
    } catch (err) {
      await this.fail(created.id, (err as Error).message);
      throw err;
    }
  }

  /**
   * Start a job WITHOUT waiting for it to finish: create + start the row, run
   * `fn` in the background, and return `{ jobId }` immediately. Callers return
   * that to the client at once so a long job (e.g. scanning a 20k-file library)
   * can't time the HTTP request out at the gateway (504); progress + completion
   * arrive over the `media_manager.job.*` WS events. Failures are recorded and
   * broadcast, never thrown — there is no caller left to catch them.
   */
  async runDetached(
    type: MediaJobType,
    opts: CreateJobOptions,
    fn: (report: JobReporter) => Promise<unknown>,
  ): Promise<{ jobId: string }> {
    const created = await this.create(type, opts);
    void (async () => {
      await this.start(created.id);
      const report: JobReporter = (progress, message) =>
        this.progress(created.id, progress, message);
      try {
        const result = await fn(report);
        await this.complete(created.id, result);
      } catch (err) {
        await this.fail(created.id, (err as Error).message);
      }
    })();
    return { jobId: created.id };
  }

  private emit(
    event: string,
    job: MediaProcessingJob,
    extra: Partial<MediaJobEventPayload> = {},
  ): void {
    const payload: MediaJobEventPayload = {
      jobId: job.id,
      type: job.type,
      status: job.status as MediaJobEventPayload['status'],
      progress: job.progress,
      libraryId: job.libraryId,
      itemId: job.itemId,
      at: new Date().toISOString(),
      ...extra,
    };
    this.realtime.broadcast(event, payload);
  }
}
