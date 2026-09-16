/**
 * Lifecycle policies — the Phase 5 vocabulary.
 *
 * Phase 1 produced facts. Phase 2 judged quality against the operator's own
 * ladder. Phase 3 gave a person somewhere to triage. Phase 4 proposed
 * responses. Phase 5 adds the thing all of those were missing: a statement of
 * **what the operator actually wants maintained**.
 *
 * The rule this phase adds:
 *
 *   **POLICIES OWN INTENT. SOURCE DOMAINS OWN FACTS.
 *    MEDIA INTELLIGENCE OWNS THE COMPARISON.**
 *
 * A policy is not a finding (a finding says something IS true), not an
 * automation rule (that says WHEN x happens do y), and not an action. It says
 * "I want this entity to remain in this state", and Phase 5 compares that to
 * the actual state and explains the difference. It maintains nothing
 * automatically — that boundary belongs to Phase 6 and is enforced here by the
 * simple fact that no executor exists.
 *
 * ## Why this is not an Automation rule
 *
 * Mechanical, not stylistic. The automation engine contains:
 *
 *     if (previous && conditions.every((c) => check(c, previous))) continue;
 *     // already satisfied last cycle — not a rising edge
 *
 * It deliberately suppresses itself while a condition stays true. "Keep this
 * entity in state Y" is precisely the case it skips, and its conditions are
 * keyed to a torrent, not a media entity.
 */

/* --------------------------------------------------------------- scoping */

/**
 * Where a policy applies.
 *
 * Only scopes with a real, stable identity in this schema — `MediaLibrary.id`,
 * `MediaLibrary.kind`, `MediaShow.id`, `MediaItem.id`. Season scope is
 * deliberately absent: `MediaSeason` has an id, but no product surface asks
 * for per-season intent, and a scope nobody can reach is a scope that only
 * complicates precedence.
 */
export const LIFECYCLE_SCOPE_TYPES = ['global', 'media_kind', 'library', 'series', 'movie'] as const;
export type LifecycleScopeType = (typeof LIFECYCLE_SCOPE_TYPES)[number];

/**
 * Most specific first. Resolution walks this per DIMENSION, so a series policy
 * that mentions only subtitles inherits quality and completeness from wherever
 * else they were set — an override is a patch, not a replacement.
 *
 * `library` outranks `media_kind` on purpose: a library is a concrete thing
 * the operator created and named, while a media kind is a broad class. Someone
 * who writes a policy for "my 4K library" means it to beat a generic "all
 * movies" rule.
 *
 * `movie` and `series` are mutually exclusive — an entity is never both — so
 * their relative order never actually arbitrates anything. Both are listed
 * ahead of the rest because they are entity-specific.
 */
export const LIFECYCLE_SCOPE_PRECEDENCE: readonly LifecycleScopeType[] = [
  'movie',
  'series',
  'library',
  'media_kind',
  'global',
] as const;

/* ------------------------------------------------------------ dimensions */

/**
 * Quality intent, expressed in Phase 2's OWN vocabulary.
 *
 * There is no second quality ladder and there must never be one. These values
 * name a position in the operator's existing acquisition preference ladder;
 * `AcquisitionMatchPreferenceService` still decides which ladder applies and
 * what its rungs are.
 */
export const LIFECYCLE_QUALITY_INTENTS = [
  /** Explicitly not managed. STOPS inheritance — see the note on null below. */
  'do_not_manage',
  /** Any rung of the configured ladder satisfies this. */
  'maintain_acceptable',
  /** Only the most preferred rung satisfies this. */
  'maintain_preferred',
] as const;
export type LifecycleQualityIntent = (typeof LIFECYCLE_QUALITY_INTENTS)[number];

/**
 * Completeness intent. Reuses Missing Episodes' classification wholesale —
 * aired / unaired / ignored / out-of-scope are the acquisition domain's
 * answers, and re-deriving them here would be the second implementation that
 * drifts.
 */
export const LIFECYCLE_COMPLETENESS_INTENTS = [
  'do_not_manage',
  /** Every AIRED, in-scope, non-ignored episode should be present. */
  'maintain_aired',
] as const;
export type LifecycleCompletenessIntent = (typeof LIFECYCLE_COMPLETENESS_INTENTS)[number];

