import { Injectable, Logger } from '@nestjs/common';
import {
  TERMINAL_PLAN_STATUSES,
  canTransitionPlan,
  type MediaIntelligenceEntityType,
  type RemediationPlanStatus,
  type ResolvedDesiredState,
} from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { buildPlan, type PlanDraft } from './plan-builder';
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

  constructor(private readonly prisma: PrismaService) {}

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
