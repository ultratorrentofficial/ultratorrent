import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaIntakeService } from './media-intake.service';

/**
 * Close out intakes whose torrent is gone.
 *
 * `seeding -> archived` is a legal transition the pipeline has always defined
 * and nothing has ever performed, so `seeding` was terminal in practice: a job
 * kept claiming to seed long after its torrent was removed and its payload
 * deleted. Measured on two live hosts, 64 of 146 "seeding" jobs — 40% — were
 * describing torrents that no longer existed.
 *
 * That is not cosmetic. `state` is what the rest of the application reads to
 * decide whether something is still seeding, so every consumer inherited the
 * lie: reports over-counted, and a cleanup asking "is this still seeding?" got
 * a yes for a torrent removed weeks ago. The honest answer only ever came from
 * the engine, so that is what this asks.
 */
@Injectable()
export class IntakeReconcilerService {
  private readonly logger = new Logger(IntakeReconcilerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly intake: MediaIntakeService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Hourly. The condition changes only when an operator removes a torrent, so
   * polling faster would buy nothing; the cost is one engine listing.
   */
  @Interval('intake_seeding_reconcile', 60 * 60_000)
  async reconcile(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await this.prisma.mediaIntakeJob.findMany({
        where: { state: 'seeding' },
        select: { id: true, torrentHash: true, sourcePath: true },
      });
      if (!jobs.length) return 0;

      const live = await this.liveHashes();
      /*
       * An empty set is ambiguous — an engine that is down looks exactly like
       * an engine with no torrents — and acting on it would archive every
       * intake in one sweep. Refuse rather than guess.
       */
      if (!live) {
        this.logger.debug('Skipping reconcile: could not read the engine.');
        return 0;
      }

      let archived = 0;
      for (const job of jobs) {
        // No hash recorded means nothing to check against; leave it alone.
        if (!job.torrentHash) continue;
        if (live.has(job.torrentHash.toLowerCase())) continue;
        try {
          await this.intake.transition(job.id, 'archived', {
            message: 'Archived: the torrent is no longer in the engine',
          });
          archived += 1;
        } catch (err) {
          // A refused transition is a state-machine fact, not a crash: the job
          // may have moved on since the query.
          this.logger.debug(`Could not archive ${job.id}: ${(err as Error).message}`);
        }
      }
      if (archived) this.logger.log(`Archived ${archived} intake(s) whose torrent is gone`);
      return archived;
    } finally {
      this.running = false;
    }
  }

  /**
   * Every hash the engine currently holds, or null when it could not be read.
   *
   * Null and empty are deliberately different: "no torrents" is a legitimate
   * answer that would archive everything, and "engine unreachable" must not be
   * mistaken for it.
   */
  private async liveHashes(): Promise<Set<string> | null> {
    try {
      const { TorrentsService } = await import('../torrents/torrents.service');
      const torrents = this.moduleRef.get(TorrentsService, { strict: false });
      const listed = await torrents.list({ pageSize: 5000 } as never);
      const items = (listed as unknown as { items?: Array<{ hash?: string }> }).items;
      if (!Array.isArray(items)) return null;
      return new Set(items.map((t) => (t.hash ?? '').toLowerCase()).filter(Boolean));
    } catch (err) {
      this.logger.debug(`Engine listing failed: ${(err as Error).message}`);
      return null;
    }
  }
}
