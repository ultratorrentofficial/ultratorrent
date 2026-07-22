import type { PolicyExclusions } from './policy-document';

/**
 * Mandatory exclusions.
 *
 * These are enforced server-side regardless of what a policy document asks for and
 * regardless of what the UI displayed. A policy match makes something a CANDIDATE;
 * these rules decide whether it may ever become an action.
 *
 * Order matters only for which reason gets reported — a file can be excluded for
 * several reasons at once, and the most important one should be the one shown.
 * Protection and legal hold come first because they are absolute; "unmeasured"
 * comes late because it is the least alarming to an operator reading a report.
 */

export type ExclusionReason =
  | 'protected'
  | 'legal_hold'
  | 'locked'
  | 'outside_roots'
  | 'system_path'
  | 'library_root'
  | 'active_playback'
  | 'incomplete_download'
  | 'in_flight_operation'
  | 'active_job'
  | 'pending_duplicate_resolution'
  | 'within_grace_period'
  | 'ambiguous_identity'
  | 'unmeasured_technical'
  | 'stale_playback_data'
  | 'substantial_progress'
  | 'last_surviving_copy'
  | 'replacement_required'
  | 'file_missing';

/** Maps an exclusion to the candidate status it produces. */
export const EXCLUSION_STATUS: Record<ExclusionReason, string> = {
  protected: 'excluded_protected',
  legal_hold: 'excluded_protected',
  locked: 'excluded_locked',
  outside_roots: 'excluded_protected',
  system_path: 'excluded_protected',
  library_root: 'excluded_protected',
  active_playback: 'excluded_active',
  incomplete_download: 'excluded_active',
  in_flight_operation: 'excluded_active',
  active_job: 'excluded_active',
  pending_duplicate_resolution: 'excluded_active',
  within_grace_period: 'excluded_recent',
  ambiguous_identity: 'excluded_ambiguous',
  unmeasured_technical: 'excluded_unmeasured',
  stale_playback_data: 'excluded_unmeasured',
  substantial_progress: 'excluded_active',
  last_surviving_copy: 'excluded_protected',
  replacement_required: 'excluded_protected',
  file_missing: 'skipped_changed',
};

/** Everything the exclusion pass needs to know about a candidate. */
export interface ExclusionFacts {
  isProtected: boolean;
  hasLegalHold: boolean;
  isLocked: boolean;
  withinHardRoots: boolean;
  isSystemPath: boolean;
  isLibraryRoot: boolean;
  fileExists: boolean;
  activePlayback: boolean;
  incompleteDownload: boolean;
  /** A move/rename/copy/scan/probe currently touching this file. */
  inFlightOperation: boolean;
  hasActiveJob: boolean;
  pendingDuplicateResolution: boolean;
  addedAt: Date | null;
  ambiguousIdentity: boolean;
  /** True when every measured-only condition the policy uses had probe data. */
  technicalMeasured: boolean;
  policyUsesMeasuredConditions: boolean;
  /** False when the playback aggregate could not be vouched for. */
  playbackTrustworthy: boolean;
  policyUsesPlaybackConditions: boolean;
  playbackComputedAt: Date | null;
  maximumProgressPercent: number | null;
  /** Would removing this leave no copy of the media? */
  isLastSurvivingCopy: boolean;
  /** Policy demands a verified replacement; this is whether one was found. */
  hasVerifiedReplacement: boolean;
}

export interface ExclusionVerdict {
  excluded: boolean;
  reason?: ExclusionReason;
  status?: string;
  /** Every reason that applied, for the report. */
  allReasons: ExclusionReason[];
}

export interface ExclusionOptions {
  /**
   * Required, so a caller cannot forget it. It still arrives from a Prisma `Json`
   * column at runtime, where the type is a claim rather than a guarantee — hence
   * the defensive default below.
   */
  exclusions: PolicyExclusions;
  replacementRequired: boolean;
  now?: Date;
}

