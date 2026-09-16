import { PERMISSIONS, type Permission } from '@ultratorrent/shared';
import {
  MEDIA_RECOMMENDATION_TYPES as T,
  type MediaIntelligenceEntityType,
  type MediaRecommendationTypeValue,
  type RemediationRiskClass,
} from '@ultratorrent/shared';

/**
 * What Phase 6 can actually execute — decided HERE, on the server, once.
 *
 * The frontend must never work out whether something is automatable. It has
 * no way to know whether the owning domain exposes an action, whether the
 * finding carries the identifier that action needs, or whether completing the
 * action would resolve the drift. Every one of those questions is answered in
 * this table and nowhere else.
 *
 * ## Why so few rows are supported
 *
 * Phase 4 established the discipline: a recommendation exists only when a
 * real capability backs it, and a catalogue containing dead paths teaches
 * operators to distrust the whole surface. Phase 6 applies the same test one
 * level deeper, and it is a stricter test — an executable remediation needs
 * FOUR things, not one:
 *
 *   1. an action the owning domain really exposes;
 *   2. the identifier that action takes, present in the finding's evidence;
 *   3. an entity id that resolves to what the action addresses;
 *   4. a postcondition the next sweep can observe, so success means source
 *      truth changed rather than a call returning 200.
 *
 * Five recommendation types carry a `capabilityId`. Only one satisfies all
 * four tests. The audit that established this is recorded per row below,
 * because the temptation to "just wire up the other four" is exactly what
 * this comment exists to answer.
 *
 * ## No automatic execution, in any row
 *
 * `supportsAutomatic` is `false` everywhere, and not as a placeholder. The
 * platform has no autonomous actor: there is no system principal, no
 * service-level guard bypass, and `runAsUserId` on a platform job is
 * attribution rather than authority — the executor never reads it for an
 * authorization decision. Automatic execution would mean inventing that
 * concept, which is a platform change and not a Media Intelligence one.
 */

export interface RemediationCapability {
  type: MediaRecommendationTypeValue;
  /** Can a plan be built for this at all? */
  supported: boolean;
  /** Can a built plan be approved and then executed? */
  supportsApproval: boolean;
  /** Reserved. False in every row — see the file comment. */
  supportsAutomatic: boolean;
  /** Entity types a plan may target. Empty when nothing is supported. */
  entityTypes: readonly MediaIntelligenceEntityType[];
  /** The module that owns the mutation. Media Intelligence never performs it. */
  ownerDomain: string | null;
  /** The CAMA id the owning module registered, when one exists. */
  capabilityId: string | null;
  /** The permission that domain enforces. Recorded, never granted by us. */
  requiredPermission: Permission | null;
  riskClass: RemediationRiskClass;
  /** Stable codes explaining the verdict. Humanized at the edge. */
  reasons: readonly string[];
}

/**
 * The one remediation Phase 6 executes.
 *
 * Every link holds. `METADATA_INCOMPLETE` fires when `metadata.provider` is
 * null — concrete and observable. `MediaBulkService.refreshMetadata` is a
 * real service that dispatches a tracked job, writes one audit row, and
 * silently skips locked items, so §20's "a locked item blocks automation" is
 * enforced by the domain that owns the lock rather than re-implemented here.
 * Writing the provider makes the next sweep evaluate `provider !== null` and
 * resolve the finding, which is a postcondition proved by source truth.
 *
 * Scoped to `movie` and `episode` ONLY. For those, Phase 6's `entityId` is
 * literally `MediaItem.id`, so no resolution step can go wrong. A `series`
 * entity's id is a `MediaShow.id`, the finding fires for shows too (the
 * assembler reads `show.metadata.providerName`), and there is **no
 * show-level metadata refresh service and no `tv_show` CAMA action** — so a
 * series plan would be a plan with no remedy. Excluded rather than faked.
 */
const REFRESH_METADATA: RemediationCapability = {
  type: T.REFRESH_METADATA,
  supported: true,
  supportsApproval: true,
  supportsAutomatic: false,
  entityTypes: ['movie', 'episode'],
  ownerDomain: 'media_manager',
  capabilityId: 'media.metadata.refresh',
  requiredPermission: PERMISSIONS.MEDIA_MANAGER_EDIT_METADATA,
  // Writes metadata rows and nothing on disk. Reversible by re-fetching.
  riskClass: 'low',
  reasons: ['postcondition_observable', 'entity_id_directly_addressable'],
};

