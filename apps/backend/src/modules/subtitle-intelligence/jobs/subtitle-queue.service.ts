/**
 * In-process job queue for Subtitle Intelligence background work — the same
 * pattern as MediaProcessingQueueService: each unit is a SubtitleJob row whose
 * lifecycle streams over the RealtimeGateway to the `subtitle_intelligence.view`
 * room, and orphaned rows are failed out on boot (in-process bodies don't survive
 * a restart). No external broker.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { WS_EVENTS, type SubtitleJobEventPayload } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

export type SubtitleJobType =
  | 'missing_scan'
  | 'search'
  | 'download'
  | 'validate'
  | 'synchronize'
  | 'provider_health'
  | 'bulk_scan';

export interface CreateSubtitleJobOptions {
  libraryId?: string | null;
  itemId?: string | null;
  provider?: string | null;
  language?: string | null;
  payload?: Record<string, unknown>;
}

export type SubtitleJobReporter = (progress: number, message?: string) => Promise<void>;

@Injectable()
export class SubtitleQueueService implements OnModuleInit {
  private readonly logger = new Logger(SubtitleQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const { count } = await this.prisma.subtitleJob.updateMany({
        where: { status: { in: ['queued', 'running'] } },
        data: { status: 'failed', finishedAt: new Date(), error: 'Interrupted by a service restart' },
      });
      if (count > 0) this.logger.warn(`Reconciled ${count} orphaned subtitle job(s)`);
    } catch (err) {
      this.logger.warn(`Could not reconcile orphaned subtitle jobs: ${(err as Error).message}`);
    }
  }

  private emit(event: string, job: { id: string; type: string; status: string; progress: number; libraryId: string | null; itemId: string | null; provider: string | null; language: string | null }, extra: Partial<SubtitleJobEventPayload> = {}) {
    const payload: SubtitleJobEventPayload = {
      jobId: job.id,
      type: job.type,
      status: job.status as SubtitleJobEventPayload['status'],
      progress: job.progress,
      libraryId: job.libraryId,
      itemId: job.itemId,
      provider: job.provider,
      language: job.language,
      at: new Date().toISOString(),
      ...extra,
    };
    this.realtime.broadcast(event, payload);
  }

  /**
   * Run `fn` as a tracked job: create → running → report progress → completed /
   * failed. Rethrows so callers see the error (use runDetached for HTTP-bound work).
   */
  async run<T>(type: SubtitleJobType, opts: CreateSubtitleJobOptions, fn: (report: SubtitleJobReporter) => Promise<T>): Promise<T> {
    const job = await this.prisma.subtitleJob.create({
      data: {
        type,
        status: 'running',
        startedAt: new Date(),
        libraryId: opts.libraryId ?? null,
        itemId: opts.itemId ?? null,
        provider: opts.provider ?? null,
        language: opts.language ?? null,
        payload: (opts.payload ?? {}) as object,
      },
    });
    this.emit(WS_EVENTS.SUBTITLE_JOB_STARTED, job);

    const report: SubtitleJobReporter = async (progress, message) => {
      const updated = await this.prisma.subtitleJob.update({
        where: { id: job.id },
        data: { progress: Math.max(0, Math.min(100, Math.round(progress))) },
      });
      this.emit(WS_EVENTS.SUBTITLE_JOB_PROGRESS, updated, { message: message ?? null });
    };

    try {
      const result = await fn(report);
      const done = await this.prisma.subtitleJob.update({
        where: { id: job.id },
        data: { status: 'completed', progress: 100, finishedAt: new Date(), result: (result ?? {}) as object },
      });
      this.emit(WS_EVENTS.SUBTITLE_JOB_COMPLETED, done, { result });
      return result;
    } catch (err) {
      const failed = await this.prisma.subtitleJob.update({
        where: { id: job.id },
        data: { status: 'failed', finishedAt: new Date(), error: (err as Error).message.slice(0, 500) },
      });
      this.emit(WS_EVENTS.SUBTITLE_JOB_FAILED, failed, { error: (err as Error).message });
      throw err;
    }
  }

  /** Fire-and-forget variant for long work; returns the job id immediately. */
  async runDetached(type: SubtitleJobType, opts: CreateSubtitleJobOptions, fn: (report: SubtitleJobReporter) => Promise<unknown>): Promise<{ jobId: string }> {
    const job = await this.prisma.subtitleJob.create({
      data: {
        type,
        status: 'queued',
        libraryId: opts.libraryId ?? null,
        itemId: opts.itemId ?? null,
        provider: opts.provider ?? null,
        language: opts.language ?? null,
        payload: (opts.payload ?? {}) as object,
      },
    });
    // Run on the next tick; the queue row carries all state.
    void this.resume(job.id, type, fn);
    return { jobId: job.id };
  }

  private async resume(jobId: string, type: SubtitleJobType, fn: (report: SubtitleJobReporter) => Promise<unknown>): Promise<void> {
    const job = await this.prisma.subtitleJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date() },
    });
    this.emit(WS_EVENTS.SUBTITLE_JOB_STARTED, job);
    const report: SubtitleJobReporter = async (progress, message) => {
      const updated = await this.prisma.subtitleJob.update({
        where: { id: jobId },
        data: { progress: Math.max(0, Math.min(100, Math.round(progress))) },
      });
      this.emit(WS_EVENTS.SUBTITLE_JOB_PROGRESS, updated, { message: message ?? null });
    };
    try {
      const result = await fn(report);
      const done = await this.prisma.subtitleJob.update({
        where: { id: jobId },
        data: { status: 'completed', progress: 100, finishedAt: new Date(), result: (result ?? {}) as object },
      });
      this.emit(WS_EVENTS.SUBTITLE_JOB_COMPLETED, done, { result });
    } catch (err) {
      const failed = await this.prisma.subtitleJob.update({
        where: { id: jobId },
        data: { status: 'failed', finishedAt: new Date(), error: (err as Error).message.slice(0, 500) },
      });
      this.emit(WS_EVENTS.SUBTITLE_JOB_FAILED, failed, { error: (err as Error).message });
    }
  }
}
