import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  TERMINAL_PLAN_STATUSES,
  canTransitionPlan,
  type MediaIntelligenceEntityType,
  type RemediationPlanStatus,
  type ResolvedDesiredState,
} from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { buildPlan, type PlanDraft } from './plan-builder';
import { checkPlanApproval, type ApprovalCheck } from './plan-approval';
import {
  desiredStateFingerprint,
  fingerprintDrift,
  recommendationFingerprint,
} from './remediation-fingerprint';

/**
 * Persisting and reconciling remediation plans.
 *
 * Plans are the one thing in Media Intelligence besides lifecycle policies
 * that is NOT derived. A projection can be dropped and rebuilt; a plan
 * records what UltraTorrent actually intended and did, so this service never
 * deletes one. Everything obsolete is SUPERSEDED, with a reason, because
 * "why did this happen" has to stay answerable after the condition that
 * justified it is gone.
 *
 * ## What the sweep may and may not touch
 *
 * Reconciliation runs inside `refreshEntity`, on the same pass that settles
 * findings and recommendations. It may create a plan, and it may supersede
 * one that has lost its justification — but only while the plan is still
 * *decidable*. A plan that is `executing` or `waiting` has already issued
 * work to another domain, and rewriting it from a sweep would yank the ground
 * out from under a step that is in flight. Those are left alone; the executor
 * owns them until they reach a terminal state.
 *
 * ## Identity
 *
 * One active plan per recommendation, enforced in SQL by a partial unique
 * index over non-terminal statuses. That is the durable logical key: a plan
 * answers a recommendation, and a second live plan for the same
 * recommendation would mean the same drift queued twice.
 *
 * ## What this service does NOT do
 *
 * It never executes anything, never calls a source domain, and never writes
 * to a finding, a recommendation or a projection. A failure here must not be
 * able to corrupt finding truth or an operator's disposition, which is why
 * the projection sweep calls it AFTER those have settled and outside their
 * transaction.
 */
