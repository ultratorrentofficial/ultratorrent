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
 * The absence is still meaningful and is preserved: an item with no resolved
 * history gets NO row, which the evaluator reads as unmeasured rather than as
 * "never watched". This service's job is to make sure that absence means what it
 * says — no history — instead of meaning nobody ever built the table.
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
        historyRows: 0, itemsWithPlayback: 0, unresolvedRows: 0,
        skippedNonMovieRows: 0, written: 0, removed: 0,
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
          where: { mediaType: 'movie' },
          select: { id: true, title: true, year: true },
        }),
      ]);

      const resolution = resolvePlaybackRows(rows, buildTitleIndex(items));
      const now = new Date();
      let written = 0;

      for (const [mediaItemId, itemRows] of resolution.byItem) {
        const facts = aggregatePlays(itemRows, completionThresholdPercent);
        const data = {
          startedPlayCount: facts.startedPlayCount,
          completedPlayCount: facts.completedPlayCount,
          uniqueViewerCount: facts.uniqueViewerCount,
          lastPlayedAt: facts.lastPlayedAt,
          maximumProgressPercent: Math.round(facts.maximumProgressPercent),
          averageProgressPercent: facts.averageProgressPercent,
          totalPlaybackSeconds: BigInt(Math.max(0, Math.round(facts.totalPlaybackSeconds))),
          completionThresholdPercent,
          // Provenance, per item: how many rows we saw for it, and how many
          // carried a usable progress reading. A high gap is what makes an
          // aggregate untrustworthy to delete on.
          sourceRowCount: facts.sourceRowCount,
          resolvedSourceRowCount: facts.measuredProgressRowCount,
          computedAt: now,
        };
        await this.prisma.mediaPlaybackAggregate.upsert({
          where: { mediaItemId },
          create: { mediaItemId, ...data },
          update: data,
        });
        written += 1;
      }

      /*
       * Drop aggregates whose history no longer resolves to them. Leaving one
       * behind would keep asserting a play from history that has since been
       * corrected or removed, and "watched" is the assertion that stops a file
       * being cleaned up — so a stale one hides a candidate forever.
       */
      const removed = await this.prisma.mediaPlaybackAggregate.deleteMany({
        where: { mediaItemId: { notIn: [...resolution.byItem.keys()] } },
      });

      const result: PlaybackAggregateRebuildResult = {
        historyRows: rows.length,
        itemsWithPlayback: resolution.byItem.size,
        unresolvedRows: resolution.unresolved,
        skippedNonMovieRows: resolution.skippedNonMovie,
        written,
        removed: removed.count,
      };
      this.logger.log(
        `Playback aggregates rebuilt: ${result.written} item(s) from ${result.historyRows} history row(s) `
          + `(${result.unresolvedRows} unresolved, ${result.skippedNonMovieRows} non-movie skipped, `
          + `${result.removed} stale removed)`,
      );
      return result;
    } finally {
      this.running = false;
    }
  }
}
