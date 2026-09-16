import { Injectable } from '@nestjs/common';
import {
  LIFECYCLE_PREVIEW_LIMIT,
  LIFECYCLE_PREVIEW_SAMPLES,
  type LifecyclePolicyPreview,
  type LifecycleScopeType,
  type MediaIntelligenceEntityType,
  type MediaLifecyclePolicy,
} from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { LifecyclePolicyService } from './lifecycle-policy.service';
import { LifecycleEvaluationService } from './lifecycle-evaluation.service';

/**
 * "What would this policy do?" — answered before saving it.
 *
 * **It uses the production evaluator, not an approximation.** The same
 * `resolveDesiredState` and `evaluateDrift` that reconciliation runs. A
 * preview computed by a second code path is a guess about the real one, and
 * the moment the two disagree the preview is worse than nothing — the
 * operator validated something that will not happen.
 *
 * **It mutates nothing.** No policy row, no projection, no recommendation, no
 * media. A draft is evaluated by inserting it into the in-memory policy list
 * the resolver receives; it is never written first and rolled back.
 *
 * **It is bounded, and says so.** A global scope covers every title in the
 * library — 3,354 movies on the reference installation — so the preview
 * evaluates at most {@link LIFECYCLE_PREVIEW_LIMIT} entities and reports
 * `truncated`. Claiming a whole-library verdict from a sample would be the
 * kind of confident wrongness this module exists to avoid.
 */
