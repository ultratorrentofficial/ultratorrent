/**
 * Recommendations — the Phase 4 vocabulary.
 *
 * Phase 1 produced facts. Phase 2 judged quality against the operator's own
 * ladder. Phase 3 gave a person somewhere to triage what came out. Phase 4
 * answers the next question: **given what UltraTorrent knows, what should be
 * done about it?**
 *
 * The rule this phase adds:
 *
 *   **MEDIA INTELLIGENCE MAY OWN A RECOMMENDATION,
 *    BUT THE OWNING DOMAIN OWNS THE ACTION.**
 *
 * A recommendation names a proposed response and explains it. It never
 * performs one. Every type here either points at a capability another module
 * already registered, or — for quality upgrades — orchestrates a READ-ONLY
 * search through existing acquisition services and hands any resulting grab
 * back to Media Acquisition.
 *
 * ## Why this is not a field on the finding
 *
 * A finding describes a CONDITION and is owned by the evaluator. A
 * recommendation describes a PROPOSED RESPONSE and has a different lifecycle:
 * a condition can stay true while the sensible response changes (a capability
 * is disabled, a preference is edited, a candidate goes stale). Collapsing
 * them would make "this is still broken" and "this is still the right fix"
 * indistinguishable — the same mistake Phase 3 refused to make with
 * disposition versus `resolvedAt`.
 *
 * ## What the catalogue deliberately does NOT contain
 *
 * Audited against the real capability surface rather than copied from a
 * design brief. Absent on purpose:
 *
 *   - **`GATHER_TECHNICAL_DATA`** — there is no user-invocable mediainfo
 *     probe in this codebase. `MediaProbeService` is reachable only from the
 *     scheduled backfill and the intake pipeline; no controller injects it.
 *     A recommendation pointing at it would render a dead control.
 *   - **`SEARCH_FOR_MISSING_MOVIE`** — no movie search path exists at all.
 *     `TvSearchQuery` carries no movie fields and the release selector
 *     hard-requires a season and an episode.
 *   - **`ACQUIRE_MISSING_SUBTITLES`** — subtitle download takes a chosen
 *     CANDIDATE, not a media item. Which release wins is a product decision
 *     nobody has made, so only the search is offered.
 *   - **anything keyed to `BACKFILL_STALLED`** — that finding code is
 *     declared and classified but never emitted by any evaluator. Building on
 *     it would produce a rule that can never fire.
 *   - **anything that deletes.** Duplicate review is offered; choosing a
 *     victim is not. Storage and lifecycle policy is a later phase.
 */

/* --------------------------------------------------------------- the what */

/**
 * The proposed response. Stable machine identity, exactly like a finding code:
 * stored, filtered and translated at the edge, never persisted as prose.
 *
 * Each entry exists only because a real capability backs it. Adding one is a
 * claim that UltraTorrent can actually help, so it is cheap to add and
 * expensive to be wrong about.
 */
export const MEDIA_RECOMMENDATION_TYPES = {
  /**
   * Ask the indexers whether a release satisfying a higher rung can actually
   * be obtained. The recommendation is to SEARCH — never to replace, and
   * never a claim that a better release exists.
   */
  SEARCH_FOR_QUALITY_UPGRADE: 'SEARCH_FOR_QUALITY_UPGRADE',
  /** Look for the subtitles this library's own language policy asks for. */
  SEARCH_SUBTITLES: 'SEARCH_SUBTITLES',
  /** Re-run a failed intake from where it stopped. Only when it can retry. */
  RETRY_FAILED_INTAKE: 'RETRY_FAILED_INTAKE',
  /** A failed or quarantined intake a person has to look at. */
  REVIEW_FAILED_INTAKE: 'REVIEW_FAILED_INTAKE',
  /** Open the duplicate group. Never "delete the copy we picked". */
  REVIEW_DUPLICATES: 'REVIEW_DUPLICATES',
  /** Nothing matched and no external id is recorded; a person decides. */
  REVIEW_IDENTITY: 'REVIEW_IDENTITY',
  /** Fetch metadata that was never successfully enriched. */
  REFRESH_METADATA: 'REFRESH_METADATA',
  /** The library has never been scanned, so everything about it is a guess. */
  SCAN_LIBRARY: 'SCAN_LIBRARY',
  /** An associated torrent is in an error state; recheck it. */
  RECHECK_TORRENT: 'RECHECK_TORRENT',
} as const;

export type MediaRecommendationType = keyof typeof MEDIA_RECOMMENDATION_TYPES;
export type MediaRecommendationTypeValue =
  (typeof MEDIA_RECOMMENDATION_TYPES)[MediaRecommendationType];

