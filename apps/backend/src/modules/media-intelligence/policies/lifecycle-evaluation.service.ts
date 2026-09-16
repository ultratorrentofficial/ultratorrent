import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  LifecycleEvaluation,
  MediaIntelligenceEntityType,
  ResolvedDesiredState,
} from '@ultratorrent/shared';

import { MediaStateAssembler } from '../media-state.assembler';
import { LifecyclePolicyService } from './lifecycle-policy.service';
import { resolveDesiredState } from './policy-precedence';
import type { LifecycleMatchContext } from './policy-precedence';
import { evaluateDrift } from './drift-evaluator';
import type { DriftFacts } from './drift-evaluator';

/**
 * Bringing operator intent and actual state together.
 *
 * The thin IO layer over two pure evaluators: this gathers, they reason. It
 * loads the policies, builds the scope context, asks the assembler for the
 * facts that already exist, and hands both to functions that can be tested
 * without a database.
 *
 * **It reads persisted and assembled state and nothing else.** No indexer, no
 * provider, no probe, no media server, no filesystem. Evaluating drift must
 * never cost network traffic — that is the difference between a page people
 * check and a page people learn not to open, and it is also what keeps a
 * library-wide sweep from becoming a provider stampede.
 *
 * **It writes nothing.** Desired state and drift are derived on read. There is
 * no projection table for them yet, deliberately: until the frontend exists
 * there is no query pattern to design one around, and a materialized view
 * whose invalidation rules are guesswork is worse than a live computation.
 */
@Injectable()
export class LifecycleEvaluationService {
  constructor(
    private readonly policies: LifecyclePolicyService,
    private readonly assembler: MediaStateAssembler,
  ) {}

  /**
   * What does the operator want for this entity, and why?
   *
   * Resolvable without touching the media at all — it needs only the policies
   * and the entity's scope keys — so it stays cheap even when the facts
   * behind a full evaluation would not be.
   */
  async desiredState(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
    now = new Date(),
  ): Promise<ResolvedDesiredState> {
    const { context } = await this.contextFor(entityType, entityId);
    const policies = await this.policies.enabled();
    return resolveDesiredState(policies, context, now);
  }

  /** Desired state, actual state, and the difference between them. */
  async evaluate(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
    now = new Date(),
  ): Promise<LifecycleEvaluation> {
    const { context, facts } = await this.contextFor(entityType, entityId);
    const policies = await this.policies.enabled();
    const desired = resolveDesiredState(policies, context, now);

    return {
      entityType,
      entityId,
      desiredState: desired,
      drifts: evaluateDrift(desired, facts),
      evaluatedAt: now.toISOString(),
    };
  }

  /**
   * Evaluate many entities against ALREADY-LOADED policies.
   *
   * The shape a preview and a sweep both need: the policy read happens once
   * for the whole run rather than once per entity, which is the difference
   * between one query and thirty thousand.
   */
  async evaluateWith(
    policies: Awaited<ReturnType<LifecyclePolicyService['enabled']>>,
    entityType: MediaIntelligenceEntityType,
    entityId: string,
    now: Date,
  ): Promise<LifecycleEvaluation | null> {
    const resolved = await this.contextFor(entityType, entityId).catch(() => null);
    // An entity that vanished mid-sweep is skipped, not failed: a preview or
    // reconciliation must survive the library changing underneath it.
    if (!resolved) return null;

    const desired = resolveDesiredState(policies, resolved.context, now);
    return {
      entityType,
      entityId,
      desiredState: desired,
      drifts: evaluateDrift(desired, resolved.facts),
      evaluatedAt: now.toISOString(),
    };
  }

  /**
   * The scope keys and facts for one entity.
   *
   * Scope matching needs the library and its kind, and both live on the
   * assembled `library` section — `libraryKind` is the library's own
   * classification, which is what a `media_kind` policy is written against.
   * Deliberately NOT the `movie | tv` value the quality resolver derives:
   * that one exists to pick an acquisition ladder, and reusing it here would
   * quietly make an `anime` library match a `tv` policy.
   */
  private async contextFor(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
  ): Promise<{ context: LifecycleMatchContext; facts: DriftFacts }> {
    const assembled = await this.assembler.assemble(entityType, entityId);
    if (!assembled) throw new NotFoundException(`Unknown ${entityType}: ${entityId}`);

    const facts = assembled.facts as unknown as DriftFacts & {
      library?: { libraryId: string | null; libraryKind: string | null };
    };

    return {
      context: {
        entityType,
        entityId,
        libraryId: facts.library?.libraryId ?? null,
        mediaKind: facts.library?.libraryKind ?? null,
        // A series entity IS its show, so a series-scoped policy addressing
        // this id reaches it through either arm of the match.
        showId: entityType === 'series' ? entityId : null,
      },
      facts: {
        quality: facts.quality,
        completeness: facts.completeness,
        subtitles: facts.subtitles,
      },
    };
  }
}