/**
 * What drift should be allowed to *propose*. Never what it may do.
 *
 * Phase 4 already established that a recommendation to search is not a search.
 * These flags decide whether drift produces an acquisition-flavoured
 * recommendation at all; the search itself stays explicit and operator-driven.
 */
export interface LifecycleAcquisitionIntent {
  /** Propose searching for missing episodes when completeness drifts. */
  searchMissing?: boolean;
  /** Propose verifying an upgrade when quality drifts. Never auto-searches. */
  searchUpgrades?: boolean;
}

/**
 * How far a policy is allowed to go.
 *
 * `automatic` is deliberately ABSENT. The torrent scheduler already set the
 * standard here by refusing a `managed` mode while no reconciliation layer
 * existed — "a mode that lies about what it does is worse than a mode that is
 * missing." Phase 5 has no executor, so it offers no mode that implies one.
 */
export const LIFECYCLE_POLICY_MODES = [
  /** Drift produces findings/recommendations. Nothing is ever actioned. */
  'recommend_only',
  /**
   * Drift produces a recommendation that is explicitly marked as awaiting a
   * person. Identical behaviour today; it records the operator's intent for
   * when Phase 6 can honour it.
   */
  'approval_required',
] as const;
export type LifecyclePolicyMode = (typeof LIFECYCLE_POLICY_MODES)[number];

/* ------------------------------------------------------------ the policy */

/**
 * One operator-authored statement of intent.
 *
 * **Every dimension is nullable, and null means "this policy says nothing
 * about it" — inherit from a broader scope.** That is why `do_not_manage` is a
 * real value rather than being represented by null: "I have no opinion" and "I
 * want this explicitly unmanaged" are different instructions, and a nullable
 * column alone cannot hold both. The torrent scheduler draws the same
 * distinction with `undefined` vs `null`; Prisma collapses those, so the
 * distinction is carried in the enum instead.
 */
export interface MediaLifecyclePolicy {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;

  scopeType: LifecycleScopeType;
  /** Null for `global`; otherwise a library id, media kind, show id or item id. */
  scopeId: string | null;

  mode: LifecyclePolicyMode;

  quality: LifecycleQualityIntent | null;
  completeness: LifecycleCompletenessIntent | null;
  /**
   * Required subtitle languages. `null` = not mentioned (inherit); `[]` =
   * explicitly none, which stops inheritance exactly like `do_not_manage`.
   */
  subtitleLanguages: string[] | null;
  acquisition: LifecycleAcquisitionIntent | null;

  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------- resolved desired state */

/** Which policy supplied one dimension, and what it beat. */
export interface LifecycleDimensionSource {
  policyId: string;
  policyName: string;
  scopeType: LifecycleScopeType;
}

/**
 * One resolved dimension, with its provenance.
 *
 * `overriddenBy` is not decoration: an operator debugging "why is this series
 * asking for Spanish subtitles" needs to see both the policy that won and the
 * ones that lost, or the answer is unfalsifiable.
 */
export interface LifecycleDimension<T> {
  /** Null when no applicable policy mentioned this dimension at all. */
  value: T | null;
  source: LifecycleDimensionSource | null;
  /** True when the winning policy sits at a broader scope than the entity. */
  inherited: boolean;
  /** Applicable policies that also set this dimension but lost. */
  overridden: Array<LifecycleDimensionSource & { value: T }>;
}

/**
 * Two equally-specific policies disagreeing about one dimension.
 *
 * Reported, never silently resolved. The torrent scheduler breaks such ties by
 * caller order — deterministic, but it means an operator can have two policies
 * fighting and never be told. Phase 5 surfaces it instead: the dimension
 * resolves to the first value for determinism AND carries a conflict so the UI
 * can say so.
 */
export interface LifecyclePolicyConflict {
  dimension: string;
  scopeType: LifecycleScopeType;
  contenders: Array<{ policyId: string; policyName: string; value: unknown }>;
}

/** The effective intent for one entity, with every value's origin. */
export interface ResolvedDesiredState {
  entityType: string;
  entityId: string;

