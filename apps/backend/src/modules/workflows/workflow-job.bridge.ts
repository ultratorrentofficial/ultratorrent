import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PERMISSIONS } from '@ultratorrent/shared';
import { JobRegistry } from '../jobs/platform/job-registry.service';
import { PlatformJobService } from '../jobs/platform/platform-job.service';
import type { JobStatus } from '../jobs/platform/job-status';

/**
 * Best-effort mirror of workflow executions into the Unified Jobs Center: an execution is a
 * `workflow.execution` **parent job**; each long-running action node is a `workflow.node`
 * **child job** linked by `parentJobId`. Every call here is wrapped so a Jobs-Center hiccup
 * (an invalid transition, a registry gap) can **never** break the authoritative workflow
 * executor — the mirror is observability, not the source of truth. Reuses the existing
 * platform engine (no new job infrastructure). See Jobs Center architecture.
 */
@Injectable()
export class WorkflowJobBridge implements OnModuleInit {
  private readonly logger = new Logger(WorkflowJobBridge.name);

  constructor(
    private readonly registry: JobRegistry,
    private readonly jobs: PlatformJobService,
  ) {}

  onModuleInit(): void {
    // Registering is a hard requirement for enqueue to work, but must not crash boot.
    try {
      if (!this.registry.has('workflow.execution')) {
        this.registry.register(
          {
            type: 'workflow.execution', moduleKey: 'workflows', workspaceKey: 'automation',
            labelKey: 'jobs.type.workflow_execution', requiredPermission: PERMISSIONS.WORKFLOWS_VIEW,
            capabilities: { cancellable: true, retryable: false, pausable: false, resumable: false },
            validateInput: (i) => i as { executionId: string },
          },
          // No auto-run: the workflow executor drives the execution; this handler only
          // services a platform-initiated rerun.
          { execute: async () => ({ resultSummary: { note: 'driven by the workflow executor' } }) },
        );
      }
      if (!this.registry.has('workflow.node')) {
        this.registry.register(
          {
            type: 'workflow.node', moduleKey: 'workflows', workspaceKey: 'automation',
            labelKey: 'jobs.type.workflow_node', requiredPermission: PERMISSIONS.WORKFLOWS_VIEW,
            capabilities: { cancellable: false, retryable: false, pausable: false, resumable: false },
            validateInput: (i) => i as { executionId: string; nodeId: string; actionId?: string },
          },
          { execute: async () => ({}) },
        );
      }
    } catch (err) {
      this.logger.error(`Job definition registration failed: ${(err as Error).message}`);
    }
  }

  /** Create the parent job for an execution and mark it running. Returns the job id (or null). */
  async createExecutionJob(executionId: string, workflowId: string, name: string, runAsUserId?: string | null): Promise<string | null> {
    try {
      const job = await this.jobs.enqueue({
        type: 'workflow.execution', input: { executionId, workflowId },
        source: 'workflow', name, correlationId: executionId,
        runAsUserId: runAsUserId ?? undefined, resourceType: 'workflow', resourceId: workflowId,
      });
      await this.safe(job.id, ['running']);
      return job.id;
    } catch (err) {
      this.logger.debug(`createExecutionJob failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Park the parent job while the execution is in a durable wait (kept out of RUNNING states,
   *  so the platform's boot reconcile won't mark a legitimately-waiting job failed). */
  async park(jobId: string | null): Promise<void> {
    if (jobId) await this.safe(jobId, ['pausing', 'paused']);
  }

  /** Bring the parent job back to running when its execution resumes. */
  async unpark(jobId: string | null): Promise<void> {
    if (jobId) await this.safe(jobId, ['running']);
  }

  /** Drive the parent job to the terminal state matching the execution outcome. */
  async finish(jobId: string | null, executionStatus: string): Promise<void> {
    if (!jobId) return;
    switch (executionStatus) {
      case 'completed': await this.safe(jobId, ['completed']); break;
      case 'completed_with_warnings': await this.safe(jobId, ['completed_with_warnings']); break;
      case 'failed': await this.safe(jobId, ['failed']); break;
      case 'cancelled': await this.safe(jobId, ['cancelling', 'cancelled'], ['cancelled']); break;
      default: break;
    }
  }

  /** Create a child job for a long-running action node; returns its id (or null). */
  async startNodeJob(execJobId: string | null, executionId: string, nodeId: string, actionId?: string): Promise<string | null> {
    if (!execJobId) return null;
    try {
      const job = await this.jobs.enqueue({
        type: 'workflow.node', input: { executionId, nodeId, actionId },
        source: 'workflow', name: actionId ?? nodeId, parentJobId: execJobId, correlationId: executionId,
      });
      await this.safe(job.id, ['running']);
      return job.id;
    } catch (err) {
      this.logger.debug(`startNodeJob failed: ${(err as Error).message}`);
      return null;
    }
  }

  async finishNodeJob(jobId: string | null, ok: boolean): Promise<void> {
    if (jobId) await this.safe(jobId, [ok ? 'completed' : 'failed']);
  }

  async cancelJob(jobId: string | null): Promise<void> {
    if (!jobId) return;
    try { await this.jobs.requestCancel(jobId); } catch (err) { this.logger.debug(`cancelJob: ${(err as Error).message}`); }
  }

  /**
   * Apply a transition path, each hop best-effort. If `fallback` is given and the primary
   * path throws, try the fallback path (e.g. a paused job cancels directly, a running one via
   * `cancelling`). Never throws.
   */
  private async safe(jobId: string, path: JobStatus[], fallback?: JobStatus[]): Promise<void> {
    try {
      for (const to of path) await this.jobs.transition(jobId, to);
    } catch {
      if (!fallback) return;
      try { for (const to of fallback) await this.jobs.transition(jobId, to); } catch { /* mirror only */ }
    }
  }
}