export const ALL_MEDIA_RECOMMENDATION_TYPES = Object.values(
  MEDIA_RECOMMENDATION_TYPES,
) as MediaRecommendationTypeValue[];

/**
 * The NATURE of the response, independent of the specific type.
 *
 * Kept separate so the UI can group and phrase consistently ("3 things to
 * review, 1 to search for") without the frontend re-deriving it from a
 * growing list of type strings.
 */
export const MEDIA_RECOMMENDATION_CLASSES = [
  /** A person must look and decide. UltraTorrent proposes no specific change. */
  'review',
  /** Ask an external source whether something is obtainable. */
  'search',
  /** Re-run an operation that already failed once. */
  'retry',
  /** Re-derive something the system can fix without a human choice. */
  'repair',
] as const;
export type MediaRecommendationClass = (typeof MEDIA_RECOMMENDATION_CLASSES)[number];

/* ------------------------------------------------------------- confidence */

/**
 * How much UltraTorrent trusts its own suggestion.
 *
 * Deliberately three coarse words, not a percentage. A number like `93%`
 * implies a calibrated probability model, and there is none — inventing one
 * would be the same dishonesty as reporting an unmeasured file as SDR. The
 * value is a deterministic function of what the evidence actually proves, and
 * a rule must be able to say why it chose one.
 */
export const MEDIA_RECOMMENDATION_CONFIDENCE = [
  /** Authoritative identity, measured facts, and a direct capability. */
  'high',
  /** The response is probably right, but one input is partial or stale. */
  'medium',
  /** Enough to justify a look; not enough to propose a specific remedy. */
  'low',
] as const;
export type MediaRecommendationConfidence = (typeof MEDIA_RECOMMENDATION_CONFIDENCE)[number];

/* -------------------------------------------------------------- lifecycle */

/**
 * Whether the recommendation still describes reality.
 *
 * This is about the RECOMMENDATION's validity, never about how a person feels
 * about it. Acknowledge / snooze / dismiss stay on the finding, where Phase 3
 * put them — a second disposition vocabulary here would split one operator
 * decision across two rows that could disagree.
 */
export const MEDIA_RECOMMENDATION_STATUSES = [
  /** Current and actionable. */
  'active',
  /** A real superior candidate was found by an explicit search. */
  'verified',
  /** No longer applicable: the evidence moved or the capability went away. */
  'invalidated',
  /** The underlying finding resolved — the condition is gone. */
  'satisfied',
] as const;
export type MediaRecommendationStatus = (typeof MEDIA_RECOMMENDATION_STATUSES)[number];

/**
 * Why a recommendation stopped applying. Drives the history entry and the UI
 * explanation, so an operator is never told only that something "changed".
 */
export const MEDIA_RECOMMENDATION_INVALIDATION_REASONS = [
  'finding_resolved',
  'evidence_changed',
  'preference_changed',
  'capability_unavailable',
  'no_longer_retryable',
] as const;
export type MediaRecommendationInvalidationReason =
  (typeof MEDIA_RECOMMENDATION_INVALIDATION_REASONS)[number];

/* ----------------------------------------------------------- verification */

/**
 * Whether availability has actually been established.
 *
 * **This is the distinction the whole phase turns on.** `SEARCH_FOR_QUALITY_UPGRADE`
 * says a higher rung exists in the operator's own ladder — upgrade POTENTIAL.
 * It says nothing about whether such a release can be obtained today. Only an
 * explicit search moves this to `verified`, and only then may the product use
 * the word "available".
 */
export const MEDIA_VERIFICATION_STATUSES = [
  /** This type needs no external check — the target already exists locally. */
  'not_required',
  /** Verifiable, and nobody has asked yet. The default. Never a failure. */
  'not_checked',
  /** A search is running right now. */
  'checking',
  /** A real superior candidate was found and is still fresh. */
  'verified',
  /** The search ran and honestly found nothing better. Not an error. */
  'no_match',
  /** Something was found once, but the result has aged out. */
  'stale',
  /** The search could not be completed — providers failed. NOT `no_match`. */
  'failed',
] as const;
export type MediaVerificationStatus = (typeof MEDIA_VERIFICATION_STATUSES)[number];

/**
 * How long a verified candidate keeps its claim.
 *
 * Indexer results are ephemeral: a release that existed yesterday may be gone,
 * and a set of seeders certainly is. Twelve hours is deliberately shorter than
 * the six-hour reconcile is frequent, so a verification is re-earned rather
 * than inherited, and no candidate can quietly remain "available" for a week.
 */
