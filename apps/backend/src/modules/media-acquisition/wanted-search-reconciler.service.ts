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
 * It also releases rows stranded the OTHER way — see {@link releaseDeadGrabs}.
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
  async reconcile(): Promise<{ episodes: number; movies: number; deadGrabs: number }> {
    const result = { episodes: 0, movies: 0, deadGrabs: 0 };
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

      result.deadGrabs = await this.releaseDeadGrabs();

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

  /**
   * Puts an episode back in the search pool when the release it grabbed turned
   * out to be dead.
   *
   * The same leak as above, arrived at from the other side. The sweep selects
   * only `idle`, `no_results` and `failed`, so a row that reaches `grabbed` is
   * never revisited — and when that torrent is parked with no seeders and never
   * completes, the episode is neither owned nor searchable. It reads as success
   * in the UI, which is what makes it silent. Measured on a live install: 369
   * episodes stamped `grabbed` but still missing, 357 of them over a week old.
   *
   * "Dead" is the PARKING system's verdict, not a guess about elapsed time. A
   * parked torrent has already been force-probed repeatedly (`probeCount`) and
   * still reported no seeders, so this cannot mistake a slow download for a dead
   * one — which an age-based rule would.
   *
   * The release title is remembered in `deadReleases` before the reset. Without
   * that the selector would rank the same candidate list, re-pick the same
   * corpse, and re-park it on every sweep forever; with it, each retry reaches
   * for the next-best release. `failed` rather than `idle` so the row rejoins on
   * the normal search backoff instead of being retried immediately.
   */
  private async releaseDeadGrabs(): Promise<number> {
    const MIN_PROBES = 3;

    const stuck = await this.prisma.wantedEpisode.findMany({
      where: { searchStatus: 'grabbed', status: 'missing', torrentHash: { not: null } },
      select: { id: true, torrentHash: true, releaseTitle: true, deadReleases: true },
    });
    if (stuck.length === 0) return 0;

    const parked = await this.prisma.parkedTorrent.findMany({
      where: {
        hash: { in: stuck.map((w) => w.torrentHash as string) },
        probeCount: { gte: MIN_PROBES },
        lastSeeders: 0,
      },
      select: { hash: true },
    });
    const dead = new Set(parked.map((p) => p.hash));
    if (dead.size === 0) return 0;

    let released = 0;
    for (const w of stuck) {
      if (!dead.has(w.torrentHash as string)) continue;
      // Keep the list a set: an episode can be reset more than once, and a title
      // recorded twice would be filtered twice for no benefit.
      const deadReleases = w.releaseTitle && !w.deadReleases.includes(w.releaseTitle)
        ? [...w.deadReleases, w.releaseTitle]
        : w.deadReleases;
      await this.prisma.wantedEpisode.updateMany({
        where: { id: w.id },
        data: { searchStatus: 'failed', deadReleases, torrentHash: null, intakeRuleId: null },
      });
      released += 1;
    }

    if (released > 0) {
      this.logger.warn(
        `Released ${released} episode(s) whose grabbed release is dead (parked, no seeders ` +
          `after ${MIN_PROBES}+ probes) — they were stamped "grabbed" and would never have ` +
          `been searched again`,
      );
    }
    return released;
  }
}
