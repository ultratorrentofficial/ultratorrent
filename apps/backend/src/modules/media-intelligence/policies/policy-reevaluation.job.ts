import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PERMISSIONS } from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { JobRegistry } from '../../jobs/platform/job-registry.service';
import { PlatformJobService } from '../../jobs/platform/platform-job.service';
import { ACTIVE_STATUSES } from '../../jobs/platform/job-status';
import type { JobExecutionContext } from '../../jobs/platform/job.types';
import { MediaIntelligenceProjectionService } from '../media-intelligence-projection.service';

export const POLICY_REEVALUATE_JOB_TYPE = 'media_intelligence.policy_reevaluate';

/** Why the sweep was asked for. Display only; nothing branches on it. */
export interface PolicyReevaluateInput {
  policyId: string | null;
  policyName: string | null;
  reason: 'created' | 'updated' | 'deleted';
}

/**
 * Re-evaluating the library after operator intent changed.
 *
 * A policy edit can change what UltraTorrent recommends for every title it
 * scopes — a global one reaches ~30,000 entities here. Doing that inside the
 * PATCH would hold an HTTP request open for minutes, so the request persists
 * the intent and returns, and this job does the work where it can be watched
 * and cancelled.
 *
 * **It reuses `rebuildAll` rather than reimplementing paging.** That method
 * already pages in 250s, isolates a failing entity so one bad row cannot
 * abort a run, reads the policies ONCE for the whole sweep, and publishes a
 * single digest at the end. A second traversal would drift from it.
 *
 * **It is not a second scheduler.** The 6-hourly reconcile remains the only
 * clock; this is an on-demand run triggered by a human act. Adding another
 * `@Interval` would need a second name in the manifest and would surface in
 * the Jobs Center as a competing sweep.
 */
@Injectable()
export class PolicyReevaluationJob implements OnModuleInit {
  private readonly logger = new Logger(PolicyReevaluationJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
    private readonly jobs: PlatformJobService,
    private readonly projections: MediaIntelligenceProjectionService,
  ) {}

  onModuleInit(): void {
    if (this.registry.has(POLICY_REEVALUATE_JOB_TYPE)) return;
    this.registry.register(
      {
        type: POLICY_REEVALUATE_JOB_TYPE,
        moduleKey: 'media_intelligence',
        workspaceKey: 'media',
        labelKey: 'jobs.policyReevaluate.label',
        descriptionKey: 'jobs.policyReevaluate.description',
        /*
         * `scan`, not `view`: this is the same kind of act as a library-wide
         * rebuild — recompute everything from what is already stored — and
         * `scan` is the permission that already means "you may make this
         * system do work". It is NOT the policy-authoring permission, because
         * the job itself changes no intent.
         */
        requiredPermission: PERMISSIONS.MEDIA_MANAGER_SCAN,
        /*
         * Cancellable because 30,000 entities is long enough that an operator
         * will want to stop it. Deliberately not retryable: an automatic
         * retry would restart a full sweep nobody asked for. Not pausable or
         * resumable either — that needs checkpointing, and a sweep is
         * idempotent enough to simply run again.
         */
        capabilities: { cancellable: true, retryable: false, pausable: false, resumable: false },
        defaultMaxAttempts: 1,
        validateInput: (i) => this.validate(i),
        summarizeInput: (i) => ({
          policyId: (i as PolicyReevaluateInput)?.policyId ?? null,
          policyName: (i as PolicyReevaluateInput)?.policyName ?? null,
          reason: (i as PolicyReevaluateInput)?.reason ?? 'updated',
        }),
      },
      { execute: (input, ctx) => this.execute(input as PolicyReevaluateInput, ctx) },
    );
  }

  private validate(raw: unknown): PolicyReevaluateInput {
    const o = (raw ?? {}) as Partial<PolicyReevaluateInput>;
    return {
      policyId: o.policyId ?? null,
      policyName: o.policyName ?? null,
      reason: o.reason ?? 'updated',
    };
  }

  /**
   * Ask for a re-evaluation. Idempotent.
   *
   * One sweep is one sweep: editing three policies in quick succession must
   * not start three traversals of the library. `runDetached` bypasses
   * `enqueue`'s own idempotency short-circuit, so the guarantee has to be
   * enforced here — an in-flight run is returned untouched, and because the
   * sweep re-reads every policy when it starts, it will already include the
   * edits made while it was queued.
   */
  async request(input: PolicyReevaluateInput, runAsUserId?: string): Promise<{ jobId: string }> {
    const normalized = this.validate(input);
    const idempotencyKey = 'media-intelligence:policy-reevaluate';

    const existing = await this.prisma.platformJob.findFirst({
      where: { idempotencyKey, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true },
    });
    if (existing) return { jobId: existing.id };

    return this.jobs.runDetached<PolicyReevaluateInput>({
      type: POLICY_REEVALUATE_JOB_TYPE,
      input: normalized,
      name: normalized.policyName
        ? `Re-evaluate policies: ${normalized.policyName}`
        : 'Re-evaluate lifecycle policies',
      source: 'manual',
      resourceType: 'media_lifecycle_policy',
      resourceId: normalized.policyId ?? 'all',
      runAsUserId,
      idempotencyKey,
    });
  }

  private async execute(input: PolicyReevaluateInput, ctx: JobExecutionContext) {
    /*
     * The scheduled sweep and this job do the same work, so they must not
     * overlap — `rebuildAll` would refuse the second caller anyway, but
     * reporting that honestly beats a job that "succeeded" having done
     * nothing.
     */
    if (this.projections.isRebuilding()) {
      await ctx.warn('jobs.policyReevaluate.alreadyRunning');
      return { resultSummary: { skipped: true, reason: 'reconciliation_already_running' } };
    }

    await ctx.setPhase('evaluating', 'jobs.policyReevaluate.phase');
    // No known total up front: the sweep discovers entities as it pages.
    await ctx.progress({ indeterminate: true, unit: 'entities' });
    ctx.signal.throwIfCancelled();

    const summary = await this.projections.rebuildAll();
    await ctx.heartbeat();

    this.logger.log(
      `Policy re-evaluation (${input.reason}): ${summary.movies} movies, ${summary.series} series, ` +
        `${summary.failed} failed${summary.skipped ? ' (skipped — already running)' : ''}.`,
    );

    return {
      resultSummary: {
        reason: input.reason,
        policyId: input.policyId,
        movies: summary.movies,
        series: summary.series,
        failed: summary.failed,
        skipped: summary.skipped,
      },
      metrics: { movies: summary.movies, series: summary.series, failed: summary.failed },
    };
  }
}
