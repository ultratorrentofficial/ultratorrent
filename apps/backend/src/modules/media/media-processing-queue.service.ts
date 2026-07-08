import { Injectable, Logger } from '@nestjs/common';
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
export class MediaProcessingQueueService {
  private readonly logger = new Logger(MediaProcessingQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

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
