import { Injectable, Logger } from '@nestjs/common';
import type { TorrentWithPlatformState } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Mark the torrents Media Intake is managing.
 *
 * The engine cannot tell these apart from anything else: an intake grab is an
 * ordinary torrent with an ordinary save path, so the only way to know whether
 * the platform would import and clean up a given row was to hover it and read
 * its provenance. On a queue of several hundred that is the question asked most
 * often and answered least conveniently.
 *
 * Deliberately shaped like `TorrentParkingService.annotate`, and called
 * immediately after it, because the same trap applies: the live `torrents.*`
 * broadcast REPLACES the list the REST call returned, so an annotation applied
 * on only one of the two paths disappears on the next tick.
 *
 * Best-effort, for the same reason parking is: this decorates a list, and
 * failing the list because the decoration failed trades the whole answer for
 * part of it.
 */
@Injectable()
export class TorrentIntakeAnnotatorService {
  private readonly logger = new Logger(TorrentIntakeAnnotatorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async annotate(torrents: readonly TorrentWithPlatformState[]): Promise<TorrentWithPlatformState[]> {
    if (!torrents.length) return [];

    const hashes = torrents.map((t) => t.hash).filter(Boolean);
    let byHash = new Map<string, { id: string; state: string; mediaItemId: string | null }>();
    try {
      /*
       * Scoped to the hashes on the page, never the whole table — an install
       * with thousands of intakes must not turn a 50-row page into a
       * thousand-row read.
       *
       * Ordered oldest-first so the newest job for a hash wins the map: a
       * torrent re-imported after a `Clear status` teardown has more than one
       * job in its history, and the current one is what the row is about.
       */
      const jobs = await this.prisma.mediaIntakeJob.findMany({
        where: { torrentHash: { in: hashes, mode: 'insensitive' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, state: true, torrentHash: true, mediaItemId: true },
      });
      byHash = new Map(
        jobs
          .filter((j) => j.torrentHash)
          // Lower-cased: the engine's hash and the stored one differ in case
          // often enough that matching on the raw value silently finds nothing.
          .map((j) => [j.torrentHash!.toLowerCase(), { id: j.id, state: j.state, mediaItemId: j.mediaItemId }]),
      );
    } catch (err) {
      this.logger.warn(`Could not read intake state: ${(err as Error).message}`);
      return torrents as TorrentWithPlatformState[];
    }

    return torrents.map((t) => {
      const job = byHash.get((t.hash ?? '').toLowerCase());
      return {
        ...t,
        intake: job ? { jobId: job.id, state: job.state, imported: job.mediaItemId != null } : null,
      };
    });
  }
}