@Injectable()
export class RemediationPlanService {
  private readonly logger = new Logger(RemediationPlanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Bring plans for one entity in line with its current recommendations.
   *
   * Called from the projection sweep with the recommendations it has just
   * settled, so the ids are real. `desired` is passed in rather than resolved
   * here for the same reason the recommendation pass takes it: a library-wide
   * sweep reads the policies ONCE for the whole run.
   */
  async reconcile(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
    now: Date,
    desired?: ResolvedDesiredState | null,
  ): Promise<void> {
    const [recommendations, plans, facts] = await Promise.all([
      this.prisma.mediaIntelligenceRecommendation.findMany({
        where: { entityType, entityId },
        select: {
          id: true, findingId: true, type: true, status: true, evidence: true,
          // Both are hashed: a recommendation that drops from `high` to `low`,
          // or loses the capability it routed to, is materially different work
          // and must invalidate an approval rather than pass as unchanged.
          confidence: true, capabilityId: true,
        },
      }),
      this.prisma.mediaRemediationPlan.findMany({
        where: { entityType, entityId, status: { notIn: [...TERMINAL_PLAN_STATUSES] } },
        select: {
          id: true, recommendationId: true, status: true, blockReason: true,
          desiredStateFingerprint: true, recommendationFingerprint: true,
          verificationFingerprint: true, approvedFingerprint: true,
        },
      }),
      this.entityFacts(entityType, entityId),
    ]);

    const byRecommendation = new Map(plans.map((p) => [p.recommendationId ?? '', p]));
    const history: HistoryRow[] = [];
    const stillJustified = new Set<string>();

    const desiredFp = desired ? desiredStateFingerprint(toDesiredInput(entityType, entityId, desired)) : null;

    for (const rec of recommendations) {
      const draft = buildPlan(
        {
          entityType,
          entityId,
          recommendationId: rec.id,
          findingId: rec.findingId,
          type: rec.type,
          status: rec.status,
          evidence: (rec.evidence ?? {}) as Record<string, unknown>,
          desired,
          facts,
        },
        now,
      );
      if (!draft) continue;
      stillJustified.add(rec.id);

      const recFp = recommendationFingerprint({
        recommendationId: rec.id,
        type: rec.type,
        status: rec.status,
        confidence: rec.confidence,
        capabilityId: rec.capabilityId,
        evidence: (rec.evidence ?? {}) as Record<string, unknown>,
      });

      const existing = byRecommendation.get(rec.id);
      if (!existing) {
        await this.create(draft, desiredFp, recFp, history);
        continue;
      }

      /*
       * An in-flight plan is the executor's, not the sweep's. It has already
       * issued work to another domain; rewriting it here would change what a
       * running step believes it is doing.
       */
      if (IN_FLIGHT.has(existing.status as RemediationPlanStatus)) continue;

      const drift = fingerprintDrift(
        {
          desiredState: existing.desiredStateFingerprint,
          recommendation: existing.recommendationFingerprint,
          verification: existing.verificationFingerprint,
        },
        { desiredState: desiredFp, recommendation: recFp, verification: null },
      );

      if (drift.length) {
        /*
         * The justification moved. An approved plan must NOT quietly execute
         * different work, so the pinned inputs are refreshed and — if it had
         * been approved — the approval is invalidated rather than carried
         * over onto something the approver never saw.
         */
        await this.prisma.mediaRemediationPlan.update({
          where: { id: existing.id },
          data: {
            desiredStateFingerprint: desiredFp,
            recommendationFingerprint: recFp,
            blockReason: draft.blockReason,
            riskClass: draft.riskClass,
            explanation: draft.explanation as object,
            ...(existing.approvedFingerprint
              ? { approvedById: null, approvedAt: null, approvedFingerprint: null }
              : {}),
          },
        });
        history.push({
          planId: existing.id,
          event: existing.approvedFingerprint ? 'approval_invalidated' : 'inputs_changed',
          detail: { drifted: drift },
        });
        continue;
      }

      // Unchanged justification, but the safety verdict may have moved — an
      // item locked since the plan was built, say.
      if ((existing.blockReason ?? null) !== draft.blockReason) {
        await this.prisma.mediaRemediationPlan.update({
          where: { id: existing.id },
          data: { blockReason: draft.blockReason },
        });
        history.push({
          planId: existing.id,
          event: draft.blockReason ? 'blocked' : 'unblocked',
          detail: { blockReason: draft.blockReason },
        });
      }
    }

    /*
     * Anything no longer justified is superseded, never deleted. Two reasons,
     * and the operator is told which: the recommendation resolved, or it
     * stopped producing a plan at all (a capability went away, the evidence
     * no longer supports one).
     */
    const resolved = new Set(
      recommendations.filter((r) => r.status !== 'active').map((r) => r.id),
    );
    for (const plan of plans) {
      const recId = plan.recommendationId ?? '';
      if (stillJustified.has(recId)) continue;
      if (IN_FLIGHT.has(plan.status as RemediationPlanStatus)) continue;
      if (!canTransitionPlan(plan.status as RemediationPlanStatus, 'superseded')) continue;

      const reason = resolved.has(recId) ? 'drift_resolved' : 'recommendation_withdrawn';
      await this.prisma.mediaRemediationPlan.update({
        where: { id: plan.id },
        data: { status: 'superseded', supersededAt: now, supersededReason: reason },
      });
      history.push({ planId: plan.id, event: 'superseded', detail: { reason } });
    }

    await this.writeHistory(history);
  }

  /* ------------------------------------------------------ human decisions */

  /**
   * Approve a plan, clearing it to execute.
   *
   * Every precondition is gathered by the pure `checkPlanApproval` rather
   * than checked inline, so a caller cannot satisfy three of the four. The
   * refusal is AUDITED as well as thrown: "who tried to approve what, and why
   * were they refused" is exactly the question an audit trail exists for, and
   * a 403 that leaves no trace answers it badly.
   *
   * Approval grants permission; it does not act. The executor re-establishes
   * every safety property again immediately before the source call, because
   * everything checked here describes a world that may have moved on.
   */
  async approve(planId: string, user: ApprovingUser, ctx: AuditCtx = {}) {
    const plan = await this.load(planId);
    const steps = await this.prisma.mediaRemediationStep.count({
      where: { planId, status: { in: ['pending', 'failed'] } },
    });

    const verdict = checkPlanApproval({
      status: plan.status as RemediationPlanStatus,
      riskClass: plan.riskClass as never,
      blockReason: plan.blockReason as never,
      expiresAt: plan.expiresAt,
      now: new Date(),
      holderPermissions: user.permissions ?? [],
      superAdmin: (user.roles ?? []).includes('SUPER_ADMIN'),
      actionableSteps: steps,
      /*
       * Drift is NOT re-derived here, and that is a deliberate limit worth
       * stating rather than implying. The sweep clears an approval when a
       * pinned input moves, so this reflects the last sweep — up to six
       * hours old. A plan whose justification changed minutes ago can
       * therefore still be approved.
       *
       * It cannot be EXECUTED, which is where the guarantee actually lives:
       * the executor recomputes the recommendation fingerprint immediately
       * before the source call and blocks on any difference. Recomputing it
       * here as well would cost a query per approval to move a check that
       * has to happen at execution time regardless.
       */
      inputsDrifted: false,
    });

    if (!verdict.allowed) {
      await this.audit.record({
        userId: user.id,
        ...ctx,
        action: 'media_intelligence.remediation.approve_refused',
        objectType: 'media_remediation_plan',
        objectId: planId,
        result: 'failure',
        metadata: {
          reason: verdict.reason,
          blockReason: verdict.blockReason ?? null,
          missingPermission: verdict.missingPermission ?? null,
        },
      });
      throw this.refusal(verdict);
    }

    const moved = await this.transition(plan, 'approved', {
      approvedById: user.id,
      approvedAt: new Date(),
      // Pins WHAT was approved. The executor compares against this, so a
      // later change cannot execute under an older signature.
      approvedFingerprint: plan.recommendationFingerprint,
    });
    if (!moved) throw new BadRequestException(`Plan is ${plan.status} and cannot be approved`);

    /*
     * Self-approval is permitted and separately audited, following Library
     * Cleanup: most installations have one operator, and a workflow nobody
     * can complete is worse than one recorded honestly.
     */
    await this.audit.record({
      userId: user.id,
      ...ctx,
      action:
        plan.createdById === user.id
          ? 'media_intelligence.remediation.self_approved'
          : 'media_intelligence.remediation.approved',
      objectType: 'media_remediation_plan',
      objectId: planId,
      metadata: { type: plan.type, riskClass: plan.riskClass, actionableSteps: steps },
    });
    await this.writeHistory([{ planId, event: 'approved', detail: { actorUserId: user.id } }]);
    return this.load(planId);
  }

  /**
   * Stop a plan before further steps begin.
   *
   * Cancellation means "start nothing more" — it never undoes a step that
   * already ran. A source action issued to another domain is that domain's
   * now, and pretending otherwise would promise a rollback this phase
   * deliberately does not implement.
   */
  async cancel(planId: string, reason: string | undefined, user: ApprovingUser, ctx: AuditCtx = {}) {
    const plan = await this.load(planId);
    const moved = await this.transition(plan, 'cancelled', { supersededReason: reason ?? null });
    if (!moved) throw new BadRequestException(`Plan is ${plan.status} and cannot be cancelled`);

    await this.audit.record({
      userId: user.id,
      ...ctx,
      action: 'media_intelligence.remediation.cancelled',
      objectType: 'media_remediation_plan',
      objectId: planId,
      metadata: { reason: reason ?? null, previousStatus: plan.status },
    });
    await this.writeHistory([
      { planId, event: 'cancelled', detail: { reason: reason ?? null, from: plan.status } },
    ]);
    return this.load(planId);
  }

  /** Load a plan or 404. */
  private async load(planId: string) {
    const plan = await this.prisma.mediaRemediationPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException(`Unknown remediation plan: ${planId}`);
    return plan;
  }

  /** Turn a machine verdict into the right HTTP failure, with its reason. */
  private refusal(verdict: ApprovalCheck): Error {
    switch (verdict.reason) {
      case 'missing_permission':
        return new ForbiddenException(
          `Approving a ${verdict.missingPermission ? 'plan of this risk' : 'plan'} requires ${verdict.missingPermission}`,
        );
      case 'expired':
        return new BadRequestException(
          'This plan expired; its pinned inputs are too old to act on. It will be rebuilt on the next sweep.',
        );
      case 'unknowable':
        /*
         * The distinction Phase 6 exists to hold. This is not "you may not" —
         * it is "the system does not know enough", and no signature supplies
         * knowledge.
         */
        return new UnprocessableEntityException(
          `Cannot approve: ${verdict.blockReason}. Approval cannot establish this — the underlying fact has to become known.`,
        );
      case 'blocked':
        return new UnprocessableEntityException(`Cannot approve while blocked: ${verdict.blockReason}`);
      case 'approval_invalidated':
        return new BadRequestException('This plan changed since it was built; review it again.');
      case 'nothing_to_do':
        return new UnprocessableEntityException('This plan has no steps left to run.');
      default:
        return new BadRequestException('This plan cannot be approved in its current state.');
    }
  }

  /** One place that writes a plan status, so the state machine cannot be bypassed. */
  private async transition(
    plan: { id: string; status: string },
    to: RemediationPlanStatus,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    if (!canTransitionPlan(plan.status as RemediationPlanStatus, to)) return false;
    // Compare-and-swap on the status we read, so a concurrent decision loses
    // rather than both being applied.
    const res = await this.prisma.mediaRemediationPlan.updateMany({
      where: { id: plan.id, status: plan.status },
      data: { status: to, ...data },
    });
    return res.count === 1;
  }

  /** Create a plan and its steps in one transaction, plus its opening event. */
  private async create(
    draft: PlanDraft,
    desiredFp: string | null,
    recFp: string,
    history: HistoryRow[],
  ): Promise<void> {
    const created = await this.prisma.mediaRemediationPlan.create({
      data: {
        entityType: draft.entityType,
        entityId: draft.entityId,
        findingId: draft.findingId,
        recommendationId: draft.recommendationId,
        policyId: draft.policyId,
        type: draft.type,
        // Every plan starts `proposed`. Nothing is asked of anyone until a
        // person opens the queue; the executor never picks up this status.
        status: 'proposed',
        riskClass: draft.riskClass,
        blockReason: draft.blockReason,
        explanation: draft.explanation as object,
        desiredStateFingerprint: desiredFp,
        recommendationFingerprint: recFp,
        expiresAt: draft.expiresAt,
        steps: {
          create: draft.steps.map((s) => ({
            ordinal: s.ordinal,
            kind: s.kind,
            ownerDomain: s.ownerDomain,
            capabilityId: s.capabilityId,
            requiredPermission: s.requiredPermission,
            inputSnapshot: s.inputSnapshot as object,
            expectedPostcondition: s.expectedPostcondition as object,
            idempotencyKey: s.idempotencyKey,
          })),
        },
      },
      select: { id: true },
    });
    history.push({
      planId: created.id,
      event: 'created',
      detail: { type: draft.type, blocked: draft.blockReason !== null },
    });
  }

  /**
   * History is written as ONE batch, and only for transitions.
   *
   * A sweep touches every entity in the library and almost none of them
   * changed. A row per observation would bury the handful of entries that
   * explain what actually happened, and would grow without bound — the same
   * reasoning finding history already follows.
   */
  private async writeHistory(rows: HistoryRow[]): Promise<void> {
    if (!rows.length) return;
    await this.prisma.mediaRemediationPlanEvent.createMany({
      data: rows.map((r) => ({ planId: r.planId, event: r.event, detail: r.detail as object })),
    });
  }

  /**
   * The facts the pure builder cannot derive.
   *
   * Read from the projection's own source rows rather than re-assembling:
   * this runs per entity inside a sweep, so it must stay one cheap indexed
   * lookup. A missing row means the entity is gone, which the builder treats
   * as a blocker rather than as permission.
   */
  private async entityFacts(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
  ): Promise<{ entityExists: boolean | null; locked: boolean | null }> {
    if (entityType === 'movie' || entityType === 'episode') {
      const item = await this.prisma.mediaItem
        .findUnique({ where: { id: entityId }, select: { locked: true } })
        .catch(() => null);
      return { entityExists: item !== null, locked: item?.locked ?? null };
    }
    /*
     * A series or season carries no lock of its own. Both are left UNKNOWN
     * rather than false — and the classification refuses those entity types
     * for the one supported remediation anyway, so no plan reaches here.
     */
    return { entityExists: null, locked: null };
  }
}

/** Statuses the executor owns. A sweep must not rewrite these. */
const IN_FLIGHT: ReadonlySet<RemediationPlanStatus> = new Set<RemediationPlanStatus>([
  'executing',
  'waiting',
  'verifying',
]);

interface HistoryRow {
  planId: string;
  event: string;
  detail: Record<string, unknown>;
}

/**
 * The approving principal, narrowed to what the decision actually reads.
 *
 * Deliberately not `AuthenticatedUser`: this service needs an id, the held
 * permissions and whether the caller is a super-admin, and taking the whole
 * request principal would invite reading things a decision has no business
 * depending on.
 */
export interface ApprovingUser {
  id: string;
  permissions?: readonly string[];
  roles?: readonly string[];
}

/** ip/userAgent, spread straight from `reqAuditContext`. */
type AuditCtx = { ipAddress?: string; userAgent?: string };

/** Project a resolved desired state onto the fingerprint's narrow input. */
function toDesiredInput(
  entityType: string,
  entityId: string,
  desired: ResolvedDesiredState,
): Parameters<typeof desiredStateFingerprint>[0] {
  return {
    entityType,
    entityId,
    quality: desired.quality?.value ?? null,
    completeness: desired.completeness?.value ?? null,
    subtitleLanguages: desired.subtitleLanguages?.value ?? null,
    mode: desired.mode ?? null,
    sourcePolicyIds: (desired.applicablePolicies ?? []).map((p) => p.policyId),
    conflictedDimensions: (desired.conflicts ?? []).map((c) => c.dimension),
  };
}
