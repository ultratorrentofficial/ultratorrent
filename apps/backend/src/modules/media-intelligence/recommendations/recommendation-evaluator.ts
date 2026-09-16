import {
  MEDIA_FINDING_CODES,
  MEDIA_RECOMMENDATION_TYPES,
  type MediaRecommendationClass,
  type MediaRecommendationConfidence,
  type MediaRecommendationTypeValue,
  type MediaRemediationStep,
  type MediaVerificationStatus,
} from '@ultratorrent/shared';

/**
 * Finding → recommendation. The deterministic core of Phase 4.
 *
 * Pure, exactly like its sibling `media-health-evaluator.ts`: no Prisma, no
 * HTTP, no clock it was not handed. A recommendation rule that needs a
 * database to demonstrate is a rule nobody writes a test for, and this is the
 * layer that must be provable — it is the one deciding what to tell an
 * operator to do.
 *
 * Three rules govern everything below.
 *
 * **A recommendation exists only when a real capability backs it.** The
 * catalogue was derived by auditing the actual capability surface, not from a
 * wish list. Codes whose natural remedy does not exist in this codebase get
 * NO recommendation rather than one pointing at a control that isn't there —
 * `MEDIA_TECHNICAL_DATA_MISSING` is the clearest case: there is no
 * user-invocable mediainfo probe anywhere, so "re-probe this file" cannot be
 * offered however much it would tidy up the UI.
 *
 * **Insufficient evidence produces no recommendation, never a confident
 * guess.** Sometimes the honest answer is that nothing can be proposed.
 *
 * **Potential is not availability.** `SEARCH_FOR_QUALITY_UPGRADE` proposes
 * asking the indexers. It is not a claim that a better release exists, and
 * until an explicit search says otherwise its verification stays
 * `not_checked` — which is a neutral state, not a failure.
 */

/** The finding fields a rule is allowed to see. Deliberately narrow. */
export interface RecommendationInput {
  findingId: string;
  code: string;
  severity: string;
  entityType: string;
  entityId: string;
  evidence: Record<string, unknown>;
  /**
   * Proof, supplied by the caller, that a specific intake job can actually be
   * retried. Absent means "not proven" — the rule then proposes review rather
   * than asserting a retry that `MediaIntakeService.retry()` would refuse.
   * Kept as an input rather than a lookup so this file stays pure and a
   * library-wide sweep cannot turn into one query per entity.
   */
  retryableIntakeJobId?: string | null;
}

export interface RecommendationDraft {
  findingId: string;
  type: MediaRecommendationTypeValue;
  recommendationClass: MediaRecommendationClass;
  confidence: MediaRecommendationConfidence;
  /** Scalar keys only — a humanizer cannot take apart a composite string. */
  evidence: Record<string, unknown>;
  /** What is still not known. Rendered to the operator verbatim as caveats. */
  unknowns: string[];
  plan: MediaRemediationStep[];
  capabilityId: string | null;
  verification: MediaVerificationStatus;
}

const T = MEDIA_RECOMMENDATION_TYPES;
const F = MEDIA_FINDING_CODES;

