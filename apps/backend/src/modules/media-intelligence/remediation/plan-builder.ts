import {
  MEDIA_RECOMMENDATION_TYPES as T,
  resolvePlanExpiry,
  type MediaIntelligenceEntityType,
  type RemediationBlockReason,
  type RemediationRiskClass,
  type ResolvedDesiredState,
} from '@ultratorrent/shared';

import { capabilityFor, isPlannable, type RemediationCapability } from './remediation-capabilities';

/**
 * Recommendation → plan. The deterministic core of Phase 6.
 *
 * Pure, exactly like `recommendation-evaluator.ts` and
 * `media-health-evaluator.ts` before it: no Prisma, no HTTP, no clock it was
 * not handed. This is the layer deciding what UltraTorrent will actually
 * *do*, so it is the one that has to be provable.
 *
 * Three rules govern everything below.
 *
 * **A plan exists only where the classification says one can.** The builder
 * never reasons about capabilities itself — it asks
 * {@link remediation-capabilities}, which is the single server-side
 * authority. A type whose action does not exist, whose identifier is absent
 * from the evidence, or whose completion would not resolve the drift produces
 * NOTHING here rather than a plan that cannot finish honestly.
 *
 * **A blocker is recorded, not worked around.** When something makes the plan
 * unsafe, the builder still returns a plan — with `blockReason` set and no
 * steps to run. An operator who can see *why* nothing will happen is far
 * better served than one looking at an empty queue.
 *
 * **Steps name the owning domain.** Each step carries the module that owns
 * the mutation, the CAMA id it registered and the permission it enforces.
 * Media Intelligence orchestrates; it never performs, and it never grants.
 */

/** A step before it is persisted. No id, no status — the service adds those. */
export interface PlanStepDraft {
  ordinal: number;
  kind: string;
  ownerDomain: string;
  capabilityId: string | null;
  requiredPermission: string | null;
  inputSnapshot: Record<string, unknown>;
  expectedPostcondition: Record<string, unknown>;
  /** Deterministic, so a duplicate delivery cannot double-execute. */
  idempotencyKey: string;
}

/** A plan before it is persisted. */
export interface PlanDraft {
  entityType: MediaIntelligenceEntityType;
  entityId: string;
  findingId: string;
  recommendationId: string;
  policyId: string | null;
  type: string;
  riskClass: RemediationRiskClass;
  blockReason: RemediationBlockReason | null;
  /** Bounded, scalar. Rendered as the plan's explanation. */
  explanation: Record<string, unknown>;
  steps: PlanStepDraft[];
  expiresAt: Date;
}

/** The recommendation fields a plan may be built from. Deliberately narrow. */
export interface PlanBuilderInput {
  entityType: MediaIntelligenceEntityType;
  entityId: string;
  recommendationId: string;
  findingId: string;
  type: string;
  /** Only an `active` recommendation justifies a plan. */
  status: string;
  evidence: Record<string, unknown>;
  /** The operator's resolved intent, when a lifecycle policy governs this. */
  desired?: ResolvedDesiredState | null;
  /**
   * Facts the builder cannot derive and must be handed, so it stays pure.
   * Absent means UNKNOWN, never false — the distinction Phase 5 established
   * and Phase 6 must not lose.
   */
  facts: {
    /** Null when it could not be determined. Never coerced to false. */
    entityExists: boolean | null;
    /** Null when unknown. A lock blocks, and survives approval. */
    locked: boolean | null;
  };
}

/**
 * Build a plan for one recommendation, or nothing.
 *
 * Returns null when no plan should exist at all — an inactive recommendation,
 * or a type the classification does not support. That is different from a
 * blocked plan, which exists precisely so the reason is visible.
 */
export function buildPlan(input: PlanBuilderInput, now: Date): PlanDraft | null {
  if (input.status !== 'active') return null;

  const cap = capabilityFor(input.type);
  // An unclassified or unsupported type produces nothing. The operator is
  // already told why on the recommendation itself; a permanently-blocked plan
  // per unsupported recommendation would be queue noise, not explanation.
  if (!cap?.supported) return null;
  if (!isPlannable(input.type, input.entityType)) return null;

  const blockReason = firstBlocker(input, cap);
  const policyId = policyBehind(input.desired);

  return {
    entityType: input.entityType,
    entityId: input.entityId,
    findingId: input.findingId,
    recommendationId: input.recommendationId,
    policyId,
    type: input.type,
    riskClass: cap.riskClass,
    blockReason,
    explanation: explain(input, cap, blockReason),
    // A blocked plan carries no steps. Building them would imply work is
    // queued when the gate has already refused it.
    steps: blockReason ? [] : stepsFor(input, cap),
    expiresAt: resolvePlanExpiry(now),
  };
}

