import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PERMISSIONS } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { JobRegistry } from './job-registry.service';
import { PlatformJobService } from './platform-job.service';
import { RETENTION_DONE_DAYS, RETENTION_FAILED_DAYS, RETENTION_SCAN_INTERVAL_MS } from './job-constants';

const RETENTION_JOB_TYPE = 'jobs.retention_cleanup';

/**
 * Retention & cleanup for the Jobs Center — and, per the design, cleanup is **itself a
 * registered, observable platform job** (not a hidden cron): the scheduler enqueues a
 * `jobs.retention_cleanup` job whose handler prunes old terminal rows, so the cleanup
 * appears in the Jobs Center with its own lifecycle/progress/result. Failed jobs are
 * kept longer than successful ones (for diagnosis). `platform_job_events` cascade-delete
 * with their job (FK), so pruning a job prunes its events.
 */
@Injectable()
export class JobRetentionService implements OnModuleInit {
  private readonly logger = new Logger(JobRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
    private readonly jobs: PlatformJobService,
  ) {}

  onModuleInit(): void {
    if (this.registry.has(RETENTION_JOB_TYPE)) return;
    this.registry.register(
      {
        type: RETENTION_JOB_TYPE,
        moduleKey: 'jobs_center',
        workspaceKey: 'system',
        labelKey: 'jobs.type.retention_cleanup',
        requiredPermission: PERMISSIONS.JOBS_ADMIN,
        capabilities: { cancellable: false, retryable: false, pausable: false, resumable: false },
        validateInput: (i) => i ?? {},
      },
      { execute: async (_input, ctx) => this.prune(ctx.metric) },
    );
  }

  /** Enqueue the cleanup as an observable job (skips if one is already active). */
  @Interval('platform_job_retention_cleanup', RETENTION_SCAN_INTERVAL_MS)
  async scheduleCleanup(): Promise<void> {
    try {
      await this.jobs.runDetached({
        type: RETENTION_JOB_TYPE,
        input: {},
        name: 'Retention cleanup',
        source: 'scheduled',
        idempotencyKey: RETENTION_JOB_TYPE, // one active cleanup at a time
      });
    } catch (err) {
      this.logger.debug(`Retention cleanup enqueue failed: ${(err as Error).message}`);
    }
  }

  private async prune(metric: (name: string, value: number) => void): Promise<{ result: { done: number; failed: number } }> {
    const doneCutoff = new Date(Date.now() - RETENTION_DONE_DAYS * 24 * 60 * 60_000);
    const failedCutoff = new Date(Date.now() - RETENTION_FAILED_DAYS * 24 * 60 * 60_000);
    const done = await this.prisma.platformJob.deleteMany({
      where: { status: { in: ['completed', 'completed_with_warnings', 'cancelled', 'skipped', 'expired'] }, updatedAt: { lt: doneCutoff } },
    });
    const failed = await this.prisma.platformJob.deleteMany({
      where: { status: 'failed', updatedAt: { lt: failedCutoff } },
    });
    metric('prunedDone', done.count);
    metric('prunedFailed', failed.count);
    if (done.count + failed.count > 0) this.logger.log(`Retention pruned ${done.count} finished + ${failed.count} failed job(s)`);
    return { result: { done: done.count, failed: failed.count } };
  }
}