  quality: LifecycleDimension<LifecycleQualityIntent>;
  completeness: LifecycleDimension<LifecycleCompletenessIntent>;
  subtitleLanguages: LifecycleDimension<string[]>;
  acquisition: LifecycleDimension<LifecycleAcquisitionIntent>;

  /** Strictest mode among the policies that actually supplied a dimension. */
  mode: LifecyclePolicyMode | null;

  /** Every applicable policy, most specific first. For explainability. */
  applicablePolicies: LifecycleDimensionSource[];
  conflicts: LifecyclePolicyConflict[];
  evaluatedAt: string;
}

/* -------------------------------------------------------------- the drift */

/**
 * How actual state compares to desired state, per dimension.
 *
 * Four outcomes, and the last two carry as much weight as the first two.
 * Mirrors Library Cleanup's `matched | not_matched | unmeasured`, which
 * already established in this codebase that a third answer is mandatory:
 * "unmeasured must never be silently read as 'this does not qualify'".
 */
export const LIFECYCLE_DRIFT_STATUSES = [
  /** Actual state satisfies the desired state. */
  'compliant',
  /** Actual state demonstrably differs. */
  'drift',
  /** No policy governs this dimension for this entity. */
  'not_applicable',
  /**
   * A policy applies but the facts needed to judge it are missing. NEVER
   * compliant and never drift — an unprobed file is unmeasured, not wrong.
   */
  'unknown',
] as const;
export type LifecycleDriftStatus = (typeof LIFECYCLE_DRIFT_STATUSES)[number];

/** Why a dimension could not be evaluated. Distinct from a finding's reasons. */
export const LIFECYCLE_UNKNOWN_REASONS = [
  'no_acquisition_ladder',
  'quality_not_measured',
  'completeness_not_monitored',
  /**
   * Nothing records whether a subtitle scan ever ran for this entity, and
   * embedded tracks are not modelled at all — so the absence of a language is
   * not evidence the language is absent from the media.
   */
  'subtitle_scan_state_unknown',
  'identity_unresolved',
] as const;
export type LifecycleUnknownReason = (typeof LIFECYCLE_UNKNOWN_REASONS)[number];

/** One dimension's verdict. Scalar keys only — humanized at the edge. */
export interface LifecycleDrift {
  dimension: string;
  status: LifecycleDriftStatus;
  /** What the policy asked for, as a stable code or value. */
  desired: unknown;
  /** What the facts actually show. Null when unknown. */
  actual: unknown;
  unknownReason: LifecycleUnknownReason | null;
  /** Which policy supplied the desired value, so the verdict can cite it. */
  source: LifecycleDimensionSource | null;
  /** Bounded scalar evidence. Never a source snapshot. */
  evidence: Record<string, unknown>;
}

/** Everything Phase 5 concluded about one entity. */
export interface LifecycleEvaluation {
  entityType: string;
  entityId: string;
  desiredState: ResolvedDesiredState;
  drifts: LifecycleDrift[];
  evaluatedAt: string;
}

/* ------------------------------------------------------------- preview */

/** Bounded aggregate impact of a policy, computed by the SAME evaluator. */
export interface LifecyclePolicyPreview {
  /** Null while previewing an unsaved draft. */
  policyId: string | null;
  scopeType: LifecycleScopeType;
  scopeId: string | null;

  evaluated: number;
  /** True when the scope holds more entities than the preview cap. */
  truncated: boolean;

  compliant: number;
  drift: number;
  unknown: number;
  notApplicable: number;

  /** Per-dimension breakdown, keyed by dimension name. */
  byDimension: Record<string, { compliant: number; drift: number; unknown: number; notApplicable: number }>;

  /** A bounded sample of drifting entities, for drill-down. */
  samples: Array<{ entityType: string; entityId: string; title: string; dimensions: string[] }>;
}

/** Preview never evaluates a whole library synchronously. */
export const LIFECYCLE_PREVIEW_LIMIT = 500;
/** Bounded sample of affected entities returned with a preview. */
export const LIFECYCLE_PREVIEW_SAMPLES = 20;