/** Everything Phase 6 deliberately does not execute, with the reason. */
const UNSUPPORTED: readonly RemediationCapability[] = [
  {
    type: T.SEARCH_FOR_QUALITY_UPGRADE,
    supported: false,
    supportsApproval: false,
    supportsAutomatic: false,
    entityTypes: [],
    ownerDomain: 'media_acquisition',
    capabilityId: null,
    requiredPermission: null,
    riskClass: 'destructive',
    /*
     * The reference flow Phase 6's brief wanted, and the one the audit ruled
     * out. Acquisition can grab a chosen release, but: an evaluation can only
     * reference a watchlist item, so a lifecycle entity cannot be named on
     * one; intake-created items stay `unmatched`/confidence 0, so the
     * replacement cannot be proven to be the same title; the measured quality
     * captured at import is written to a column nothing reads; and retiring
     * the old copy needs inode identity that no stored state holds.
     */
    reasons: [
      'no_entity_addressed_acquisition',
      'replacement_identity_unprovable',
      'measured_quality_not_persisted',
      'old_copy_retirement_unknowable',
    ],
  },
  {
    type: T.SEARCH_SUBTITLES,
    supported: false,
    supportsApproval: false,
    supportsAutomatic: false,
    entityTypes: [],
    ownerDomain: 'subtitle_intelligence',
    capabilityId: 'subtitles.search',
    requiredPermission: PERMISSIONS.SUBTITLE_INTELLIGENCE_SEARCH,
    riskClass: 'low',
    /*
     * The action is real and genuinely non-mutating — which is exactly why it
     * cannot be a plan. `search` returns candidates and downloads nothing, so
     * a plan built on it would reach `succeeded` with the drift untouched.
     * Phase 6's success condition is that source facts now satisfy the
     * desired state; a step that cannot move them is a step that would make
     * the plan lie.
     */
    reasons: ['executing_resolves_no_drift'],
  },
  {
    type: T.REVIEW_DUPLICATES,
    supported: false,
    supportsApproval: false,
    supportsAutomatic: false,
    entityTypes: [],
    ownerDomain: 'media_manager',
    capabilityId: 'duplicates.ignore',
    requiredPermission: PERMISSIONS.MEDIA_MANAGER_MATCH,
    riskClass: 'moderate',
    /*
     * `duplicates.ignore` needs a group id. The finding's evidence carries
     * `groups` and `reclaimableBytes` — counts, not identity — so nothing
     * downstream knows WHICH group to act on. The recommendation's own plan
     * says `open_review_surface`: it was authored to route a person to the
     * Duplicate Center, not to act. And "ignore" resolves the operator's
     * attention, not the duplication.
     */
    reasons: ['owning_domain_id_absent_from_evidence', 'action_is_triage_not_remedy'],
  },
  {
    type: T.RECHECK_TORRENT,
    supported: false,
    supportsApproval: false,
    supportsAutomatic: false,
    entityTypes: [],
    ownerDomain: 'torrents',
    capabilityId: 'torrents.recheck',
    requiredPermission: PERMISSIONS.TORRENTS_RECHECK,
    riskClass: 'low',
    // Same shape as duplicates: the evidence carries `errored`/`associated`
    // counts, and `TorrentsService.recheck` needs a hash.
    reasons: ['owning_domain_id_absent_from_evidence'],
  },
  {
    type: T.SCAN_LIBRARY,
    supported: false,
    supportsApproval: false,
    supportsAutomatic: false,
    entityTypes: [],
    ownerDomain: 'media_manager',
    capabilityId: 'media.library.scan',
    requiredPermission: PERMISSIONS.MEDIA_MANAGER_SCAN,
    riskClass: 'low',
    /*
     * Declared `arity: 'none'` with `entityTypes: []` — a global action, not
     * one addressed to a title. Phase 6 plans key on movie|series|season|
     * episode, and a library is none of those.
     */
    reasons: ['action_is_library_scoped_not_entity_scoped'],
  },
  {
    type: T.RETRY_FAILED_INTAKE,
    supported: false,
    supportsApproval: false,
    supportsAutomatic: false,
    entityTypes: [],
    ownerDomain: 'media_intake',
    capabilityId: null,
    requiredPermission: null,
    riskClass: 'moderate',
    /*
     * The closest near-miss. `MediaIntakeService.retry(jobId)` is real and
     * the recommendation carries a PROVEN `intakeJobId` in its evidence — so
     * unlike the rows above, the identifier is present. What is missing is a
     * registered action: intake exposes no CAMA id, so executing it would
     * mean Media Intelligence calling a source service that the capability
     * registry does not describe, with no `action-endpoint` gate proving the
     * permission still matches. That is the coupling Phase 6 is built to
     * avoid, and closing it is an intake change, not one to make from here.
     */
    reasons: ['owning_domain_registers_no_action'],
  },
  {
    type: T.REVIEW_FAILED_INTAKE,
    supported: false,
    supportsApproval: false,
    supportsAutomatic: false,
    entityTypes: [],
    ownerDomain: 'media_intake',
    capabilityId: null,
    requiredPermission: null,
    riskClass: 'low',
    // Review-class by construction: releasing a quarantine means choosing a
    // resume stage, which is a judgement no evaluator can make.
    reasons: ['requires_human_judgement'],
  },
  {
    type: T.REVIEW_IDENTITY,
    supported: false,
    supportsApproval: false,
    supportsAutomatic: false,
    entityTypes: [],
    ownerDomain: 'media_manager',
    capabilityId: null,
    requiredPermission: null,
    riskClass: 'moderate',
    // Identity is the one thing this repo has already lost data over. Fuzzy
    // similarity is how a wrong identity gets inherited; a person decides.
    reasons: ['requires_human_judgement'],
  },
];

const BY_TYPE = new Map<string, RemediationCapability>(
  [REFRESH_METADATA, ...UNSUPPORTED].map((c) => [c.type, c]),
);

/** Every classification, for the settings surface and the preview. */
export const REMEDIATION_CAPABILITIES: readonly RemediationCapability[] = [
  REFRESH_METADATA,
  ...UNSUPPORTED,
];

/** The classification for one recommendation type, or null if unknown. */
export function capabilityFor(type: string): RemediationCapability | null {
  return BY_TYPE.get(type) ?? null;
}

/**
 * Can a plan be built for this recommendation, targeting this entity?
 *
 * Both halves matter. A supported type against an entity type it cannot
 * address is not plannable, which is what keeps `REFRESH_METADATA` from being
 * proposed for a series it has no way to refresh.
 */
export function isPlannable(type: string, entityType: string): boolean {
  const cap = capabilityFor(type);
  if (!cap?.supported) return false;
  return cap.entityTypes.includes(entityType as MediaIntelligenceEntityType);
}
