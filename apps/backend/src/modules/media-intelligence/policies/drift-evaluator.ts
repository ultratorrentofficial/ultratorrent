import type {
  LifecycleDrift,
  LifecycleDriftStatus,
  LifecycleUnknownReason,
  MediaCompletenessFacts,
  MediaQualityFacts,
  MediaSubtitleFacts,
  ResolvedDesiredState,
} from '@ultratorrent/shared';

/**
 * Desired state vs actual state.
 *
 * Pure, like its siblings. It is handed a resolved desired state (from
 * `policy-precedence.ts`) and the facts the assembler already gathered, and it
 * answers one question per dimension: does what the operator asked for match
 * what is actually true?
 *
 * **Four outcomes, and the last two carry as much weight as the first two.**
 * `compliant`, `drift`, `not_applicable` (no policy governs this), and
 * `unknown` (a policy governs it but the facts cannot settle it). Library
 * Cleanup established this in the codebase with its third `unmeasured`
 * outcome, and the rule it stated applies verbatim here: an unmeasured fact
 * must never be silently read as "this does not qualify".
 *
 * Two failure modes this file exists to prevent:
 *
 *   - **UNKNOWN becoming DRIFT.** An unprobed file is unmeasured, not wrong.
 *     Reporting drift would send an operator chasing a problem that may not
 *     exist, and — once Phase 6 can act — would authorise a download to fix
 *     nothing.
 *   - **UNKNOWN becoming COMPLIANT.** Equally bad in the other direction: a
 *     dashboard that reports a library as healthy because it could not look.
 */

/** The facts this evaluator is allowed to see. A narrow, deliberate slice. */
export interface DriftFacts {
  quality?: MediaQualityFacts;
  completeness?: MediaCompletenessFacts;
  subtitles?: MediaSubtitleFacts;
}

function drift(
  dimension: string,
  status: LifecycleDriftStatus,
  desired: unknown,
  actual: unknown,
  source: LifecycleDrift['source'],
  evidence: Record<string, unknown> = {},
  unknownReason: LifecycleUnknownReason | null = null,
): LifecycleDrift {
  return { dimension, status, desired, actual, unknownReason, source, evidence };
}

/**
 * Quality.
 *
 * Reuses Phase 2's verdict wholesale — `preferred | acceptable |
 * below_preference | unknown` against the operator's OWN acquisition ladder.
 * There is no second ladder here and there must never be one: a policy names
 * a position in the existing ladder, it does not describe quality itself.
 */
function evaluateQuality(desired: ResolvedDesiredState, facts: DriftFacts): LifecycleDrift {
  const intent = desired.quality.value;
  const source = desired.quality.source;

  if (intent == null || intent === 'do_not_manage') {
    return drift('quality', 'not_applicable', intent, null, source);
  }

  const compliance = facts.quality?.compliance;
  if (!compliance) {
    return drift('quality', 'unknown', intent, null, source, {}, 'quality_not_measured');
  }

  const evidence = {
    matchedRung: compliance.matchedRung,
    matchedRungName: compliance.matchedRungName,
    preferredRung: compliance.preferredRung,
    totalRungs: compliance.totalRungs,
    preferenceSource: compliance.preferenceSource,
  };

  if (compliance.status === 'unknown') {
    /*
     * Two very different unknowns, kept apart because they demand different
     * responses: "you have configured nothing for this kind of media" is a
     * gap in intent, while "nothing about this file was measured" is a gap in
     * facts. Collapsing them would tell an operator to fix the wrong thing.
     */
    const reason: LifecycleUnknownReason =
      compliance.unknownReason === 'no_acquisition_preferences'
        ? 'no_acquisition_ladder'
        : 'quality_not_measured';
    return drift('quality', 'unknown', intent, null, source, evidence, reason);
  }

  // Satisfying no rung at all fails either intent.
  if (compliance.status === 'below_preference') {
    return drift('quality', 'drift', intent, compliance.status, source, evidence);
  }

  // `maintain_acceptable` is satisfied by any rung the ladder accepts — the
  // operator configured those fallbacks themselves.
  if (intent === 'maintain_acceptable') {
    return drift('quality', 'compliant', intent, compliance.status, source, evidence);
  }

  // `maintain_preferred`: only rung 0 will do.
  return compliance.status === 'preferred'
    ? drift('quality', 'compliant', intent, compliance.status, source, evidence)
    : drift('quality', 'drift', intent, compliance.status, source, evidence);
}

