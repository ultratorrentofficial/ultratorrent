import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MissingEpisodeSearchService } from '../media-acquisition/missing-episode-search.service';
import { JobRegistry } from '../jobs/platform/job-registry.service';
import { PlatformJobService } from '../jobs/platform/platform-job.service';
import { ACTIVE_STATUSES } from '../jobs/platform/job-status';
import {
  type JobExecutionContext,
  type JobResult,
  JobCancelledError,
  JobPausedError,
} from '../jobs/platform/job.types';
import { PERMISSIONS } from '@ultratorrent/shared';

/** Namespaced platform-job type for a series backfill. */
export const SERIES_BACKFILL_JOB_TYPE = 'media_acquisition.series_backfill';

/** Bounded so a backfill never floods the indexers with parallel queries. */
const MIN_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const DEFAULT_CONCURRENCY = 3;

export interface SeriesBackfillInput {
  watchlistItemId: string;
  seriesTconst: string | null;
  title: string;
  /** Seasons to back-fill; null/empty = every in-scope season. */
  seasons: number[] | null;
  /** Parallel episode searches, clamped to [2, 4]. */
  concurrency?: number;
}

interface BackfillCheckpoint {
  doneIds: string[];
}

export interface SeriesBackfillSummary {
  total: number;
  grabbed: number;
  pendingApproval: number;
  noResults: number;
  failed: number;
  skipped: number;
}

/**
 * The managed back-catalogue acquirer for the Add-Series workflow.
 *
 * It does NOT re-implement release selection or grabbing — every episode goes
 * through {@link MissingEpisodeSearchService.searchEpisode}, which is the same
 * Smart-Download-backed path the scheduled sweep and the manual "search series"
 * button use. This service only adds what a back-catalogue run needs on top of
 * that primitive: a bounded-concurrency driver (so a 200-episode show does not
 * fire 200 indexer queries at once), cooperative pause/resume/cancel and
 * progress via the platform {@link JobExecutionContext}, and idempotence — it
 * re-reads each episode's state and skips anything no longer `missing`, so a
 * resumed or re-run backfill never re-grabs what a prior pass already placed.
 *
 * An episode that finds no release stays `missing` (its `searchStatus` becomes
 * `no_results`): it remains wanted, and the ongoing monitoring path can still
 * pick it up later. A backfill never marks an episode "done with no result".
 */
@Injectable()
export class SeriesBackfillService implements OnModuleInit {
  private readonly logger = new Logger(SeriesBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
    private readonly platformJobs: PlatformJobService,
    private readonly search: MissingEpisodeSearchService,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    if (this.registry.has(SERIES_BACKFILL_JOB_TYPE)) return;
    this.registry.register(
      {
        type: SERIES_BACKFILL_JOB_TYPE,
        moduleKey: 'media_acquisition',
        workspaceKey: 'media',
        labelKey: 'jobs.seriesBackfill.label',
        descriptionKey: 'jobs.seriesBackfill.description',
        requiredPermission: PERMISSIONS.MEDIA_ACQUISITION_MANAGE_WATCHLIST,
        capabilities: { cancellable: true, retryable: true, pausable: true, resumable: true },
        defaultMaxAttempts: 1,
        validateInput: (i) => this.validate(i),
        summarizeInput: (i) => {
          const o = i as SeriesBackfillInput;
          return {
            watchlistItemId: o?.watchlistItemId ?? null,
            title: o?.title ?? null,
            seasons: o?.seasons ?? null,
          };
        },
      },
      { execute: (input, ctx) => this.execute(input as SeriesBackfillInput, ctx) },
    );
  }

  private validate(raw: unknown): SeriesBackfillInput {
    const o = (raw ?? {}) as Partial<SeriesBackfillInput>;
    if (!o.watchlistItemId) throw new Error('series backfill: watchlistItemId is required');
    return {
      watchlistItemId: o.watchlistItemId,
      seriesTconst: o.seriesTconst ?? null,
      title: o.title ?? 'series',
      seasons: o.seasons && o.seasons.length ? o.seasons : null,
      concurrency: this.clampConcurrency(o.concurrency),
    };
  }

