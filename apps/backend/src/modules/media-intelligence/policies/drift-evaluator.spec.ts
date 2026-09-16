import type { LifecycleDrift, ResolvedDesiredState } from '@ultratorrent/shared';

import { evaluateDrift, hasDrift } from './drift-evaluator';
import type { DriftFacts } from './drift-evaluator';

/**
 * Desired state vs actual state.
 *
 * Half of these cases exist to prove a NEGATIVE: that an unknown fact never
 * becomes drift, and never becomes compliance either. Those are the two ways
 * this layer could lie — one sends an operator chasing a problem that may not
 * exist, the other reports a library as healthy because nothing could be
 * measured — and once Phase 6 can act on drift, the first one authorises
 * downloads to fix nothing.
 */

const SOURCE = { policyId: 'p1', policyName: 'Global', scopeType: 'global' as const };

/** A resolved desired state with only the dimensions a test cares about set. */
const desire = (over: Partial<Record<'quality' | 'completeness' | 'subtitleLanguages', unknown>> = {}): ResolvedDesiredState => ({
  entityType: 'series',
  entityId: 'show-1',
  quality: { value: (over.quality ?? null) as never, source: over.quality ? SOURCE : null, inherited: false, overridden: [] },
  completeness: { value: (over.completeness ?? null) as never, source: over.completeness ? SOURCE : null, inherited: false, overridden: [] },
  subtitleLanguages: { value: (over.subtitleLanguages ?? null) as never, source: over.subtitleLanguages ? SOURCE : null, inherited: false, overridden: [] },
  acquisition: { value: null, source: null, inherited: false, overridden: [] },
  mode: 'recommend_only',
  applicablePolicies: [],
  conflicts: [],
  evaluatedAt: '2026-09-16T12:00:00.000Z',
});

const qualityFacts = (status: string, unknownReason: string | null = null): DriftFacts => ({
  quality: {
    owned: null,
    ladder: { source: 'global_ladder', sourceLabel: 'Global', rungs: [] },
    compliance: {
      status: status as never,
      matchedRung: status === 'preferred' ? 0 : status === 'acceptable' ? 2 : null,
      matchedRungName: null,
      preferredRung: 0,
      totalRungs: 4,
      upgradePotential: status === 'acceptable',
      dimensions: [],
      reasons: [],
      unknownReason: unknownReason as never,
      preferenceSource: 'global_ladder',
      preferenceSourceLabel: 'Global',
    },
    aggregate: null,
    measuredFileCount: 3,
    totalFileCount: 3,
  } as never,
});

const pick = (drifts: LifecycleDrift[], dimension: string) =>
  drifts.find((d) => d.dimension === dimension)!;

