import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  isPlanExpired,
  type RemediationBlockReason,
  type RemediationFailureClass,
} from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { recommendationFingerprint } from './remediation-fingerprint';

/**
 * Executing an approved plan — the only code in Phase 6 that causes anything
 * to happen.
 *
 * Every safety property established at planning or approval time is
 * re-established HERE, immediately before the source call, because everything
 * checked earlier describes a world that may have moved on. That discipline
 * is lifted wholesale from `media/cleanup/plan-executor.service.ts`, which
 * already learned it the hard way. In order, per step:
 *
 *   1. the plan is still approved, not expired, not cancelled or superseded
 *   2. the entity still exists
 *   3. nothing locks it NOW — a lock applied since approval still saves it
 *   4. the recommendation still justifies the work, by fingerprint
 *
 * A failed check does not fail the plan. It BLOCKS it, with the reason
 * recorded, because the condition may clear and an operator is owed an
 * explanation rather than a dead row.
 *
 * ## Why the step is journalled before the call
 *
 * `running` is written BEFORE the source domain is invoked. A crash between
 * the two must leave evidence of what was in flight; the alternative is an
 * untraceable gap where nobody can tell whether the action happened. The same
 * reasoning makes the idempotency key deterministic on the recommendation —
 * a retry after an ambiguous failure collides rather than acting twice.
 *
 * ## Why success is not the source call returning
 *
 * `fetchMetadata` resolving means the call did not throw. It does not mean
 * the drift is gone. The plan moves to `verifying`, and only an observation
 * of SOURCE TRUTH — the provider recorded on `MediaMetadata` — can move it to
 * `succeeded`. If the action completed and the desired state is still
 * unsatisfied, that is a failure, and saying otherwise would be the most
 * damaging lie this module could tell.
 */
@Injectable()
export class RemediationPlanExecutorService {
  private readonly logger = new Logger(RemediationPlanExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /*
     * Media services are resolved LAZILY. `MediaModule` is `@Global` and
     * exports them, and a sibling module injects one directly — but the
     * torrent module's own comment records resolving the same service via
     * `ModuleRef` precisely to avoid closing a cycle at bootstrap, and a DI
     * cycle surfaces only at boot, never in tsc or jest. The cautious form
     * costs one lookup.
     */
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Run one approved plan.
   *
   * Claims it with a compare-and-swap so two workers cannot both execute it:
   * the UPDATE names the status it expects, and a zero row count means
   * somebody else got there first. No `SELECT … FOR UPDATE` exists anywhere
   * in this codebase, and this needs none — the status column IS the lease.
   */
  async execute(planId: string, actorUserId?: string): Promise<ExecutionOutcome> {
    const claimed = await this.prisma.mediaRemediationPlan.updateMany({
      where: { id: planId, status: 'approved' },
      data: { status: 'executing', startedAt: new Date() },
    });
    if (claimed.count !== 1) return { status: 'not_claimed' };

    await this.event(planId, 'started', {});

    const plan = await this.prisma.mediaRemediationPlan.findUnique({
      where: { id: planId },
      include: { steps: { orderBy: { ordinal: 'asc' } } },
    });
    // Vanished between the claim and the read. Nothing to run and nothing to
    // report against.
    if (!plan) return { status: 'not_claimed' };

    const gate = await this.recheck(plan);
    if (gate) {
      await this.block(planId, gate);
      return { status: 'blocked', blockReason: gate };
    }

    for (const step of plan.steps) {
      if (step.status === 'succeeded' || step.status === 'skipped') continue;

      const outcome = await this.runStep(plan, step, actorUserId);
      if (outcome.kind === 'blocked') {
        await this.block(planId, outcome.blockReason);
        return { status: 'blocked', blockReason: outcome.blockReason };
      }
      if (outcome.kind === 'failed') {
        await this.fail(planId, outcome.failureClass, outcome.message);
        return { status: 'failed', failureClass: outcome.failureClass };
      }
    }

    /*
     * Every step reported done. That is NOT success — it is the end of the
     * work and the beginning of finding out whether the work mattered.
     */
    await this.transition(planId, 'executing', 'verifying', {});
    await this.event(planId, 'verification_started', {});
    return { status: 'verifying' };
  }

  /**
   * Did the desired state actually become true?
   *
   * Reads the OWNING domain's row directly — `MediaMetadata.providerName` —
   * not the Media Intelligence projection. The projection is downstream of
   * this plan's own work, so asking it would be asking the plan to grade
   * itself; the source row is the only honest witness.
   */
  async verify(planId: string): Promise<ExecutionOutcome> {
    const plan = await this.prisma.mediaRemediationPlan.findUnique({
      where: { id: planId },
      include: { steps: { orderBy: { ordinal: 'asc' } } },
    });
    if (!plan || plan.status !== 'verifying') return { status: 'not_claimed' };

    const satisfied = await this.postconditionsMet(plan);
    if (satisfied === null) {
      /*
       * Could not tell. Not a success and not a failure — the plan stays in
       * `verifying` and the next sweep asks again. An unobservable
       * postcondition must never be read as a satisfied one.
       */
      return { status: 'verifying' };
    }

    if (satisfied) {
      await this.transition(planId, 'verifying', 'succeeded', { completedAt: new Date() });
      await this.event(planId, 'reconciliation_satisfied', {});
      return { status: 'succeeded' };
    }

    /*
     * The action completed and the desired state is still unmet. Recorded as
     * a failure with its own class, because "we did the thing and it did not
     * work" is a different fact from "the thing threw".
     */
    await this.fail(planId, 'permanent', 'postcondition_unmet');
    await this.event(planId, 'verification_failed', {});
    return { status: 'failed', failureClass: 'permanent' };
  }

  /* ------------------------------------------------------------- one step */

  private async runStep(
    plan: PlanRow,
    step: StepRow,
    actorUserId?: string,
  ): Promise<StepOutcome> {
    /*
     * Journalled BEFORE the source call. A crash in the window between this
     * write and the call leaves a `running` row naming exactly what was in
     * flight, rather than a gap nobody can interpret.
     */
    await this.prisma.mediaRemediationStep.update({
      where: { id: step.id },
      data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } },
    });
    await this.event(plan.id, 'step_started', { ordinal: step.ordinal, kind: step.kind });