  private clampConcurrency(n: number | undefined): number {
    if (!n || Number.isNaN(n)) return DEFAULT_CONCURRENCY;
    return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(n)));
  }

  /**
   * Ensure a backfill is running for this series. Idempotent: the idempotency key
   * is the watchlist item, so asking twice while one is in flight does not start
   * a second flood — the platform job layer returns the existing run.
   */
  async enqueue(input: SeriesBackfillInput, runAsUserId?: string): Promise<{ jobId: string }> {
    const normalized = this.validate(input);
    const idempotencyKey = `series-backfill:${normalized.watchlistItemId}`;

    // `runDetached` would re-run a job even if enqueue's idempotency check found an
    // existing one, so the "one active backfill per series" guarantee has to live
    // here: an in-flight backfill for this series is returned untouched.
    const existing = await this.prisma.platformJob.findFirst({
      where: { idempotencyKey, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true },
    });
    if (existing) return { jobId: existing.id };

    return this.platformJobs.runDetached<SeriesBackfillInput>({
      type: SERIES_BACKFILL_JOB_TYPE,
      input: normalized,
      name: `Backfill: ${normalized.title}`,
      source: 'manual',
      resourceType: 'media_acquisition_watchlist',
      resourceId: normalized.watchlistItemId,
      runAsUserId,
      idempotencyKey,
    });
  }

  /** The current (or most recent) backfill job for a series, for status display. */
  async latestJob(watchlistItemId: string): Promise<{
    id: string;
    status: string;
    progressCurrent: number | null;
    progressTotal: number | null;
    resultSummary: unknown;
    startedAt: Date | null;
    completedAt: Date | null;
  } | null> {
    const job = await this.prisma.platformJob.findFirst({
      where: { idempotencyKey: `series-backfill:${watchlistItemId}` },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        progressCurrent: true,
        progressTotal: true,
        resultSummary: true,
        startedAt: true,
        completedAt: true,
      },
    });
    return job;
  }

  /** Pause/resume/cancel all delegate to the platform job layer (the UI uses these). */
  pause(jobId: string): Promise<boolean> {
    return this.platformJobs.requestPause(jobId);
  }
  resume(jobId: string): Promise<{ jobId: string } | null> {
    return this.platformJobs.resume(jobId);
  }
  cancel(jobId: string): Promise<boolean> {
    return this.platformJobs.requestCancel(jobId);
  }

  /** The registered handler body. */
  async execute(
    input: SeriesBackfillInput,
    ctx: JobExecutionContext,
  ): Promise<JobResult<SeriesBackfillSummary>> {
    const checkpoint = await ctx.loadCheckpoint<BackfillCheckpoint>();
    const done = new Set<string>(checkpoint?.doneIds ?? []);

    await ctx.setPhase('backfill', 'jobs.seriesBackfill.phase');

    const rows = await this.prisma.wantedEpisode.findMany({
      where: {
        watchlistItemId: input.watchlistItemId,
        status: 'missing',
        excludedFromScope: false,
        ...(input.seasons ? { seasonNumber: { in: input.seasons } } : {}),
      },
      orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }],
      select: { id: true },
    });
    const total = rows.length;
    const queue = rows.map((r) => r.id).filter((id) => !done.has(id));

    const summary: SeriesBackfillSummary = {
      total,
      grabbed: 0,
      pendingApproval: 0,
      noResults: 0,
      failed: 0,
      skipped: 0,
    };
    let current = done.size;
    await ctx.progress({ current, total, unit: 'episodes', messageKey: 'jobs.seriesBackfill.phase' });

    const concurrency = this.clampConcurrency(input.concurrency);

    const worker = async (): Promise<void> => {
      for (;;) {
        ctx.signal.throwIfCancelled();
        if (ctx.isPauseRequested()) {
          await ctx.saveCheckpoint({ doneIds: [...done] } satisfies BackfillCheckpoint);
          throw new JobPausedError();
        }
        const id = queue.shift();
        if (!id) return;

        // Idempotence: an episode a prior pass (or the RSS rule) already grabbed is
        // no longer `missing`; searchEpisode would reject it. Skip rather than fail.
        const fresh = await this.prisma.wantedEpisode.findUnique({
          where: { id },
          select: { status: true, excludedFromScope: true },
        });
        if (!fresh || fresh.status !== 'missing' || fresh.excludedFromScope) {
          summary.skipped += 1;
        } else {
          try {
            const outcome = await this.search.searchEpisode(id, ctx.runAsUserId ?? undefined);
            if (outcome.searchStatus === 'grabbed') summary.grabbed += 1;
            else if (outcome.searchStatus === 'pending_approval') summary.pendingApproval += 1;
            else if (outcome.searchStatus === 'no_results') summary.noResults += 1;
            else if (outcome.searchStatus === 'failed') summary.failed += 1;
          } catch (err) {
            if (err instanceof JobPausedError || err instanceof JobCancelledError) throw err;
            summary.failed += 1;
            await ctx.warn('jobs.seriesBackfill.episodeFailed', { error: (err as Error).message });
          }
        }

        done.add(id);
        current += 1;
        await ctx.progress({ current, total, unit: 'episodes' });
        await ctx.heartbeat();
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await ctx.saveCheckpoint({ doneIds: [...done] } satisfies BackfillCheckpoint);

    this.realtime.broadcast('media_acquisition.series.backfill_completed', {
      watchlistItemId: input.watchlistItemId,
      jobId: ctx.jobId,
      summary,
    });

    const warnings = summary.failed ? [`${summary.failed} episode(s) could not be searched`] : undefined;
    return {
      result: summary,
      warnings,
      resultSummary: { ...summary },
      metrics: {
        grabbed: summary.grabbed,
        pendingApproval: summary.pendingApproval,
        noResults: summary.noResults,
        failed: summary.failed,
        skipped: summary.skipped,
      },
    };
  }
}
