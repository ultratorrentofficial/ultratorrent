import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaProbeService } from './media-probe.service';

const TICK_MS = 5 * 60_000;
/**
 * Files probed per tick. A probe is a header read (~110–190 ms measured on a NAS),
 * so 200 is ~30 s of IO every 5 minutes — enough to clear a 29k-file library in about
 * a day of background work, while leaving the disks alone the other 95% of the time.
 * Deliberately NOT "probe everything at once": that would hammer a spinning NAS that
 * is also serving Plex.
 */
const BATCH = 200;
/** Concurrent probes within a batch. Each spawns a process and seeks the disk. */
const CONCURRENCY = 4;

/**
 * Backfills measured technical metadata onto media files that only ever had it
 * guessed from their filename.
 *
 * The scan writes codec/resolution by parsing the filename, and the renamer strips
 * those tokens — so on a renamed library the columns are mostly null (measured: 4%
 * had a videoCodec, 0% an hdr). Everything downstream that reads them is therefore
 * blind: `media-duplicate` scores every copy 0 and cannot say which is better, and
 * `quality-compare` explicitly excludes bitrate because a release name never carries
 * it. This fills those columns from the container itself.
 *
 * Resumable by construction: the working set is a query ("never probed, not already
 * failed"), not a cursor, so a restart mid-backfill simply continues. A file that
 * cannot be read records WHY and is never retried — otherwise one corrupt file would
 * be re-probed on every tick forever.
 */
@Injectable()
export class MediaProbeBackfillService {
  private readonly logger = new Logger(MediaProbeBackfillService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly probe: MediaProbeService,
  ) {}

  @Interval('media_probe_backfill', TICK_MS)
  async tick(): Promise<void> {
    // Claim synchronously (before any await) so a slow batch can't overlap the next
    // tick and double the IO on the library disks.
    if (this.running) return;
    this.running = true;
    try {
      await this.runBatch(BATCH);
    } catch (err) {
      this.logger.warn(`Probe backfill tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** How much of the library still has no measured metadata. */
  async pending(): Promise<{ pending: number; probed: number; failed: number }> {
    const [pending, probed, failed] = await Promise.all([
      this.prisma.mediaFile.count({ where: { probedAt: null, probeError: null } }),
      this.prisma.mediaFile.count({ where: { techSource: 'probe' } }),
      this.prisma.mediaFile.count({ where: { probeError: { not: null } } }),
    ]);
    return { pending, probed, failed };
  }

  /**
   * Probe one batch. Exposed so an operator can drive it directly (and so the tests
   * don't have to wait on a timer).
   */
  async runBatch(limit = BATCH): Promise<{ probed: number; failed: number }> {
    if (!(await this.probe.isAvailable())) return { probed: 0, failed: 0 };

    const files = await this.prisma.mediaFile.findMany({
      where: { probedAt: null, probeError: null },
      select: { id: true, path: true },
      take: limit,
    });
    if (!files.length) return { probed: 0, failed: 0 };

    let probed = 0;
    let failed = 0;

    // Fixed-size worker pool: pull from a shared cursor rather than chunking, so one
    // slow file doesn't stall a whole chunk behind it.
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= files.length) return;
        const file = files[i];
        try {
          const tech = await this.probe.probe(file.path);
          await this.prisma.mediaFile.update({
            where: { id: file.id },
            data: {
              ...tech,
              techSource: 'probe',
              probedAt: new Date(),
              probeError: null,
            },
          });
          probed += 1;
        } catch (err) {
          // Record the reason and move on. Setting probeError takes the file OUT of
          // the working set, so a corrupt/missing file is attempted exactly once.
          const message = (err as Error).message.slice(0, 300);
          await this.prisma.mediaFile
            .update({ where: { id: file.id }, data: { probeError: message } })
            .catch(() => undefined); // the row may have been deleted by a rescan
          failed += 1;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

    if (probed || failed) {
      const { pending } = await this.pending();
      this.logger.log(
        `Probe backfill: ${probed} probed, ${failed} unreadable, ${pending} remaining`,
      );
    }
    return { probed, failed };
  }
}
