import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Releases wanted rows stranded mid-search by a restart.
 *
 * The missing-episode sweep flips `searchStatus` to `searching` **before** it calls
 * the indexers, so a process that dies — or is simply redeployed — in the middle of
 * a sweep leaves those rows marked `searching` forever. The sweep only ever selects
 * `idle`, `no_results` and `failed`, so a stranded row is **never searched again**
 * and its episode can never be acquired. It is a silent, permanent leak: observed in
 * production as 20 episodes on synoplex and 3 on ehr-qnap, stranded by a day of
 * deploys, with nothing to surface them.
 *
 * Nothing can legitimately still be mid-search across a boot (the sweep is
 * in-process and re-entrancy-guarded), so anything left `searching` at startup was
 * interrupted. Reset it to `idle` and the next sweep picks it up.
 *
 * This lives in its own file deliberately: it is the same shape as the job
 * reconciliation that already runs at boot, and keeping it separate leaves the sweep
 * service untouched.
 */
@Injectable()
export class WantedSearchReconciler implements OnModuleInit {
  private readonly logger = new Logger(WantedSearchReconciler.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reconcile();
  }

  /** Returns how many rows were released. Never throws — this must not block boot. */
  async reconcile(): Promise<{ episodes: number; movies: number }> {
    const result = { episodes: 0, movies: 0 };
    try {
      const episodes = await this.prisma.wantedEpisode.updateMany({
        where: { searchStatus: 'searching' },
        data: { searchStatus: 'idle' },
      });
      result.episodes = episodes.count;

      // Movies carry the same column and will strand the same way once they are
      // searched; reconcile them now rather than leave the trap armed.
      const movies = await this.prisma.wantedMovie.updateMany({
        where: { searchStatus: 'searching' },
        data: { searchStatus: 'idle' },
      });
      result.movies = movies.count;

      const total = result.episodes + result.movies;
      if (total > 0) {
        this.logger.warn(
          `Released ${total} wanted row(s) left mid-search by a restart ` +
            `(${result.episodes} episode(s), ${result.movies} movie(s)) — they were stranded and would never have been searched again`,
        );
      }
    } catch (err) {
      this.logger.warn(`Could not reconcile interrupted searches: ${(err as Error).message}`);
    }
    return result;
  }
}