@Injectable()
export class PolicyPreviewService {
  /**
   * The id an unsaved draft carries during evaluation.
   *
   * Deterministic, so precedence ties resolve the same way every run, and
   * visibly synthetic so it can never be mistaken for a persisted policy in
   * provenance output.
   */
  static readonly DRAFT_ID = '__draft__';

  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: LifecyclePolicyService,
    private readonly evaluation: LifecycleEvaluationService,
  ) {}

  /**
   * Evaluate a draft (or an existing policy) against current media.
   *
   * The draft participates in precedence exactly as a saved policy would —
   * including losing to a narrower one — because the question an operator is
   * asking is "what happens if I save this", not "what does this say in
   * isolation".
   */
  async preview(draft: PreviewInput, now = new Date()): Promise<LifecyclePolicyPreview> {
    const scopeType = draft.scopeType ?? 'global';
    const scopeId = scopeType === 'global' ? null : (draft.scopeId ?? null);

    const saved = await this.policies.enabled();
    const candidate: MediaLifecyclePolicy = {
      id: draft.id ?? PolicyPreviewService.DRAFT_ID,
      name: draft.name ?? 'Draft policy',
      description: null,
      // A preview always evaluates the draft as if it were ON, even when the
      // operator is editing a disabled policy: "what would this do" is the
      // question, and a disabled policy would answer "nothing".
      enabled: true,
      scopeType,
      scopeId,
      mode: draft.mode ?? 'recommend_only',
      quality: draft.quality ?? null,
      completeness: draft.completeness ?? null,
      subtitleLanguages: draft.subtitleLanguages ?? null,
      acquisition: draft.acquisition ?? null,
      createdBy: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    // Editing an existing policy previews the EDIT, not both versions of it.
    const policies = [...saved.filter((p) => p.id !== candidate.id), candidate];

    const { entities, truncated } = await this.entitiesInScope(scopeType, scopeId);

    const out: LifecyclePolicyPreview = {
      policyId: draft.id ?? null,
      scopeType,
      scopeId,
      evaluated: 0,
      truncated,
      compliant: 0,
      drift: 0,
      unknown: 0,
      notApplicable: 0,
      byDimension: {},
      samples: [],
    };

    for (const entity of entities) {
      const result = await this.evaluation.evaluateWith(
        policies,
        entity.entityType as MediaIntelligenceEntityType,
        entity.entityId,
        now,
      );
      // An entity deleted mid-preview is skipped rather than failing the run.
      if (!result) continue;
      out.evaluated += 1;

      const drifting: string[] = [];
      for (const d of result.drifts) {
        const bucket = (out.byDimension[d.dimension] ??= {
          compliant: 0,
          drift: 0,
          unknown: 0,
          notApplicable: 0,
        });
        if (d.status === 'compliant') bucket.compliant += 1;
        else if (d.status === 'drift') bucket.drift += 1;
        else if (d.status === 'unknown') bucket.unknown += 1;
        else bucket.notApplicable += 1;
        if (d.status === 'drift') drifting.push(d.dimension);
      }

      /*
       * One entity counts once, by its WORST outcome. Drift beats unknown
       * beats compliant: a title with one drifting dimension is a title that
       * needs attention, and averaging the dimensions would hide it.
       */
      if (drifting.length) out.drift += 1;
      else if (result.drifts.some((d) => d.status === 'unknown')) out.unknown += 1;
      else if (result.drifts.some((d) => d.status === 'compliant')) out.compliant += 1;
      else out.notApplicable += 1;

      if (drifting.length && out.samples.length < LIFECYCLE_PREVIEW_SAMPLES) {
        out.samples.push({
          entityType: entity.entityType,
          entityId: entity.entityId,
          title: entity.title,
          dimensions: drifting,
        });
      }
    }

    return out;
  }

  /**
   * The entities a scope reaches, from the materialized projection.
   *
   * Reads the projection rather than the source tables because it already
   * denormalizes `libraryId` and `title` and is indexed on both — the whole
   * reason it exists. A preview must not fan out across the media domains.
   *
   * `media_kind` and `series`/`movie` scopes are resolved in the query where
   * the column allows it and filtered after where it does not; the cap is
   * applied to the QUERY, so a global preview never loads 3,000 rows to throw
   * most of them away.
   */
  private async entitiesInScope(
    scopeType: LifecycleScopeType,
    scopeId: string | null,
  ): Promise<{ entities: Array<{ entityType: string; entityId: string; title: string }>; truncated: boolean }> {
    const where: Record<string, unknown> = {};
    if (scopeType === 'library' && scopeId) where.libraryId = scopeId;
    if (scopeType === 'series' && scopeId) Object.assign(where, { entityType: 'series', entityId: scopeId });
    if (scopeType === 'movie' && scopeId) Object.assign(where, { entityType: 'movie', entityId: scopeId });
    /*
     * A media kind lives on the LIBRARY, not the projection, so it is
     * resolved to the set of libraries carrying that kind. One extra query,
     * and it keeps the cap meaningful — filtering after the take would
     * silently evaluate fewer entities than the cap promises.
     */
    if (scopeType === 'media_kind' && scopeId) {
      const libs = await this.prisma.mediaLibrary.findMany({
        where: { kind: scopeId },
        select: { id: true },
      });
      if (!libs.length) return { entities: [], truncated: false };
      where.libraryId = { in: libs.map((l) => l.id) };
    }

    const [rows, total] = await Promise.all([
      this.prisma.mediaIntelligenceProjection.findMany({
        where,
        select: { entityType: true, entityId: true, title: true },
        // Stable order, so two previews of the same scope evaluate the same
        // sample and an operator comparing them is comparing like with like.
        orderBy: [{ entityType: 'asc' }, { entityId: 'asc' }],
        take: LIFECYCLE_PREVIEW_LIMIT,
      }),
      this.prisma.mediaIntelligenceProjection.count({ where }),
    ]);

    return { entities: rows, truncated: total > rows.length };
  }
}

/** A draft policy, as the preview endpoint receives it. */
export interface PreviewInput {
  /** Set when previewing an edit to a saved policy; absent for a new one. */
  id?: string | null;
  name?: string;
  scopeType?: LifecycleScopeType;
  scopeId?: string | null;
  mode?: MediaLifecyclePolicy['mode'];
  quality?: MediaLifecyclePolicy['quality'];
  completeness?: MediaLifecyclePolicy['completeness'];
  subtitleLanguages?: string[] | null;
  acquisition?: MediaLifecyclePolicy['acquisition'];
}