/**
 * What a document with no usable exclusions block is read as. Every operator-tunable
 * safety margin is set to its STRICTEST value, not its loosest: a policy whose
 * exclusions we cannot read is a policy we do not trust, and the mandatory pass must
 * never be the thing that throws — a crash here aborts the scan mid-page and strands
 * the run, which is a worse outcome than excluding too much.
 */
const STRICTEST_EXCLUSIONS: PolicyExclusions = {
  protected: true,
  locked: true,
  activePlayback: true,
  incompleteDownload: true,
  inFlightOperation: true,
  ambiguousIdentity: true,
  requireMeasuredTechnical: true,
};

export function evaluateExclusions(
  facts: ExclusionFacts,
  opts: ExclusionOptions,
): ExclusionVerdict {
  const now = opts.now ?? new Date();
  const ex = opts.exclusions && typeof opts.exclusions === 'object'
    ? opts.exclusions
    : STRICTEST_EXCLUSIONS;
  const reasons: ExclusionReason[] = [];

  // Absolute, in reporting order.
  if (facts.hasLegalHold) reasons.push('legal_hold');
  if (facts.isProtected) reasons.push('protected');
  if (facts.isLocked) reasons.push('locked');

  // Path safety. These are belt-and-braces: the executor re-checks them through the
  // path services, but a candidate should never even be offered.
  if (!facts.withinHardRoots) reasons.push('outside_roots');
  if (facts.isSystemPath) reasons.push('system_path');
  if (facts.isLibraryRoot) reasons.push('library_root');
  if (!facts.fileExists) reasons.push('file_missing');

  // Busy.
  if (facts.activePlayback) reasons.push('active_playback');
  if (facts.incompleteDownload) reasons.push('incomplete_download');
  if (facts.inFlightOperation) reasons.push('in_flight_operation');
  if (facts.hasActiveJob) reasons.push('active_job');
  if (facts.pendingDuplicateResolution) reasons.push('pending_duplicate_resolution');

  // Grace period — a file added minutes ago has not had the chance to be watched,
  // probed, or corrected.
  const graceDays = ex.addedWithinDays ?? 0;
  if (graceDays > 0) {
    // An unknown added-date fails CLOSED: we cannot show it is old enough.
    if (!facts.addedAt) reasons.push('within_grace_period');
    else if (now.getTime() - facts.addedAt.getTime() < graceDays * 86_400_000) {
      reasons.push('within_grace_period');
    }
  }

  if (ex.ambiguousIdentity !== false && facts.ambiguousIdentity) reasons.push('ambiguous_identity');

  // Measured-data discipline.
  if (facts.policyUsesMeasuredConditions && ex.requireMeasuredTechnical !== false && !facts.technicalMeasured) {
    reasons.push('unmeasured_technical');
  }

  // Playback trust. Absence of data must never read as "never watched".
  if (facts.policyUsesPlaybackConditions) {
    if (!facts.playbackTrustworthy) reasons.push('stale_playback_data');
    else if (ex.maxPlaybackAggregateAgeDays != null) {
      const maxMs = ex.maxPlaybackAggregateAgeDays * 86_400_000;
      if (!facts.playbackComputedAt || now.getTime() - facts.playbackComputedAt.getTime() > maxMs) {
        reasons.push('stale_playback_data');
      }
    }
  }

  // Optional: refuse a near-finish even though it never completed.
  if (ex.excludeIfProgressAbovePercent != null &&
      facts.maximumProgressPercent != null &&
      facts.maximumProgressPercent >= ex.excludeIfProgressAbovePercent) {
    reasons.push('substantial_progress');
  }

  // Never leave zero copies.
  if (facts.isLastSurvivingCopy) reasons.push('last_surviving_copy');
  if (opts.replacementRequired && !facts.hasVerifiedReplacement) reasons.push('replacement_required');

  if (!reasons.length) return { excluded: false, allReasons: [] };
  const reason = reasons[0];
  return { excluded: true, reason, status: EXCLUSION_STATUS[reason], allReasons: reasons };
}