/**
 * The first thing making this plan unsafe, in severity order.
 *
 * Ordered deliberately: the most fundamental refusal wins, so an operator
 * fixing one blocker is not immediately shown a second they could have been
 * told about at the same time. `null` facts are treated as blockers, because
 * "we could not determine whether this exists" is not permission to act on it.
 */
function firstBlocker(
  input: PlanBuilderInput,
  cap: RemediationCapability,
): RemediationBlockReason | null {
  if (input.facts.entityExists !== true) return 'entity_missing';
  // Checked before anything else about intent: a locked title is out of every
  // automated path regardless of what a policy asks for.
  if (input.facts.locked !== false) return 'item_locked';

  /*
   * A conflicted dimension must never execute automatically. Phase 5 resolves
   * a same-scope tie deterministically so the system does not flicker, and
   * records the conflict — determinism prevents flicker, it does not express
   * operator intent. Only a conflict on a dimension this remediation would
   * act on counts; an unrelated subtitle conflict must not block a metadata
   * refresh.
   */
  const dimensions = DIMENSIONS_TOUCHED[cap.type] ?? [];
  const conflicted = (input.desired?.conflicts ?? []).some((c) => dimensions.includes(c.dimension));
  if (conflicted) return 'policy_conflict';

  return null;
}

/**
 * Which desired-state dimensions a remediation would act on.
 *
 * Empty for a type no policy dimension governs — a metadata refresh responds
 * to a finding about missing metadata, which no lifecycle dimension expresses,
 * so no policy conflict can make it unsafe. Declared explicitly rather than
 * inferred, so adding a type forces the question to be answered.
 */
const DIMENSIONS_TOUCHED: Record<string, readonly string[]> = {
  [T.REFRESH_METADATA]: [],
};

/** The policy that supplied the governing intent, for explainability. */
function policyBehind(desired: ResolvedDesiredState | null | undefined): string | null {
  if (!desired) return null;
  return desired.applicablePolicies[0]?.policyId ?? null;
}

/**
 * Why this plan exists, in bounded scalars.
 *
 * Never a provider payload, never a path, never a credentialed URL — this
 * object reaches a browser.
 */
function explain(
  input: PlanBuilderInput,
  cap: RemediationCapability,
  blockReason: RemediationBlockReason | null,
): Record<string, unknown> {
  return {
    recommendationType: input.type,
    ownerDomain: cap.ownerDomain,
    capabilityId: cap.capabilityId,
    riskClass: cap.riskClass,
    blocked: blockReason !== null,
    blockReason,
    // What the plan intends to make true, as a stable code.
    intent: INTENT[cap.type] ?? null,
  };
}

const INTENT: Record<string, string> = {
  [T.REFRESH_METADATA]: 'metadata_provider_present',
};

/**
 * The ordered steps.
 *
 * One step today, and the shape is what matters: it names the owning domain,
 * the registered capability, the permission that domain enforces, and a
 * postcondition the next sweep can actually observe.
 */
function stepsFor(input: PlanBuilderInput, cap: RemediationCapability): PlanStepDraft[] {
  switch (cap.type) {
    case T.REFRESH_METADATA:
      return [
        {
          ordinal: 0,
          kind: 'refresh_metadata',
          ownerDomain: cap.ownerDomain!,
          capabilityId: cap.capabilityId,
          requiredPermission: cap.requiredPermission,
          /*
           * For a movie or an episode the entity id IS `MediaItem.id`, which
           * is why the classification restricts this remediation to those two
           * — no resolution step exists that could resolve wrongly.
           */
          inputSnapshot: { itemId: input.entityId },
          /*
           * The finding fires when `metadata.provider` is null, so the
           * postcondition is that a provider is recorded. Observed from
           * source truth on the next sweep — never inferred from the call
           * having returned.
           */
          expectedPostcondition: { metadataProviderPresent: true },
          idempotencyKey: stepKey(input.recommendationId, 0, 'refresh_metadata'),
        },
      ];
    default:
      // Unreachable while the classification supports one type; a new
      // supported type with no steps here would build an empty plan, which
      // the service refuses.
      return [];
  }
}

/**
 * A step's idempotency key.
 *
 * Keyed on the RECOMMENDATION rather than the plan: a plan superseded and
 * rebuilt for the same recommendation is the same intent, and a source action
 * already issued for it must not be issued twice because the plan row changed
 * id. Deterministic, so a duplicate delivery collides rather than duplicating.
 */
export function stepKey(recommendationId: string, ordinal: number, kind: string): string {
  return `${recommendationId}:${ordinal}:${kind}`;
}
