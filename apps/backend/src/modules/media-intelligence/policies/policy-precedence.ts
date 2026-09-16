import {
  LIFECYCLE_SCOPE_PRECEDENCE,
  type LifecycleAcquisitionIntent,
  type LifecycleCompletenessIntent,
  type LifecycleDimension,
  type LifecycleDimensionSource,
  type LifecyclePolicyConflict,
  type LifecyclePolicyMode,
  type LifecycleQualityIntent,
  type LifecycleScopeType,
  type MediaLifecyclePolicy,
  type ResolvedDesiredState,
} from '@ultratorrent/shared';

/**
 * Resolving overlapping policies into one effective intent.
 *
 * Pure. No Prisma, no clock it was not handed, no IO. That is deliberate and
 * it is what makes Phase 6 safe to build later: precedence is decided in
 * exactly one place, and a rule that needs a database to demonstrate is a rule
 * nobody writes a test for.
 *
 * The design is lifted, on purpose, from `torrent-scheduler/domain/policy.ts`,
 * which already solved this problem in this codebase:
 *
 *   - an explicit most-specific-first scope order, never DB row order and
 *     never `createdAt`;
 *   - resolution **per dimension**, so an override is a patch rather than a
 *     replacement;
 *   - per-field provenance, because "a queue reason that cannot cite its
 *     source is not explainable".
 *
 * One deliberate departure. The scheduler resolves a same-scope tie by taking
 * whichever policy the caller listed first — deterministic, but it means two
 * policies can fight forever and nobody is told. Here a tie still resolves
 * deterministically (so the system never flickers) AND records a conflict, so
 * the operator can see that their configuration is ambiguous.
 */

/** What an entity is, for deciding which scopes reach it. */
export interface LifecycleMatchContext {
  entityType: string;
  entityId: string;
  /** The library the entity lives in, when known. */
  libraryId?: string | null;
  /** `tv` | `anime` | `movie` | … — the library's kind, or the item's. */
  mediaKind?: string | null;
  /** For an episode/season, the show it belongs to. */
  showId?: string | null;
}

/** Does this policy's scope reach this entity? */
export function policyApplies(policy: MediaLifecyclePolicy, ctx: LifecycleMatchContext): boolean {
  switch (policy.scopeType) {
    case 'global':
      return true;
    case 'library':
      return !!ctx.libraryId && policy.scopeId === ctx.libraryId;
    case 'media_kind':
      return !!ctx.mediaKind && policy.scopeId === ctx.mediaKind;
    case 'series':
      // A series policy reaches the show itself and anything beneath it.
      return (
        (ctx.entityType === 'series' && policy.scopeId === ctx.entityId) ||
        (!!ctx.showId && policy.scopeId === ctx.showId)
      );
    case 'movie':
      return ctx.entityType === 'movie' && policy.scopeId === ctx.entityId;
    default:
      return false;
  }
}

/** The dimensions resolved independently of one another. */
const DIMENSIONS = ['quality', 'completeness', 'subtitleLanguages', 'acquisition'] as const;
type DimensionKey = (typeof DIMENSIONS)[number];

/**
 * Is this dimension actually SET on this policy?
 *
 * `null` means the policy says nothing and inheritance continues. Every other
 * value — including `do_not_manage` and an empty language list — is a decision
 * that stops the search. This is the three-valued contract the scheduler
 * expresses as `undefined` / `null` / value; Prisma cannot store `undefined`,
 * so the "explicitly none" end is carried in the value instead.
 */
function isSet(policy: MediaLifecyclePolicy, dim: DimensionKey): boolean {
  return policy[dim] != null;
}

function sourceOf(policy: MediaLifecyclePolicy): LifecycleDimensionSource {
  return { policyId: policy.id, policyName: policy.name, scopeType: policy.scopeType };
}

/** An unset dimension, so callers never have to null-check the wrapper. */
function unset<T>(): LifecycleDimension<T> {
  return { value: null, source: null, inherited: false, overridden: [] };
}

/**
 * Resolve every dimension for one entity.
 *
 * Disabled policies are filtered out entirely rather than skipped per field:
 * a disabled override must fall through to its parent, not pin the dimension
 * to its own value.
 */
