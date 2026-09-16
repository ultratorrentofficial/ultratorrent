import { Injectable, Logger } from '@nestjs/common';
import {
  VERIFICATION_FRESHNESS_HOURS,
  type MediaRecommendationInvalidationReason,
  type ResolvedDesiredState,
} from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { confidenceRank } from './confidence-rank';
import { evaluateRecommendation } from './recommendation-evaluator';
import type { RecommendationInput } from './recommendation-evaluator';

/**
 * Persisting and reconciling recommendations.
 *
 * Recommendations are DERIVED — the sweep re-evaluates them from findings on
 * every pass, and the whole table can be dropped and rebuilt. Two things are
 * deliberately NOT re-derived, and they are the reason this is a table at all:
 *
 *   - a verification a person explicitly asked for, and the bounded candidate
 *     snapshot it produced;
 *   - the row's own `createdAt`, so "you have been ignoring this for a month"
 *     stays true across rebuilds.
 *
 * **Identity is `(findingId, type)`.** A finding row is already stable —
 * reconciliation updates it by primary key and has never delete-and-recreated
 * — so that pair is a durable logical key. Every write below is an upsert
 * against it, which is what makes a rebuild idempotent rather than a source of
 * duplicates.
 *
 * **Nothing here touches Phase 3 disposition.** Acknowledge, snooze, dismiss,
 * the escalation reason and the transition history all live on the finding and
 * are never written from this file. Generating a recommendation is not an
 * event in a person's workflow.
 */
@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Bring recommendations for one entity in line with its current findings.
   *
   * Called from the projection sweep with the findings it has just persisted,
   * so the ids are real and the whole entity settles in one pass.
   */
  async reconcile(
    entityType: string,
    entityId: string,
    findings: ReadonlyArray<{
      id: string;
      code: string;
      severity: string;
      evidence: Record<string, unknown>;
      resolved: boolean;
    }>,
    now: Date,
    /**
     * The operator's resolved intent, when a lifecycle policy governs this
     * entity (Phase 5). Passed in rather than resolved here so a library-wide
     * sweep reads the policies ONCE for the whole run instead of once per
     * entity — the difference between one query and thirty thousand.
     */
    desired?: ResolvedDesiredState | null,
  ): Promise<void> {
    const existing = await this.prisma.mediaIntelligenceRecommendation.findMany({
      where: { entityType, entityId },
      select: {
        id: true, findingId: true, type: true, status: true, confidence: true,
        evidence: true, verification: true, verifiedAt: true,
      },
    });
    const byKey = new Map(existing.map((r) => [`${r.findingId}|${r.type}`, r]));
    const produced = new Set<string>();

    for (const finding of findings) {
      /*
       * A resolved finding keeps its recommendation row but stops proposing:
       * the condition is gone, so the response is SATISFIED rather than
       * deleted. Deleting would lose "this was recommended and then the
       * problem went away", which is exactly the history an operator uses to
       * decide whether the system is helping.
       */
      if (finding.resolved) continue;

      const draft = evaluateRecommendation({
        findingId: finding.id,
        code: finding.code,
        severity: finding.severity,
        entityType,
        entityId,
        evidence: finding.evidence,
        // Null when no policy governs this entity, which leaves every rule
        // behaving exactly as it did before Phase 5.
        policy: desired
          ? {
              quality: desired.quality.value,
              qualitySource: desired.quality.source
                ? {
                    policyId: desired.quality.source.policyId,
                    policyName: desired.quality.source.policyName,
                  }
                : null,
            }
          : null,
      } satisfies RecommendationInput);
      if (!draft) continue;

      const key = `${finding.id}|${draft.type}`;
      produced.add(key);
      const prior = byKey.get(key);

      /*
       * Evidence moving is what invalidates a verification, not a rebuild.
       * If the owned copy changed, a candidate compared against the OLD copy
       * proves nothing — so the verification resets and the operator is told
       * why, rather than being shown a stale "available" badge.
       */
      const evidenceChanged =
        prior != null && JSON.stringify(prior.evidence) !== JSON.stringify(draft.evidence);
      const resetVerification = evidenceChanged && prior?.verification === 'verified';

      await this.prisma.mediaIntelligenceRecommendation.upsert({
        where: { findingId_type: { findingId: finding.id, type: draft.type } },
        create: {
          findingId: finding.id,
          entityType,
          entityId,
          type: draft.type,
          recommendationClass: draft.recommendationClass,
          status: 'active',
          confidence: draft.confidence,
          confidenceRank: confidenceRank(draft.confidence),
          evidence: draft.evidence as object,
          unknowns: draft.unknowns as object,
          plan: draft.plan as object,
          capabilityId: draft.capabilityId,
          verification: draft.verification,
          evaluatedAt: now,
        },
        update: {
          // Re-derived every sweep: the finding's evidence may have moved.
          recommendationClass: draft.recommendationClass,
          confidence: draft.confidence,
          confidenceRank: confidenceRank(draft.confidence),
          evidence: draft.evidence as object,
          unknowns: draft.unknowns as object,
          plan: draft.plan as object,
          capabilityId: draft.capabilityId,
          status: 'active',
          invalidationReason: null,
          invalidatedAt: null,
          evaluatedAt: now,
          ...(resetVerification
            ? {
                verification: 'not_checked' as const,
                verifiedAt: null,
                candidate: undefined,
                }
            : {}),
        },
      });
    }

    /*
     * Anything this entity no longer produces stops applying. Two different
     * reasons, and the operator is told which: the condition itself resolved,
     * or the recommendation stopped being derivable while the finding stayed
     * open (a capability went away, the evidence no longer supports it).
     */
    const resolvedFindingIds = new Set(findings.filter((f) => f.resolved).map((f) => f.id));
    const stale = existing.filter(
      (r) => !produced.has(`${r.findingId}|${r.type}`) && r.status === 'active',
    );
    if (stale.length) {
      const satisfied = stale.filter((r) => resolvedFindingIds.has(r.findingId));
      const invalidated = stale.filter((r) => !resolvedFindingIds.has(r.findingId));

      if (satisfied.length) {
        await this.prisma.mediaIntelligenceRecommendation.updateMany({
          where: { id: { in: satisfied.map((r) => r.id) } },
          data: {
            status: 'satisfied',
            invalidationReason: 'finding_resolved' satisfies MediaRecommendationInvalidationReason,
            invalidatedAt: now,
          },
        });
      }
      if (invalidated.length) {
        await this.prisma.mediaIntelligenceRecommendation.updateMany({
          where: { id: { in: invalidated.map((r) => r.id) } },
          data: {
            status: 'invalidated',
            invalidationReason: 'evidence_changed' satisfies MediaRecommendationInvalidationReason,
            invalidatedAt: now,
          },
        });
      }
    }
  }

  /**
   * Age verified candidates out.
   *
   * An indexer result is ephemeral: the release may be gone and the seeders
   * certainly are. Past the freshness window a verification stops counting as
   * current — WITHOUT calling a provider, because expiring a claim must never
   * cost network traffic. The recommendation itself stays active; only the
   * specific candidate loses its verified standing.
   *
   * Runs as one bounded UPDATE over an index, not a row-by-row sweep.
   */
  async expireStaleVerifications(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - VERIFICATION_FRESHNESS_HOURS * 3_600_000);
    const res = await this.prisma.mediaIntelligenceRecommendation.updateMany({
      where: { verification: 'verified', verifiedAt: { lt: cutoff } },
      data: { verification: 'stale' },
    });
    if (res.count) {
      this.logger.log(`Aged ${res.count} verified upgrade candidate(s) to stale.`);
    }
    return res.count;
  }
}