describe('drift — quality', () => {
  it('preferred file under maintain_preferred is compliant', () => {
    const d = pick(evaluateDrift(desire({ quality: 'maintain_preferred' }), qualityFacts('preferred')), 'quality');
    expect(d.status).toBe('compliant');
  });

  it('acceptable fallback under maintain_preferred is drift', () => {
    const d = pick(evaluateDrift(desire({ quality: 'maintain_preferred' }), qualityFacts('acceptable')), 'quality');
    expect(d.status).toBe('drift');
    expect(d.desired).toBe('maintain_preferred');
    expect(d.actual).toBe('acceptable');
    // Cites the policy that asked for it — a verdict that cannot name its
    // source is not explainable.
    expect(d.source?.policyId).toBe('p1');
  });

  it('acceptable fallback under maintain_acceptable is compliant', () => {
    const d = pick(evaluateDrift(desire({ quality: 'maintain_acceptable' }), qualityFacts('acceptable')), 'quality');
    expect(d.status).toBe('compliant');
  });

  it('below every rung is drift under either intent', () => {
    for (const intent of ['maintain_preferred', 'maintain_acceptable']) {
      const d = pick(evaluateDrift(desire({ quality: intent }), qualityFacts('below_preference')), 'quality');
      expect(d.status).toBe('drift');
    }
  });

  it('unmeasured quality is UNKNOWN, never drift', () => {
    const d = pick(
      evaluateDrift(desire({ quality: 'maintain_preferred' }), qualityFacts('unknown', 'no_measured_quality')),
      'quality',
    );
    expect(d.status).toBe('unknown');
    expect(d.unknownReason).toBe('quality_not_measured');
  });

  it('no configured ladder is UNKNOWN, and says so distinctly', () => {
    // "You have configured nothing" and "nothing could be measured" demand
    // different responses, so they must not collapse into one reason.
    const d = pick(
      evaluateDrift(desire({ quality: 'maintain_preferred' }), qualityFacts('unknown', 'no_acquisition_preferences')),
      'quality',
    );
    expect(d.status).toBe('unknown');
    expect(d.unknownReason).toBe('no_acquisition_ladder');
  });

  it('is not_applicable when no policy governs quality', () => {
    expect(pick(evaluateDrift(desire(), qualityFacts('below_preference')), 'quality').status).toBe('not_applicable');
  });

  it('is not_applicable under do_not_manage, even when the file is bad', () => {
    const d = pick(evaluateDrift(desire({ quality: 'do_not_manage' }), qualityFacts('below_preference')), 'quality');
    expect(d.status).toBe('not_applicable');
  });

  it('is unknown — not compliant — when the facts carry no quality at all', () => {
    const d = pick(evaluateDrift(desire({ quality: 'maintain_preferred' }), {}), 'quality');
    expect(d.status).toBe('unknown');
  });
});

describe('drift — completeness', () => {
  const completeness = (over: Record<string, unknown>): DriftFacts => ({
    completeness: {
      status: 'known', source: 'media_acquisition', observedAt: null,
      expected: 10, owned: 10, missing: 0, unaired: 0, ignored: 0,
      excludedFromScope: null, completionPercent: 100, showStatus: 'ended',
      ...over,
    } as never,
  });

  it('every aired episode present is compliant', () => {
    const d = pick(evaluateDrift(desire({ completeness: 'maintain_aired' }), completeness({})), 'completeness');
    expect(d.status).toBe('compliant');
  });

  it('a missing aired episode is drift', () => {
    const d = pick(
      evaluateDrift(desire({ completeness: 'maintain_aired' }), completeness({ missing: 3, owned: 7 })),
      'completeness',
    );
    expect(d.status).toBe('drift');
    expect(d.actual).toBe(3);
  });

  it('unaired and ignored episodes are not drift', () => {
    // Missing Episodes already excludes them from `missing`; this pins that
    // this layer does not re-derive the classification and get it wrong.
    const d = pick(
      evaluateDrift(desire({ completeness: 'maintain_aired' }), completeness({ missing: 0, unaired: 4, ignored: 2 })),
      'completeness',
    );
    expect(d.status).toBe('compliant');
  });

  it('carries the out-of-scope count as evidence', () => {
    /*
     * The assembler hardcodes this to null today, so it reads as "not known".
     * It is surfaced rather than ignored because `missing` can otherwise
     * include episodes a `monitor_new_only` operator explicitly declined —
     * and a policy acting on that count would propose acquiring them.
     */
    const d = pick(
      evaluateDrift(desire({ completeness: 'maintain_aired' }), completeness({ missing: 5, excludedFromScope: 5 })),
      'completeness',
    );
    expect(d.evidence.excludedFromScope).toBe(5);
  });

  it('an unmonitored show is UNKNOWN, never compliant', () => {
    const d = pick(
      evaluateDrift(desire({ completeness: 'maintain_aired' }), completeness({ status: 'unknown', missing: null })),
      'completeness',
    );
    expect(d.status).toBe('unknown');
    expect(d.unknownReason).toBe('completeness_not_monitored');
  });

  it('a movie, which has no episode semantics, is not reported as drift', () => {
    const d = pick(evaluateDrift(desire({ completeness: 'maintain_aired' }), {}), 'completeness');
    expect(d.status).toBe('unknown');
  });
});

