import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  DEFAULT_COMPLETION_THRESHOLD_PERCENT,
  aggregatePlays,
} from './domain/playback-aggregate';
import { buildTitleIndex, resolvePlaybackRows } from './domain/playback-resolution';

export interface PlaybackAggregateRebuildResult {
  historyRows: number;
  itemsWithPlayback: number;
  /** Items read against the history and not found in it — a measured zero. */
  itemsWithoutPlayback: number;
  unresolvedRows: number;
  skippedNonMovieRows: number;
  written: number;
  removed: number;
}

/** Hourly is far more often than viewing habits change, and the job is cheap. */
const REBUILD_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Derive `MediaPlaybackAggregate` from imported watch history.
 *
 * This table had no writer. `domain/playback-aggregate.ts` computed the facts,
 * the cleanup evaluator read the table, and nothing in the platform ever put a
 * row in it — so every `playback.*` condition (`neverWatched`,
 * `completedPlayCount`, `daysSinceLastPlay`, thirteen in all) matched nothing on
 * every install. A policy using one validated, ran, matched its candidates, and
 * then excluded all of them as unmeasured. Observed on a live library holding
 * 8,375 history rows and zero aggregates.
 *
 * **Every library item gets a row, including the ones never played.** A film
 * nobody watched appears in no history, so keying "measured" off the existence of
 * a row would leave exactly the items a never-watched policy is looking for
 * permanently unmeasured — matched, then excluded, forever. Having read the whole
 * history and not found an item in it IS the measurement, and it is recorded as a
 * zero-play aggregate.
 *
 * The safety that costs is bought back one level up: this writes nothing at all
 * when there is NO history to read. "I checked 8,375 plays and this film is not
 * among them" and "no viewing data exists" are different claims, and only the
 * first supports deleting something. With an empty history table every item stays
 * row-less and therefore unmeasured, exactly as before.
 *
 * A SERIES aggregates as a whole: every episode item of a show carries the show's
 * total across all its episodes, because history names episodes the library
 * cannot identify individually. So a show you are midway through never has any
 * episode looking never-watched.
 */
@Injectable()
export class PlaybackAggregateService {
  private readonly logger = new Logger(PlaybackAggregateService.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Interval(REBUILD_INTERVAL_MS)
  async scheduledRebuild(): Promise<void> {
    try {
      await this.rebuild();
    } catch (err) {
      // A failed rebuild must never take the process down; the previous
      // aggregates stay in place and the next tick tries again.
      this.logger.warn(`Playback aggregate rebuild failed: ${(err as Error).message}`);
    }
  }

  /**
   * Rebuild every aggregate from history.
   *
   * A full rebuild rather than an incremental one: history is imported in bulk
   * and can be re-imported or corrected, so recomputing from the source is the
   * only way the result cannot drift from it. The volume is small — one row per
   * finished playback, not per heartbeat.
   */
  async rebuild(
    completionThresholdPercent: number = DEFAULT_COMPLETION_THRESHOLD_PERCENT,
  ): Promise<PlaybackAggregateRebuildResult> {
    if (this.running) {
      this.logger.log('Playback aggregate rebuild already in progress — skipping');
      return {
        historyRows: 0, itemsWithPlayback: 0, itemsWithoutPlayback: 0,
        unresolvedRows: 0, skippedNonMovieRows: 0, written: 0, removed: 0,
      };
    }
    this.running = true;
    try {
      const [rows, items] = await Promise.all([
        this.prisma.mediaServerWatchHistory.findMany({
          select: {
            title: true, mediaType: true, userName: true,
            startedAt: true, stoppedAt: true, watchedSeconds: true, percentComplete: true,
          },
        }),
        this.prisma.mediaItem.findMany({
          // Both kinds, indexed separately: a film resolves to one item, an
          // episode row resolves to its whole series.
          where: { mediaType: { in: ['movie', 'tv', 'anime'] } },
          select: { id: true, title: true, year: true, mediaType: true },
        }),
      ]);

      /*
       * No history at all means nothing was measured. Writing zeros here would
       * declare the entire library never-watched on the strength of an empty
       * table — which is what an analytics integration looks like the day it
       * breaks. Leave every item row-less and therefore unmeasured.
       */
      if (rows.length === 0) {
        this.logger.log('No watch history imported — leaving playback unmeasured');
        return {
          historyRows: 0, itemsWithPlayback: 0, itemsWithoutPlayback: 0,
          unresolvedRows: 0, skippedNonMovieRows: 0, written: 0, removed: 0,
        };
      }

      const movies = items.filter((i) => i.mediaType === 'movie');
      const episodes = items.filter((i) => i.mediaType !== 'movie');
      const resolution = resolvePlaybackRows(rows, buildTitleIndex(movies, episodes));
      const now = new Date();

      const records = items.map((item) => {
        // `aggregatePlays([])` is the zero aggregate: no plays, no viewers, no
        // last-played date — which is precisely the claim being made.
        const facts = aggregatePlays(resolution.byItem.get(item.id) ?? [], completionThresholdPercent);
        return {
          mediaItemId: item.id,
          startedPlayCount: facts.startedPlayCount,
          completedPlayCount: facts.completedPlayCount,
          uniqueViewerCount: facts.uniqueViewerCount,
          lastPlayedAt: facts.lastPlayedAt,
          maximumProgressPercent: Math.round(facts.maximumProgressPercent),
          averageProgressPercent: facts.averageProgressPercent,
          totalPlaybackSeconds: BigInt(Math.max(0, Math.round(facts.totalPlaybackSeconds))),
          completionThresholdPercent,
          // Provenance: rows seen for this item, and how many carried a usable
          // progress reading. Both zero is a genuine "not in the history".
          sourceRowCount: facts.sourceRowCount,
          resolvedSourceRowCount: facts.measuredProgressRowCount,
          computedAt: now,
        };
      });

      /*
       * Replaced wholesale in one transaction rather than upserted row by row.
       * A library is tens of thousands of items, and a per-row upsert is that
       * many round trips — minutes on the NAS. The transaction matters because
       * the gap between delete and insert is a window where every item reads as
       * unmeasured, and a cleanup run landing in it would exclude everything.
       */
      const CHUNK = 2_000;
      const chunks: (typeof records)[] = [];
      for (let i = 0; i < records.length; i += CHUNK) chunks.push(records.slice(i, i + CHUNK));
      const removed = await this.prisma.mediaPlaybackAggregate.count();
      await this.prisma.$transaction([
        this.prisma.mediaPlaybackAggregate.deleteMany({}),
        ...chunks.map((data) => this.prisma.mediaPlaybackAggregate.createMany({ data })),
      ]);

      const result: PlaybackAggregateRebuildResult = {
        historyRows: rows.length,
        itemsWithPlayback: resolution.byItem.size,
        itemsWithoutPlayback: records.length - resolution.byItem.size,
        unresolvedRows: resolution.unresolved,
        skippedNonMovieRows: resolution.skippedNonMovie,
        written: records.length,
        removed,
      };
      this.logger.log(
        `Playback aggregates rebuilt: ${result.written} item(s) from ${result.historyRows} history row(s) — `
          + `${result.itemsWithPlayback} with plays, ${result.itemsWithoutPlayback} with none `
          + `(${result.unresolvedRows} rows unresolved, ${result.skippedNonMovieRows} skipped)`,
      );
      return result;
    } finally {
      this.running = false;
    }
  }
}