export function resolveDesiredState(
  policies: readonly MediaLifecyclePolicy[],
  ctx: LifecycleMatchContext,
  now: Date,
): ResolvedDesiredState {
  const applicable = policies.filter((p) => p.enabled && policyApplies(p, ctx));

  // Most specific first, so the winner of every dimension is simply the first
  // policy in this list that sets it.
  const ordered = [...applicable].sort(
    (a, b) =>
      LIFECYCLE_SCOPE_PRECEDENCE.indexOf(a.scopeType) - LIFECYCLE_SCOPE_PRECEDENCE.indexOf(b.scopeType) ||
      // Stable, explainable tie-break within a scope. NOT the answer to a
      // conflict — that is reported separately — just a guarantee that two
      // runs over the same data agree.
      a.id.localeCompare(b.id),
  );

  const conflicts: LifecyclePolicyConflict[] = [];
  const resolved: Record<string, LifecycleDimension<unknown>> = {};

  // The most specific scope any applicable policy occupies. Anything decided
  // at a broader scope than this is, by definition, inherited.
  const narrowest = ordered.length
    ? LIFECYCLE_SCOPE_PRECEDENCE.indexOf(ordered[0].scopeType)
    : LIFECYCLE_SCOPE_PRECEDENCE.length;

  for (const dim of DIMENSIONS) {
    const setters = ordered.filter((p) => isSet(p, dim));
    if (!setters.length) {
      resolved[dim] = unset();
      continue;
    }

    const winner = setters[0];
    const winnerRank = LIFECYCLE_SCOPE_PRECEDENCE.indexOf(winner.scopeType);

    /*
     * Ambiguity check: another policy at the SAME scope type setting the same
     * dimension to a different value. That is a configuration the operator
     * cannot reason about, and picking one silently is how a system becomes
     * untrustworthy. Deep-compared because subtitle lists and acquisition
     * intent are structures, not scalars.
     */
    const rivals = setters.filter(
      (p) => p.scopeType === winner.scopeType && p.id !== winner.id &&
        JSON.stringify(p[dim]) !== JSON.stringify(winner[dim]),
    );
    if (rivals.length) {
      conflicts.push({
        dimension: dim,
        scopeType: winner.scopeType,
        contenders: [winner, ...rivals].map((p) => ({
          policyId: p.id,
          policyName: p.name,
          value: p[dim],
        })),
      });
    }

    resolved[dim] = {
      value: winner[dim],
      source: sourceOf(winner),
      inherited: winnerRank > narrowest,
      // Everything that set this dimension and lost, so the UI can show what
      // was overridden rather than only what won.
      overridden: setters
        .filter((p) => p.id !== winner.id)
        .map((p) => ({ ...sourceOf(p), value: p[dim] as never })),
    };
  }

  return {
    entityType: ctx.entityType,
    entityId: ctx.entityId,
    quality: resolved.quality as LifecycleDimension<LifecycleQualityIntent>,
    completeness: resolved.completeness as LifecycleDimension<LifecycleCompletenessIntent>,
    subtitleLanguages: resolved.subtitleLanguages as LifecycleDimension<string[]>,
    acquisition: resolved.acquisition as LifecycleDimension<LifecycleAcquisitionIntent>,
    mode: strictestMode(ordered, resolved),
    applicablePolicies: ordered.map(sourceOf),
    conflicts,
    evaluatedAt: now.toISOString(),
  };
}

/**
 * The mode that governs this entity.
 *
 * Taken only from policies that actually supplied a dimension — a policy whose
 * every dimension was overridden is contributing nothing, and letting its mode
 * survive would mean an invisible policy still changing behaviour. Strictest
 * wins, because a mode is a ceiling on what may happen, and the cautious
 * reading is the safe one.
 */
function strictestMode(
  ordered: readonly MediaLifecyclePolicy[],
  resolved: Record<string, LifecycleDimension<unknown>>,
): LifecyclePolicyMode | null {
  const contributing = new Set(
    Object.values(resolved)
      .map((d) => d.source?.policyId)
      .filter((id): id is string => !!id),
  );
  const modes = ordered.filter((p) => contributing.has(p.id)).map((p) => p.mode);
  if (!modes.length) return null;
  return modes.includes('approval_required') ? 'approval_required' : 'recommend_only';
}