    try {
      const result = await this.invoke(step, actorUserId);
      if (result.kind !== 'ok') return result;

      await this.prisma.mediaRemediationStep.update({
        where: { id: step.id },
        data: { status: 'succeeded', completedAt: new Date() },
      });
      await this.event(plan.id, 'step_completed', { ordinal: step.ordinal });
      return { kind: 'ok' };
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.mediaRemediationStep.update({
        where: { id: step.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          // Conservative: an unrecognised throw is TRANSIENT, so it may be
          // retried, but the plan still stops here rather than continuing
          // past a step whose effect is unknown.
          failureClass: 'transient' satisfies RemediationFailureClass,
          failureMessage: message.slice(0, 500),
        },
      });
      await this.event(plan.id, 'step_failed', { ordinal: step.ordinal });
      return { kind: 'failed', failureClass: 'transient', message };
    }
  }

  /**
   * Dispatch to the domain that owns the mutation.
   *
   * A closed mapping from a step's `kind`, never from anything a client sent:
   * the server decides what runs. An unrecognised kind is a capability
   * failure rather than a default, because silently doing nothing and
   * reporting success is the failure mode this whole phase exists to avoid.
   */
  private async invoke(step: StepRow, actorUserId?: string): Promise<StepOutcome> {
    switch (step.kind) {
      case 'refresh_metadata':
        return this.refreshMetadata(step, actorUserId);
      default:
        return {
          kind: 'failed',
          failureClass: 'capability_unavailable',
          message: `No executor is registered for step kind "${step.kind}".`,
        };
    }
  }

  /**
   * Media Manager owns metadata.
   *
   * Calls `MediaMetadataService.fetchMetadata` directly rather than the bulk
   * wrapper, deliberately. The bulk path dispatches a detached job and
   * filters locked items SILENTLY — a locked item there lowers `accepted` to
   * zero and appears in neither `missing` nor any error, so a caller cannot
   * tell "skipped because locked" from "did nothing". For a single-item plan
   * that trade buys nothing and costs the one distinction that matters, so
   * the lock is checked explicitly above and the source service is called
   * for the one item.
   */
  private async refreshMetadata(step: StepRow, actorUserId?: string): Promise<StepOutcome> {
    const itemId = (step.inputSnapshot as { itemId?: string } | null)?.itemId;
    if (!itemId) {
      return { kind: 'failed', failureClass: 'permanent', message: 'step carries no itemId' };
    }

    const { MediaMetadataService } = await import('../../media/media-metadata.service');
    const metadata = this.moduleRef.get(MediaMetadataService, { strict: false });

    await metadata.fetchMetadata(itemId, { userId: actorUserId });

    /*
     * One audit row for one source action, attributed to whoever approved
     * it. `userId` is theirs rather than absent: a plan does not act on its
     * own, and the approval is what authorised this.
     */
    await this.audit.record({
      userId: actorUserId,
      action: 'media_intelligence.remediation.step_executed',
      objectType: 'media_remediation_step',
      objectId: step.id,
      metadata: { kind: step.kind, ownerDomain: step.ownerDomain, itemId },
    });
    return { kind: 'ok' };
  }

  /* ---------------------------------------------------------- the gates */

  /**
   * Everything that must still hold, immediately before any mutation.
   *
   * Returns the first blocker, or null. Deliberately re-derived from source
   * rows rather than trusting the plan's stored verdict — the plan's
   * `blockReason` describes the world as it was when the plan was built.
   */
  private async recheck(plan: PlanRow): Promise<RemediationBlockReason | null> {
    if (isPlanExpired(plan.expiresAt, new Date())) return 'approval_invalidated';

    if (plan.entityType === 'movie' || plan.entityType === 'episode') {
      const item = await this.prisma.mediaItem
        .findUnique({ where: { id: plan.entityId }, select: { locked: true } })
        .catch(() => null);
      if (!item) return 'entity_missing';
      // A lock placed while the plan waited still saves the item. This is the
      // case the planning-time check cannot cover.
      if (item.locked !== false) return 'item_locked';
    } else {
      // No supported remediation targets these, so reaching here at all means
      // something built a plan it should not have.
      return 'capability_unavailable';
    }

    if (!plan.recommendationId) return 'capability_unavailable';
    const rec = await this.prisma.mediaIntelligenceRecommendation.findUnique({
      where: { id: plan.recommendationId },
      select: { id: true, type: true, status: true, confidence: true, capabilityId: true, evidence: true },
    });
    if (!rec || rec.status !== 'active') return 'approval_invalidated';

    const current = recommendationFingerprint({
      recommendationId: rec.id,
      type: rec.type,
      status: rec.status,
      confidence: rec.confidence,
      capabilityId: rec.capabilityId,
      evidence: (rec.evidence ?? {}) as Record<string, unknown>,
    });
    // The justification moved between approval and now. Executing would carry
    // out work nobody approved.
    if (plan.recommendationFingerprint && plan.recommendationFingerprint !== current) {
      return 'approval_invalidated';
    }

    return null;
  }

  /**
   * Is every step's expected postcondition true in the OWNING domain?
   *
   * `null` means "could not establish", which is neither satisfied nor
   * failed — Phase 5's third answer, carried into execution.
   */
  private async postconditionsMet(plan: PlanRow): Promise<boolean | null> {
    for (const step of plan.steps) {
      const want = step.expectedPostcondition as { metadataProviderPresent?: boolean } | null;
      if (!want || want.metadataProviderPresent !== true) continue;

      const itemId = (step.inputSnapshot as { itemId?: string } | null)?.itemId;
      if (!itemId) return null;

      const row = await this.prisma.mediaMetadata
        .findUnique({ where: { itemId }, select: { providerName: true } })
        .catch(() => undefined);
      // A thrown lookup is unknown, not unmet.
      if (row === undefined) return null;
      if (!row?.providerName) return false;
    }
    return true;
  }

  /* ------------------------------------------------------- transitions */

  private async block(planId: string, blockReason: RemediationBlockReason): Promise<void> {
    await this.prisma.mediaRemediationPlan.updateMany({
      where: { id: planId, status: { in: ['executing', 'verifying'] } },
      data: { status: 'blocked', blockReason },
    });
    await this.event(planId, 'blocked', { blockReason });
  }

  private async fail(
    planId: string,
    failureClass: RemediationFailureClass,
    message: string,
  ): Promise<void> {
    await this.prisma.mediaRemediationPlan.updateMany({
      where: { id: planId, status: { in: ['executing', 'verifying'] } },
      data: {
        status: 'failed',
        failureClass,
        failureMessage: message.slice(0, 500),
        completedAt: new Date(),
      },
    });
    await this.event(planId, 'failed', { failureClass });
  }

  /** Status is only ever written through a compare-and-swap on the old value. */
  private async transition(
    planId: string,
    from: string,
    to: string,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const res = await this.prisma.mediaRemediationPlan.updateMany({
      where: { id: planId, status: from },
      data: { status: to, ...data },
    });
    return res.count === 1;
  }

  private async event(
    planId: string,
    event: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.mediaRemediationPlanEvent
      .create({ data: { planId, event, detail: detail as object } })
      .catch((err) => this.logger.debug(`Plan event ${event} not recorded: ${(err as Error).message}`));
  }
}

/* ------------------------------------------------------------------ types */

export type ExecutionOutcome =
  | { status: 'not_claimed' }
  | { status: 'blocked'; blockReason: RemediationBlockReason }
  | { status: 'failed'; failureClass: RemediationFailureClass }
  | { status: 'verifying' }
  | { status: 'succeeded' };

type StepOutcome =
  | { kind: 'ok' }
  | { kind: 'blocked'; blockReason: RemediationBlockReason }
  | { kind: 'failed'; failureClass: RemediationFailureClass; message: string };

interface StepRow {
  id: string;
  ordinal: number;
  kind: string;
  ownerDomain: string;
  status: string;
  inputSnapshot: unknown;
  expectedPostcondition: unknown;
}

interface PlanRow {
  id: string;
  entityType: string;
  entityId: string;
  status: string;
  recommendationId: string | null;
  recommendationFingerprint: string | null;
  expiresAt: Date | null;
  steps: StepRow[];
}