/** Read a number from evidence without inventing one. */
function num(evidence: Record<string, unknown>, key: string): number | null {
  const v = evidence[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Evaluate one finding.
 *
 * Returns null when no honest recommendation can be made — which is a normal
 * outcome, not an error, and covers most of the catalogue.
 */
export function evaluateRecommendation(input: RecommendationInput): RecommendationDraft | null {
  switch (input.code) {
    /* ------------------------------------------------------------ quality */
    /*
     * Both quality findings propose the SAME act: ask whether something
     * better can actually be obtained. They differ only in how far the owned
     * copy is from the ladder, which is already recorded on the finding.
     *
     * Confidence keys off whether the comparison rested on measurement.
     * `QUALITY_BELOW_PREFERENCE` names the dimensions that failed, so it is
     * `high`; upgrade potential is a statement about rung ORDER and is
     * `medium`, because the operator chose that fallback rung themselves and
     * a better release may simply never have existed.
     */
    case F.QUALITY_BELOW_PREFERENCE:
      return {
        findingId: input.findingId,
        type: T.SEARCH_FOR_QUALITY_UPGRADE,
        recommendationClass: 'search',
        confidence: num(input.evidence, 'measuredFileCount') ? 'high' : 'low',
        evidence: {
          ownedResolution: input.evidence.ownedResolution ?? null,
          ownedCodec: input.evidence.ownedCodec ?? null,
          preferenceSource: input.evidence.preferenceSource ?? null,
          totalRungs: input.evidence.totalRungs ?? null,
          failedOn: input.evidence.failedOn ?? null,
          measuredFileCount: input.evidence.measuredFileCount ?? null,
        },
        unknowns: ['whether_a_superior_release_is_obtainable'],
        plan: [
          'search_indexers',
          'evaluate_against_preferences',
          'compare_with_owned',
          'present_candidates',
          'require_approval',
          'hand_off_to_owning_domain',
        ],
        // No CAMA id: acquisition registers no per-item search capability.
        // Verification is Media Intelligence's own read-only orchestration,
        // and any resulting grab is handed to Media Acquisition.
        capabilityId: null,
        verification: 'not_checked',
      };

    case F.QUALITY_UPGRADE_POTENTIAL:
      return {
        findingId: input.findingId,
        type: T.SEARCH_FOR_QUALITY_UPGRADE,
        recommendationClass: 'search',
        confidence: 'medium',
        evidence: {
          ownedResolution: input.evidence.ownedResolution ?? null,
          matchedRung: input.evidence.matchedRung ?? null,
          matchedRungName: input.evidence.matchedRungName ?? null,
          preferredRung: input.evidence.preferredRung ?? null,
          totalRungs: input.evidence.totalRungs ?? null,
          preferenceSource: input.evidence.preferenceSource ?? null,
        },
        unknowns: ['whether_a_superior_release_is_obtainable'],
        plan: [
          'search_indexers',
          'evaluate_against_preferences',
          'compare_with_owned',
          'present_candidates',
          'require_approval',
          'hand_off_to_owning_domain',
        ],
        capabilityId: null,
        verification: 'not_checked',
      };

    /* ------------------------------------------------------------- intake */
    /*
     * Retry is offered ONLY when the caller proved a job can take it.
     * `MediaIntakeService.retry()` accepts exactly one state (`failed`) and
     * throws for everything else, so proposing it from a finding that merely
     * counts failures would produce a button that 500s. The finding's
     * evidence carries counts, not a job id or a state.
     */
    case F.INTAKE_FAILED:
      return input.retryableIntakeJobId
        ? {
            findingId: input.findingId,
            type: T.RETRY_FAILED_INTAKE,
            recommendationClass: 'retry',
            confidence: 'high',
            evidence: {
              failed: input.evidence.failed ?? null,
              lastError: input.evidence.lastError ?? null,
              intakeJobId: input.retryableIntakeJobId,
            },
            unknowns: ['whether_the_original_cause_was_addressed'],
            plan: ['retry_from_resume_state'],
            capabilityId: null,
            verification: 'not_required',
          }
        : {
            findingId: input.findingId,
            type: T.REVIEW_FAILED_INTAKE,
            recommendationClass: 'review',
            confidence: 'medium',
            evidence: {
              failed: input.evidence.failed ?? null,
              lastError: input.evidence.lastError ?? null,
            },
            unknowns: ['whether_the_failure_is_retryable'],
            plan: ['open_review_surface'],
            capabilityId: null,
            verification: 'not_required',
          };

    /*
     * A quarantine is a deliberate stop that asked for a person: releasing it
     * requires choosing which stage to resume at, which is a judgement no
     * evaluator can make. Review only — never an automatic release.
     */
    case F.INTAKE_QUARANTINED:
      return {
        findingId: input.findingId,
        type: T.REVIEW_FAILED_INTAKE,
        recommendationClass: 'review',
        confidence: 'high',
        evidence: { quarantined: input.evidence.quarantined ?? null },
        unknowns: ['which_stage_should_resume'],
        plan: ['open_review_surface'],
        capabilityId: null,
        verification: 'not_required',
      };

    /* --------------------------------------------------------- duplicates */
    /*
     * Review, never deletion. Phase 4 cannot prove which copy is safe to
     * remove, and this project has already destroyed two unrecoverable
     * episodes by acting on a confident wrong grouping.
     */
    case F.DUPLICATE_MEDIA_PRESENT:
      return {
        findingId: input.findingId,
        type: T.REVIEW_DUPLICATES,
        recommendationClass: 'review',
        confidence: 'high',
        evidence: {
          groups: input.evidence.groups ?? null,
          reclaimableBytes: input.evidence.reclaimableBytes ?? null,
        },
        unknowns: ['which_copy_should_be_kept'],
        plan: ['open_review_surface'],
        capabilityId: 'duplicates.ignore',
        verification: 'not_required',
      };

    /* ----------------------------------------------------------- identity */
    /*
     * Review, never an automatic match. Identification has explicit safety
     * gates (a locked item refuses outright; a season-containment guard
     * refuses to attach an episode to a series that cannot contain it), and
     * fuzzy title similarity is exactly how a wrong identity gets inherited.
     */
    case F.IDENTITY_UNRESOLVED:
      return {
        findingId: input.findingId,
        type: T.REVIEW_IDENTITY,
        recommendationClass: 'review',
        confidence: 'high',
        evidence: {
          matchStatus: input.evidence.matchStatus ?? null,
          knownTitle: input.evidence.knownTitle ?? null,
        },
        unknowns: ['which_title_this_actually_is'],
        plan: ['open_review_surface'],
        // Identity endpoints exist but register no CAMA action.
        capabilityId: null,
        verification: 'not_required',
      };

    /* ----------------------------------------------------------- metadata */
    case F.METADATA_INCOMPLETE:
      return {
        findingId: input.findingId,
        type: T.REFRESH_METADATA,
        recommendationClass: 'repair',
        confidence: 'high',
        evidence: { hasOverview: input.evidence.hasOverview ?? null },
        unknowns: ['whether_a_provider_has_this_title'],
        plan: ['hand_off_to_owning_domain'],
        capabilityId: 'media.metadata.refresh',
        verification: 'not_required',
      };

    /* ---------------------------------------------------------- subtitles */
    /*
     * Deliberately `low` and framed as a search.
     *
     * Phase 1 graded this `info` on the stated grounds that no subtitle
     * policy exists. That is true of Media Intelligence and FALSE of the
     * platform: `SubtitleLanguageSetting.requiredLanguages` is a real
     * per-library policy that the missing-subtitle scan already honours, and
     * this layer has never read it. Until it does, the finding proves only
     * that coverage is uneven WITHIN the title — not that any required
     * language is absent — so the confidence stays low and the unknown says
     * so plainly.
     */
    case F.SUBTITLE_COVERAGE_INCOMPLETE:
      return {
        findingId: input.findingId,
        type: T.SEARCH_SUBTITLES,
        recommendationClass: 'search',
        confidence: 'low',
        evidence: {
          withSubtitles: input.evidence.withSubtitles ?? null,
          total: input.evidence.total ?? null,
          without: input.evidence.without ?? null,
        },
        unknowns: ['whether_any_required_language_is_missing'],
        plan: ['open_review_surface'],
        // Provider-gated: this action leaves the catalogue when every
        // subtitle provider is unhealthy, so the UI must tolerate its absence.
        capabilityId: 'subtitles.search',
        verification: 'not_required',
      };

    /* ------------------------------------------------------------ library */
    case F.LIBRARY_NEVER_SCANNED:
      return {
        findingId: input.findingId,
        type: T.SCAN_LIBRARY,
        recommendationClass: 'repair',
        confidence: 'high',
        evidence: {
          libraryId: input.evidence.libraryId ?? null,
          libraryName: input.evidence.libraryName ?? null,
        },
        unknowns: [],
        plan: ['hand_off_to_owning_domain'],
        capabilityId: 'media.library.scan',
        verification: 'not_required',
      };

    /* ------------------------------------------------------------ torrent */
    case F.TORRENT_ERROR:
      return {
        findingId: input.findingId,
        type: T.RECHECK_TORRENT,
        recommendationClass: 'repair',
        confidence: 'medium',
        evidence: {
          errored: input.evidence.errored ?? null,
          associated: input.evidence.associated ?? null,
        },
        unknowns: ['whether_a_recheck_clears_the_error'],
        plan: ['hand_off_to_owning_domain'],
        // The action's entity is a torrent, not a media item; the UI hands
        // off through the association rather than acting from here.
        capabilityId: 'torrents.recheck',
        verification: 'not_required',
      };

    /*
     * Everything else gets NOTHING, and that is the point.
     *
     *   EPISODES_MISSING            — the search endpoint is keyed to a
     *                                 watchlist item, not a media entity, and
     *                                 it grabs as part of the same call. There
     *                                 is no read-only per-entity search to
     *                                 point at.
     *   MEDIA_TECHNICAL_DATA_MISSING— no user-invocable probe exists at all.
     *   IDENTITY_EXTERNAL_ID_CONFLICT — nothing can resolve it; documented as
     *                                 never auto-merged.
     *   ARTWORK_INCOMPLETE          — every artwork route needs a human to
     *                                 choose an image; no one-shot exists.
     *   ACQUISITION_NOT_READY /
     *   ACQUISITION_SEARCH_FAILING  — the remedy is editing configuration or
     *                                 fixing an indexer, neither of which is
     *                                 an entity-scoped action.
     *   BACKFILL_STALLED            — declared but never emitted by any
     *                                 evaluator; a rule for it could not fire.
     */
    default:
      return null;
  }
}

/**
 * Evaluate a set of findings for one entity.
 *
 * Order follows the findings it was given, which the health evaluator already
 * sorted worst-first, so a caller never has to re-sort and two runs over
 * identical facts produce identical output.
 */
export function evaluateRecommendations(
  inputs: readonly RecommendationInput[],
): RecommendationDraft[] {
  const out: RecommendationDraft[] = [];
  for (const input of inputs) {
    const draft = evaluateRecommendation(input);
    if (draft) out.push(draft);
  }
  return out;
}