/**
 * Completeness.
 *
 * Reuses Missing Episodes' classification wholesale. Aired / unaired /
 * ignored / out-of-scope are the acquisition domain's answers and there must
 * not be a second detector here.
 *
 * **On `excludedFromScope`:** the fact is declared but the assembler
 * currently hardcodes it to `null`, so a `monitor_new_only` series — where
 * every already-aired episode is deliberately out of scope — can inflate
 * `missing` with episodes the operator explicitly declined. That is latent
 * today (this installation has no such series and zero out-of-scope rows),
 * but a policy acting on an inflated count would propose acquiring media
 * nobody asked for. So the count is reported as evidence and the field is
 * read when present, which makes this correct the moment the assembler fills
 * it in — no rewrite required.
 */
function evaluateCompleteness(desired: ResolvedDesiredState, facts: DriftFacts): LifecycleDrift {
  const intent = desired.completeness.value;
  const source = desired.completeness.source;

  if (intent == null || intent === 'do_not_manage') {
    return drift('completeness', 'not_applicable', intent, null, source);
  }

  const c = facts.completeness;
  // Movies report `not_applicable` here rather than a count; episode
  // semantics for a film is exactly the TV-shaped thinking to avoid.
  if (!c || c.status === 'unknown') {
    return drift(
      'completeness',
      'unknown',
      intent,
      null,
      source,
      {},
      'completeness_not_monitored',
    );
  }
  if (c.missing == null) {
    return drift('completeness', 'unknown', intent, null, source, {}, 'completeness_not_monitored');
  }

  const outOfScope = c.excludedFromScope ?? null;
  const evidence = {
    missing: c.missing,
    owned: c.owned,
    unaired: c.unaired,
    ignored: c.ignored,
    // Carried so the operator can see whether the count they are being shown
    // has been narrowed to what they actually asked for.
    excludedFromScope: outOfScope,
  };

  return c.missing > 0
    ? drift('completeness', 'drift', intent, c.missing, source, evidence)
    : drift('completeness', 'compliant', intent, 0, source, evidence);
}

/**
 * Subtitles — and the honest limit of what this codebase can prove.
 *
 * Presence is knowable: sidecar rows and Subtitle Intelligence downloads are
 * real records. ABSENCE is not. Nothing anywhere records whether a subtitle
 * scan ever ran for an entity (there is no `lastSubtitleScanAt` on any
 * model), the sweep is off by default and skips unmatched items, and
 * embedded/in-container tracks are not modelled at all — `embeddedTracksKnown`
 * is hardcoded `false` today.
 *
 * So:
 *
 *   - every required language present  → **compliant**, provable
 *   - a required language not present  → **unknown**, not drift
 *
 * The second is the important one. Claiming drift would assert that a track
 * is missing when the only honest statement is "no record of it exists". The
 * check branches on `embeddedTracksKnown`, so the day tracks are modelled
 * this dimension starts reporting real drift with no change here.
 */
function evaluateSubtitles(desired: ResolvedDesiredState, facts: DriftFacts): LifecycleDrift {
  const required = desired.subtitleLanguages.value;
  const source = desired.subtitleLanguages.source;

  // Null is silence; an empty list is an explicit "no requirement", and both
  // mean there is nothing to check.
  if (required == null || required.length === 0) {
    return drift('subtitleLanguages', 'not_applicable', required, null, source);
  }

  const s = facts.subtitles;
  if (!s || s.status === 'unknown') {
    return drift('subtitleLanguages', 'unknown', required, null, source, {}, 'subtitle_scan_state_unknown');
  }

  const present = new Set(s.languages);
  const absent = required.filter((l) => !present.has(l));
  const evidence = {
    requiredLanguages: required,
    presentLanguages: s.languages,
    absentLanguages: absent,
    embeddedTracksKnown: s.embeddedTracksKnown,
  };

  if (absent.length === 0) {
    return drift('subtitleLanguages', 'compliant', required, s.languages, source, evidence);
  }

  return s.embeddedTracksKnown
    ? drift('subtitleLanguages', 'drift', required, s.languages, source, evidence)
    : drift(
        'subtitleLanguages',
        'unknown',
        required,
        s.languages,
        source,
        evidence,
        'subtitle_scan_state_unknown',
      );
}

/**
 * Evaluate every dimension for one entity.
 *
 * Deterministic and stable in order, so two runs over identical inputs
 * produce byte-identical output and a projection store can tell "nothing
 * changed" from "something moved".
 */
export function evaluateDrift(
  desired: ResolvedDesiredState,
  facts: DriftFacts,
): LifecycleDrift[] {
  return [
    evaluateQuality(desired, facts),
    evaluateCompleteness(desired, facts),
    evaluateSubtitles(desired, facts),
  ];
}

/** Does anything actually differ? Used for list filtering and counts. */
export function hasDrift(drifts: readonly LifecycleDrift[]): boolean {
  return drifts.some((d) => d.status === 'drift');
}
