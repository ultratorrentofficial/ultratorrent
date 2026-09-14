import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MissingEpisodeSearchService } from '../media-acquisition/missing-episode-search.service';
import { PackAcquisitionService, type PackItem } from '../media-acquisition/pack-acquisition.service';
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
  seasonPacksGrabbed: number;
  seriesPackGrabbed: boolean;
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
    private readonly packs: PackAcquisitionService,
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

    const summary: SeriesBackfillSummary = {
      total: 0,
      grabbed: 0,
      pendingApproval: 0,
      noResults: 0,
      failed: 0,
      skipped: 0,
      seasonPacksGrabbed: 0,
      seriesPackGrabbed: false,
    };

    // Pack-first: when a whole season (or series) is missing, grab ONE pack and let
    // intake fan it out — cheaper and it matches pack-only releases that per-episode
    // search never can. Episodes a pack covers are marked `grabbed`, so the loop below
    // skips them. Only runs on a first pass (no checkpoint), so a resumed job does not
    // re-grab a pack already in flight.
    if (done.size === 0) {
      try {
        await this.runPackPrepass(input, summary, ctx.runAsUserId ?? undefined);
      } catch (err) {
        await ctx.warn('jobs.seriesBackfill.packFailed', { error: (err as Error).message });
      }
    }

    const rows = await this.prisma.wantedEpisode.findMany({
      where: {
        watchlistItemId: input.watchlistItemId,
        status: 'missing',
        excludedFromScope: false,
        // Episodes a pack (or the RSS rule) already grabbed are no longer searchable.
        searchStatus: { notIn: ['grabbed', 'pending_approval', 'searching'] },
        ...(input.seasons ? { seasonNumber: { in: input.seasons } } : {}),
      },
      orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }],
      select: { id: true, seasonNumber: true, episodeNumber: true },
    });
    const total = rows.length;
    summary.total = total;
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const queue = rows.map((r) => r.id).filter((id) => !done.has(id));
    // Episodes this run could not find at any preference — emitted as ONE digest
    // at the end (backfill suppresses per-episode notifications for this reason).
    const unfound: string[] = [];
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
            const outcome = await this.search.searchEpisode(id, ctx.runAsUserId ?? undefined, { notifyOnNoMatch: false });
            if (outcome.searchStatus === 'grabbed') summary.grabbed += 1;
            else if (outcome.searchStatus === 'pending_approval') summary.pendingApproval += 1;
            else if (outcome.searchStatus === 'no_results') { summary.noResults += 1; unfound.push(id); }
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

    // One "not found at your preferences" digest for the whole backfill run,
    // named by the show. Pack-covered and grabbed episodes are not in `unfound`.
    if (unfound.length) {
      this.search.emitNoMatchDigest(
        input.title,
        input.watchlistItemId,
        unfound.map((id) => {
          const r = rowById.get(id);
          return { showTitle: input.title, seasonNumber: r?.seasonNumber ?? undefined, episodeNumber: r?.episodeNumber ?? undefined };
        }),
        ctx.runAsUserId ?? undefined,
      );
    }

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
        seasonPacksGrabbed: summary.seasonPacksGrabbed,
      },
    };
  }

  /**
   * Pack pre-pass: try a series pack when EVERY in-scope season is fully missing
   * (per config), else a season pack for each fully-missing season. A grabbed pack
   * marks its episodes `grabbed`, so the per-episode loop then skips them. Any season
   * below the threshold, or where no pack was found, is left for per-episode search.
   */
  private async runPackPrepass(input: SeriesBackfillInput, summary: SeriesBackfillSummary, userId?: string): Promise<void> {
    const cfg = await this.packs.config();
    if (!cfg.enabled) return;

    const item = await this.prisma.mediaAcquisitionWatchlistItem.findUnique({ where: { id: input.watchlistItemId } });
    if (!item) return;

    const eps = await this.prisma.wantedEpisode.findMany({
      where: {
        watchlistItemId: input.watchlistItemId,
        excludedFromScope: false,
        ...(input.seasons ? { seasonNumber: { in: input.seasons } } : {}),
      },
      select: { id: true, seasonNumber: true, status: true, searchStatus: true },
    });

    // Per season: catalogue total (excluding operator-ignored) and the still-missing,
    // not-yet-grabbed episode ids.
    const bySeason = new Map<number, { total: number; missingIds: string[] }>();
    for (const e of eps) {
      if (e.status === 'ignored') continue;
      const s = bySeason.get(e.seasonNumber) ?? { total: 0, missingIds: [] };
      s.total += 1;
      if (e.status === 'missing' && !['grabbed', 'pending_approval', 'searching'].includes(e.searchStatus)) {
        s.missingIds.push(e.id);
      }
      bySeason.set(e.seasonNumber, s);
    }
    if (bySeason.size === 0) return;

    const packItem: PackItem = {
      id: item.id,
      title: item.title,
      titleAliases: item.titleAliases,
      year: item.year,
      rssRuleId: item.rssRuleId,
      targetLibraryId: item.targetLibraryId,
      libraryShowId: item.libraryShowId,
      priority: item.priority,
    };
    const fullyMissing = (s: { total: number; missingIds: string[] }) => s.total > 0 && s.missingIds.length / s.total >= cfg.seasonMissingThreshold;
    const entries = [...bySeason.entries()];

    // Whole series missing → one series pack covers everything.
    if (cfg.seriesPacks && cfg.wholeSeriesForSeriesPack && entries.every(([, s]) => fullyMissing(s))) {
      const neededSeasons = entries.map(([n]) => n).sort((a, b) => a - b);
      const allMissing = entries.flatMap(([, s]) => s.missingIds);
      const r = await this.packs.trySeriesPack(packItem, input.seriesTconst, neededSeasons, allMissing, userId);
      if (r.grabbed) {
        summary.seriesPackGrabbed = true;
        return; // covered episodes are now `grabbed`; no season/episode passes needed
      }
    }

    // Otherwise a season pack per fully-missing season.
    for (const [season, s] of entries) {
      if (!fullyMissing(s) || s.missingIds.length === 0) continue;
      const r = await this.packs.trySeasonPack(packItem, input.seriesTconst, season, s.missingIds, userId);
      if (r.grabbed) summary.seasonPacksGrabbed += 1;
    }
  }
}
