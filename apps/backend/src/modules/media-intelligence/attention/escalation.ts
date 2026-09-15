import type {
  MediaAttentionDisposition,
  MediaEscalationReason,
  MediaEscalationResult,
} from '@ultratorrent/shared';

/**
 * Does a person's disposition survive a change in the finding beneath it?
 *
 * Pure and deterministic. The Attention Center silences things on an
 * operator's instruction, and the single most dangerous failure mode of such a
 * feature is silencing something that later got much worse. The opposite
 * failure — resurrecting a dismissed finding because a sweep refreshed a
 * timestamp — is merely annoying, but it trains people to stop trusting the
 * queue, which ends in the same place.
 *
 * So the rule is narrow and explicit: a disposition is cleared only when the
 * condition demonstrably worsened, never because it was merely re-observed.
 */

/** Worst-last ordering, matching the evaluator's own severity ranking. */
const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  opportunity: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

/**
 * How much an affected count must grow before it counts as escalation.
 *
 * A doubling, and at least two more than before. One extra missing episode is
 * the same problem; twelve instead of one is a different problem wearing the
 * same name. The absolute floor stops 1→2 from tripping the ratio, which
 * would make every drip-feed of a currently-airing series re-nag the operator
 * every week.
 */
const COUNT_GROWTH_RATIO = 2;
const COUNT_GROWTH_FLOOR = 2;

/**
 * Evidence keys that represent "how much is wrong".
 *
 * Deliberately a list rather than a heuristic over every numeric field:
 * `totalRungs` and `measuredFileCount` are also numbers and also change, and
 * neither means the situation deteriorated. Only counts of *affected things*
 * belong here. Unknown finding codes simply fall through to the severity and
 * fingerprint rules, which is the safe default.
 */
const AFFECTED_COUNT_KEYS = [
  'missing',
  'missingCount',
  'affectedCount',
  'failed',
  'quarantined',
  'erroredCount',
  'unprobedFiles',
  'duplicateCount',
] as const;

export interface EscalationInput {
  previous: {
    severity: string;
    evidence: Record<string, unknown>;
    resolvedAt: Date | string | null;
  };
  current: {
    severity: string;
    evidence: Record<string, unknown>;
  };
  disposition: MediaAttentionDisposition;
}

export interface EscalationOutcome {
  result: MediaEscalationResult;
  reason: MediaEscalationReason | null;
}

const keep: EscalationOutcome = { result: 'keep_disposition', reason: null };
const reset = (reason: MediaEscalationReason): EscalationOutcome => ({
  result: 'reset_to_unreviewed',
  reason,
});

/** The largest affected-count this evidence reports, or null if it reports none. */
function affectedCount(evidence: Record<string, unknown>): number | null {
  let max: number | null = null;
  for (const key of AFFECTED_COUNT_KEYS) {
    const v = evidence[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      max = max == null ? v : Math.max(max, v);
    }
  }
  return max;
}

/**
 * A stable fingerprint of what the finding is saying.
 *
 * Volatile fields are excluded: a timestamp moving, or a file being
 * re-measured to the same value, is not new information. Keys are sorted so
 * the fingerprint does not depend on property order, and nested values are
 * serialized rather than walked — evidence is bounded by contract, so this
 * stays cheap.
 */
const VOLATILE_KEYS = new Set([
  // Timestamps: a re-observation is not new information.
  'observedAt',
  'lastObservedAt',
  'calculatedAt',
  'assembledAt',
  /*
   * Context, not the problem. `measuredFileCount` is a denominator — probing
   * more files changes it without the situation deteriorating — and
   * `totalRungs` describes the ladder's size rather than this title's fault.
   * Treating either as material would clear a dismissal every time the probe
   * backfill made progress, which is precisely the nagging that teaches
   * operators to stop trusting the queue.
   */
  'measuredFileCount',
  'totalRungs',
]);

export function evidenceFingerprint(evidence: Record<string, unknown>): string {
  const entries = Object.entries(evidence ?? {})
    .filter(([k]) => !VOLATILE_KEYS.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${JSON.stringify(v ?? null)}`);
  return entries.join('|');
}

/**
 * Decide whether to keep or clear the disposition.
 *
 * Order matters: reopening and severity are checked before the count and the
 * fingerprint, because they are the unambiguous signals. The fingerprint is
 * the last resort and the weakest — it fires on any substantive evidence
 * change, which is correct for codes whose evidence this module does not
 * otherwise understand.
 */
export function evaluateDispositionRetention(input: EscalationInput): EscalationOutcome {
  const { previous, current, disposition } = input;

  // Nothing to preserve. An unreviewed finding cannot be "reset".
  if (disposition === 'unreviewed') return keep;

  /*
   * A finding that genuinely went away and came back is a NEW occurrence of
   * the problem, whatever was decided about the old one. Six months of
   * silence followed by a recurrence deserves a fresh look — the operator
   * dismissed a situation that no longer exists.
   */
  if (previous.resolvedAt != null) return reset('reopened_after_resolution');

  const before = SEVERITY_RANK[previous.severity] ?? -1;
  const after = SEVERITY_RANK[current.severity] ?? -1;
  if (after > before) return reset('severity_increased');

  /*
   * Severity going DOWN keeps the disposition. The operator already decided
   * about a worse version of this; a milder one needs no new decision.
   */
  if (after < before) return keep;

  const prevCount = affectedCount(previous.evidence);
  const currCount = affectedCount(current.evidence);
  if (prevCount != null && currCount != null && currCount !== prevCount) {
    /*
     * Fewer affected items than when they decided. The problem shrank, so
     * there is nothing new to ask about — and note this must short-circuit
     * before the fingerprint check below, or an improvement would clear the
     * disposition purely because a number moved.
     */
    if (currCount < prevCount) return keep;

    const grew = currCount >= prevCount * COUNT_GROWTH_RATIO && currCount - prevCount >= COUNT_GROWTH_FLOOR;
    if (grew) return reset('affected_count_increased');
    // A small increase is the same problem, slightly larger. Stay silent.
    return keep;
  }

  /*
   * Fingerprint last. It catches evidence changes this module has no specific
   * rule for, but it must not fire on a re-observation that changed nothing —
   * which is exactly what excluding the volatile keys guarantees.
   */
  if (evidenceFingerprint(previous.evidence) !== evidenceFingerprint(current.evidence)) {
    return reset('evidence_changed');
  }

  return keep;
}

/**
 * Is this finding currently in the active attention queue?
 *
 * ONE definition, exported so the list and the counters cannot drift apart.
 * The product has already been bitten by a dashboard and its list disagreeing
 * because each computed the condition independently.
 */
export function isActiveAttention(
  finding: { resolvedAt: Date | string | null; disposition: string; snoozedUntil: Date | string | null },
  now: Date,
): boolean {
  if (finding.resolvedAt != null) return false;
  if (finding.disposition === 'dismissed') return false;
  if (finding.disposition === 'snoozed') {
    // No scheduler flips this row: an elapsed timer is simply read as elapsed.
    // A background job that existed only to write `snoozed → unreviewed` at
    // the stroke of the hour would be churn with a race attached.
    if (finding.snoozedUntil == null) return false;
    return new Date(finding.snoozedUntil).getTime() <= now.getTime();
  }
  return true;
}
