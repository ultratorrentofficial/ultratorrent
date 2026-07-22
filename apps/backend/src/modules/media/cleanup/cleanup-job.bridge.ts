import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PERMISSIONS } from '@ultratorrent/shared';
import { JobRegistry } from '../../jobs/platform/job-registry.service';
import { PlatformJobService } from '../../jobs/platform/platform-job.service';
import type { JobStatus } from '../../jobs/platform/job-status';

/**
 * Best-effort mirror of cleanup work into the Unified Jobs Center, following the
 * Workflow Builder's bridge exactly: a run is a `library_cleanup.run` job, a plan
 * execution a `library_cleanup.execution` job.
 *
 * Every call is wrapped so a Jobs-Center hiccup — an invalid transition, a registry
 * gap — can **never** break the authoritative cleanup path. The mirror is
 * observability; the cleanup rows are the source of truth. That matters more here
 * than anywhere else in the platform: a bridge failure must not be able to abort a
 * scan half-way, and must certainly not be able to leave a plan mid-execution.
 *
 * Neither job type auto-runs. A cleanup that could be started by the Jobs Center's
 * generic retry would be a destructive operation nobody approved at that moment.
 */
@Injectable()
export class CleanupJobBridge implements OnModuleInit {
  private readonly logger = new Logger(CleanupJobBridge.name);

  constructor(
    private readonly registry: JobRegistry,
    private readonly jobs: PlatformJobService,
  ) {}

  onModuleInit(): void {
    try {
      if (!this.registry.has('library_cleanup.run')) {
        this.registry.register(
          {
            type: 'library_cleanup.run', moduleKey: 'library_cleanup', workspaceKey: 'media',
            labelKey: 'jobs.type.library_cleanup_run',
            requiredPermission: PERMISSIONS.LIBRARY_CLEANUP_VIEW,
            // Not retryable: a retry would re-scan on a schedule nobody chose.
            capabilities: { cancellable: true, retryable: false, pausable: false, resumable: false },
            validateInput: (i) => i as { runId: string; policyId: string },
          },
          { execute: async () => ({ resultSummary: { note: 'driven by the cleanup scanner' } }) },
        );
      }
      if (!this.registry.has('library_cleanup.execution')) {
        this.registry.register(
          {
            type: 'library_cleanup.execution', moduleKey: 'library_cleanup', workspaceKey: 'media',
            labelKey: 'jobs.type.library_cleanup_execution',
            requiredPermission: PERMISSIONS.LIBRARY_CLEANUP_VIEW,
            // Deliberately NOT retryable and NOT resumable. Re-running a plan
            // execution from the Jobs Center would be a destructive act taken
            // without an approval, which is the one thing this feature exists to
            // prevent. A new plan is the only way to try again.
            capabilities: { cancellable: false, retryable: false, pausable: false, resumable: false },
            validateInput: (i) => i as { planId: string },
          },
          { execute: async () => ({ resultSummary: { note: 'driven by the plan executor' } }) },
        );
      }
    } catch (err) {
      this.logger.error(`Cleanup job registration failed: ${(err as Error).message}`);
    }
  }

  async startRunJob(runId: string, policyId: string, name: string, userId?: string | null): Promise<string | null> {
    try {
      const job = await this.jobs.enqueue({
        type: 'library_cleanup.run', input: { runId, policyId },
        source: 'system', name, correlationId: runId,
        runAsUserId: userId ?? undefined, resourceType: 'media_cleanup_policy', resourceId: policyId,
      });
      await this.safe(job.id, ['running']);
      return job.id;
    } catch (err) {
      this.logger.debug(`startRunJob failed: ${(err as Error).message}`);
      return null;
    }
  }

  async startExecutionJob(planId: string, name: string, userId?: string | null): Promise<string | null> {
    try {
      const job = await this.jobs.enqueue({
        type: 'library_cleanup.execution', input: { planId },
        source: 'manual', name, correlationId: planId,
        runAsUserId: userId ?? undefined, resourceType: 'media_cleanup_plan', resourceId: planId,
      });
      await this.safe(job.id, ['running']);
      return job.id;
    } catch (err) {
      this.logger.debug(`startExecutionJob failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Drive a mirrored job to the terminal state matching the cleanup outcome. */
  async finish(jobId: string | null, status: string): Promise<void> {
    if (!jobId) return;
    switch (status) {
      case 'completed': await this.safe(jobId, ['completed']); break;
      // A partial run left files alone on purpose; `completed_with_warnings` is the
      // job state that says "finished, but look at it".
      case 'partial': await this.safe(jobId, ['completed_with_warnings']); break;
      case 'failed': await this.safe(jobId, ['failed']); break;
      case 'cancelled': await this.safe(jobId, ['cancelling', 'cancelled'], ['cancelled']); break;
      default: break;
    }
  }

  private async safe(jobId: string, path: JobStatus[], fallback?: JobStatus[]): Promise<void> {
    try {
      for (const to of path) await this.jobs.transition(jobId, to);
    } catch {
      if (!fallback) return;
      try { for (const to of fallback) await this.jobs.transition(jobId, to); } catch { /* mirror only */ }
    }
  }
}
