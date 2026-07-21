import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { PlatformJobService } from './platform-job.service';

/** A running job with no heartbeat past this is flagged stalled (advisory, not failed). */
const STALL_THRESHOLD_MS = 5 * 60_000;
const SCAN_INTERVAL_MS = 30_000;

/**
 * Stall & worker-health detection for the platform job engine.
 *
 * Worker *loss* (a process that died mid-job) is reconciled at boot by
 * {@link PlatformJobService.onModuleInit} — in the current single in-process model a
 * restart is the only way a running job's worker vanishes. This periodic pass instead
 * flags jobs that are still `running` but have gone quiet (no heartbeat past the
 * threshold) as **stalled** — an advisory signal for the Jobs Center, not an automatic
 * failure (a long operation that simply isn't heartbeating may be perfectly healthy).
 * Represented honestly: we never fabricate a lost worker for a live process.
 */
@Injectable()
export class JobReliabilityService {
  private readonly logger = new Logger(JobReliabilityService.name);
  /** Jobs already flagged stalled this run — avoids re-emitting each scan. */
  private readonly flagged = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: PlatformJobService,
  ) {}

  @Interval('platform_job_stall_detector', SCAN_INTERVAL_MS)
  async detectStalled(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - STALL_THRESHOLD_MS);
      const running = await this.prisma.platformJob.findMany({
        where: { status: 'running' },
        select: { id: true, heartbeatAt: true, startedAt: true },
        take: 500,
      });
      const liveIds = new Set(running.map((r) => r.id));
      // Drop flags for jobs that have since finished/moved.
      for (const id of this.flagged) if (!liveIds.has(id)) this.flagged.delete(id);

      for (const job of running) {
        const lastBeat = job.heartbeatAt ?? job.startedAt;
        if (!lastBeat || lastBeat >= cutoff) continue;
        if (this.flagged.has(job.id)) continue;
        this.flagged.add(job.id);
        const idleMs = Date.now() - lastBeat.getTime();
        await this.jobs.recordEvent(job.id, 'stalled', {
          level: 'warning',
          metadata: { idleMs, since: lastBeat.toISOString() },
        });
        this.logger.warn(`Job ${job.id} appears stalled (no heartbeat for ${Math.round(idleMs / 1000)}s)`);
      }
    } catch (err) {
      this.logger.debug(`Stall scan failed: ${(err as Error).message}`);
    }
  }
}
