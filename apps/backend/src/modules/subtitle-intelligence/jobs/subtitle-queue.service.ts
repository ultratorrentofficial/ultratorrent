/**
 * Subtitle Intelligence background queue — now a **thin adapter** over the Unified
 * Jobs Center's {@link PlatformJobService}, matching the media adapter. Its public API
 * (`run` / `runDetached`) is unchanged, so callers work untouched; each operation is a
 * normalized `platform_jobs` record (appearing in the Jobs Center), while the legacy
 * `subtitle_intelligence.job.*` WebSocket events still fire for the existing UI. Subtitle
 * jobs are not cooperatively cancellable (the bodies take no signal), so the definition
 * declares `cancellable: false` — honestly, no cancel button that can't work.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { WS_EVENTS, PERMISSIONS, type SubtitleJobEventPayload } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { PlatformJobService } from '../../jobs/platform/platform-job.service';
import { JobRegistry } from '../../jobs/platform/job-registry.service';
import type { EnqueueJobInput, JobExecutionContext, JobResult } from '../../jobs/platform/job.types';

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

const SUBTITLE_JOB_TYPES: SubtitleJobType[] = [
  'missing_scan', 'search', 'download', 'validate', 'synchronize', 'provider_health', 'bulk_scan',
];

@Injectable()
export class SubtitleQueueService implements OnModuleInit {
  private readonly logger = new Logger(SubtitleQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly platformJobs: PlatformJobService,
    private readonly registry: JobRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const t of SUBTITLE_JOB_TYPES) {
      const type = `subtitle.${t}`;
      if (this.registry.has(type)) continue;
      this.registry.register(
        {
          type,
          moduleKey: 'subtitle_intelligence',
          workspaceKey: 'media',
          labelKey: `jobs.subtitleType.${t}`,
          requiredPermission: PERMISSIONS.SUBTITLE_INTELLIGENCE_VIEW,
          capabilities: { cancellable: false, retryable: false, pausable: false, resumable: false },
          validateInput: (i) => (i ?? {}) as CreateSubtitleJobOptions,
          summarizeInput: (i) => {
            const o = i as CreateSubtitleJobOptions;
            return { libraryId: o?.libraryId ?? null, itemId: o?.itemId ?? null, language: o?.language ?? null };
          },
        },
        { execute: async () => ({}) }, // never invoked — run/runDetached supply the executor
      );
    }
    try {
      await this.prisma.subtitleJob.updateMany({
        where: { status: { in: ['queued', 'running'] } },
        data: { status: 'failed', finishedAt: new Date(), error: 'Interrupted by a service restart' },
      });
    } catch (err) {
      this.logger.warn(`Could not reconcile legacy subtitle jobs: ${(err as Error).message}`);
    }
  }

  async run<T>(type: SubtitleJobType, opts: CreateSubtitleJobOptions, fn: (report: SubtitleJobReporter) => Promise<T>): Promise<T> {
    const { result } = await this.platformJobs.run<CreateSubtitleJobOptions, T>(
      this.enqueueInput(type, opts),
      (_input, ctx) => this.bridge(type, opts, ctx, fn),
    );
    return result as T;
  }

  async runDetached(type: SubtitleJobType, opts: CreateSubtitleJobOptions, fn: (report: SubtitleJobReporter) => Promise<unknown>): Promise<{ jobId: string }> {
    return this.platformJobs.runDetached<CreateSubtitleJobOptions>(
      this.enqueueInput(type, opts),
      (_input, ctx) => this.bridge(type, opts, ctx, fn),
    );
  }

  private enqueueInput(type: SubtitleJobType, opts: CreateSubtitleJobOptions): EnqueueJobInput<CreateSubtitleJobOptions> {
    return {
      type: `subtitle.${type}`,
      input: opts,
      name: type,
      source: 'manual',
      libraryId: opts.libraryId ?? undefined,
      mediaItemId: opts.itemId ?? undefined,
    };
  }

  private async bridge<T>(
    type: SubtitleJobType,
    opts: CreateSubtitleJobOptions,
    ctx: JobExecutionContext,
    fn: (report: SubtitleJobReporter) => Promise<T>,
  ): Promise<JobResult<T>> {
    this.emitLegacy(WS_EVENTS.SUBTITLE_JOB_STARTED, ctx.jobId, type, opts, 'running', 0);
    const report: SubtitleJobReporter = async (p, m) => {
      await ctx.progress({ percent: p, messageKey: m });
      this.emitLegacy(WS_EVENTS.SUBTITLE_JOB_PROGRESS, ctx.jobId, type, opts, 'running', p, { message: m ?? null });
    };
    try {
      const result = await fn(report);
      this.emitLegacy(WS_EVENTS.SUBTITLE_JOB_COMPLETED, ctx.jobId, type, opts, 'completed', 100, { result });
      return { result, resultSummary: result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined };
    } catch (err) {
      this.emitLegacy(WS_EVENTS.SUBTITLE_JOB_FAILED, ctx.jobId, type, opts, 'failed', undefined, { error: (err as Error).message });
      throw err;
    }
  }

  private emitLegacy(
    event: string,
    jobId: string,
    type: SubtitleJobType,
    opts: CreateSubtitleJobOptions,
    status: string,
    progress?: number,
    extra: Partial<SubtitleJobEventPayload> = {},
  ): void {
    const payload: SubtitleJobEventPayload = {
      jobId,
      type,
      status: status as SubtitleJobEventPayload['status'],
      progress: progress ?? 0,
      libraryId: opts.libraryId ?? null,
      itemId: opts.itemId ?? null,
      provider: opts.provider ?? null,
      language: opts.language ?? null,
      at: new Date().toISOString(),
      ...extra,
    };
    this.realtime.broadcast(event, payload);
  }
}