export const VERIFICATION_FRESHNESS_HOURS = 12;

/* ------------------------------------------------------------------ plans */

/**
 * One step of an explanatory plan.
 *
 * Stable codes, not sentences — the same reason finding codes are codes. A
 * plan describes what WOULD happen; nothing here executes because a plan
 * exists.
 */
export const MEDIA_REMEDIATION_STEPS = [
  'search_indexers',
  'evaluate_against_preferences',
  'compare_with_owned',
  'present_candidates',
  'require_approval',
  'hand_off_to_owning_domain',
  'open_review_surface',
  'retry_from_resume_state',
] as const;
export type MediaRemediationStep = (typeof MEDIA_REMEDIATION_STEPS)[number];

/* ------------------------------------------------------------------ DTOs */

/**
 * The comparison of one searched candidate against what is already owned.
 *
 * Every dimension is nullable and null means UNKNOWN, never "no" and never
 * zero. An owned file's source and release group genuinely cannot be
 * recovered after import and rename, so those stay null on the owned side
 * rather than being invented for symmetry.
 */
export interface MediaCandidateDimension {
  dimension: string;
  owned: string | null;
  candidate: string | null;
  /** True only when the candidate is demonstrably better on this dimension. */
  improved: boolean;
}

/**
 * A bounded, already-normalized snapshot of one searched release.
 *
 * Deliberately NOT the provider payload. No download URL, no tracker
 * credentials, no raw JSON — an indexer link can carry an authentication
 * token, and this object is rendered in a browser.
 */
export interface MediaUpgradeCandidate {
  /** Stable enough to re-find the release; never a credentialed URL. */
  releaseName: string;
  indexerName: string;
  sizeBytes: number | null;
  seeders: number | null;
  /** Which rung of the operator's ladder this release satisfies. */
  matchedRung: number | null;
  matchedRungName: string | null;
  /** Per-dimension comparison against the owned copy. */
  dimensions: MediaCandidateDimension[];
  /** Why this is (or is not) an improvement, as stable codes. */
  improvements: string[];
  tradeoffs: string[];
}

/** One entry in a recommendation's history. Bounded, never localized prose. */
export interface MediaRecommendationHistoryEntry {
  id: string;
  event: string;
  at: string;
  actorUserId: string | null;
  detail: Record<string, unknown>;
}

/**
 * One recommendation, as the API returns it.
 *
 * Evidence is a deliberate DTO assembled by the evaluator — never the raw
 * finding row and never an arbitrary provider response.
 */
export interface MediaRecommendation {
  id: string;
  findingId: string;
  entityType: string;
  entityId: string;

  type: MediaRecommendationTypeValue;
  recommendationClass: MediaRecommendationClass;
  status: MediaRecommendationStatus;
  confidence: MediaRecommendationConfidence;

  /** The finding this responds to, denormalized for rendering only. */
  findingCode: string;
  findingSeverity: string;

  /** Denormalized from the projection for rendering; never authoritative. */
  title: string;
  year: number | null;

  /** What the suggestion rests on. Scalar keys, humanized at the edge. */
  evidence: Record<string, unknown>;
  /** What UltraTorrent still does not know. Rendered verbatim as caveats. */
  unknowns: string[];
  /** The explanatory plan. Codes, translated at presentation. */
  plan: MediaRemediationStep[];

  /** The CAMA capability that would execute this, when one exists. */
  capabilityId: string | null;

  verification: MediaVerificationStatus;
  verifiedAt: string | null;
  /** Best candidate from the last successful verification, if still fresh. */
  candidate: MediaUpgradeCandidate | null;

  invalidationReason: MediaRecommendationInvalidationReason | null;
  evaluatedAt: string;
  createdAt: string;
}

export interface MediaRecommendationListResult {
  items: MediaRecommendation[];
  total: number;
  page: number;
  pageSize: number;
}

/** Counts for the recommendation overview. Same predicate as the list. */
export interface MediaRecommendationSummary {
  active: number;
  verified: number;
  /** Active, verifiable and never checked — the "could look" bucket. */
  unverified: number;
  high: number;
  medium: number;
  low: number;
}

/** The outcome of an explicit verification run. */
export interface MediaVerificationResult {
  status: MediaVerificationStatus;
  /** Bounded and ranked by the authoritative evaluator, best first. */
  candidates: MediaUpgradeCandidate[];
  checkedAt: string;
  /** Indexers attempted and how many failed — honesty about partial answers. */
  indexersQueried: number;
  indexersFailed: number;
}

/** Never return an unbounded candidate list to a browser. */
export const MAX_UPGRADE_CANDIDATES = 10;