describe('drift — subtitles', () => {
  const subs = (languages: string[], over: Record<string, unknown> = {}): DriftFacts => ({
    subtitles: {
      status: 'known', source: 'media_manager', observedAt: null,
      languages, itemsWithSubtitles: 1, itemsTotal: 1,
      embeddedTracksKnown: false,
      ...over,
    } as never,
  });

  it('every required language present is compliant — that much is provable', () => {
    const d = pick(
      evaluateDrift(desire({ subtitleLanguages: ['english'] }), subs(['english', 'spanish'])),
      'subtitleLanguages',
    );
    expect(d.status).toBe('compliant');
  });

  it('a required language with no record is UNKNOWN, not drift', () => {
    /*
     * The heart of this dimension. Nothing records whether a subtitle scan
     * ever ran, and embedded tracks are unmodelled — so "no row for Spanish"
     * is not evidence that Spanish is absent from the media.
     */
    const d = pick(
      evaluateDrift(desire({ subtitleLanguages: ['english', 'spanish'] }), subs(['english'])),
      'subtitleLanguages',
    );
    expect(d.status).toBe('unknown');
    expect(d.unknownReason).toBe('subtitle_scan_state_unknown');
    expect(d.evidence.absentLanguages).toEqual(['spanish']);
  });

  it('becomes real drift the day embedded tracks are modelled', () => {
    // Forward-compatible by construction: no change needed here when the
    // source domain can finally prove absence.
    const d = pick(
      evaluateDrift(
        desire({ subtitleLanguages: ['english', 'spanish'] }),
        subs(['english'], { embeddedTracksKnown: true }),
      ),
      'subtitleLanguages',
    );
    expect(d.status).toBe('drift');
  });

  it('an unknown subtitle section is unknown', () => {
    const d = pick(
      evaluateDrift(desire({ subtitleLanguages: ['english'] }), subs([], { status: 'unknown' })),
      'subtitleLanguages',
    );
    expect(d.status).toBe('unknown');
  });

  it('an explicitly empty requirement is not_applicable, not compliant', () => {
    const d = pick(evaluateDrift(desire({ subtitleLanguages: [] }), subs([])), 'subtitleLanguages');
    expect(d.status).toBe('not_applicable');
  });

  it('no subtitle policy is not_applicable', () => {
    expect(pick(evaluateDrift(desire(), subs([])), 'subtitleLanguages').status).toBe('not_applicable');
  });
});

describe('drift — overall', () => {
  it('evaluates every dimension, always, so a caller never has to guard', () => {
    const drifts = evaluateDrift(desire(), {});
    expect(drifts.map((d) => d.dimension)).toEqual(['quality', 'completeness', 'subtitleLanguages']);
  });

  it('reports drift only when something actually differs', () => {
    expect(hasDrift(evaluateDrift(desire(), {}))).toBe(false);
    expect(
      hasDrift(evaluateDrift(desire({ quality: 'maintain_preferred' }), qualityFacts('below_preference'))),
    ).toBe(true);
  });

  it('never counts an unknown as drift', () => {
    // The single most important property in this file.
    const drifts = evaluateDrift(
      desire({ quality: 'maintain_preferred', subtitleLanguages: ['spanish'] }),
      { ...qualityFacts('unknown', 'no_measured_quality') },
    );
    expect(drifts.every((d) => d.status !== 'drift')).toBe(true);
    expect(hasDrift(drifts)).toBe(false);
  });

  it('is deterministic — identical input yields byte-identical output', () => {
    const d = desire({ quality: 'maintain_preferred' });
    const f = qualityFacts('acceptable');
    expect(JSON.stringify(evaluateDrift(d, f))).toBe(JSON.stringify(evaluateDrift(d, f)));
  });
});
