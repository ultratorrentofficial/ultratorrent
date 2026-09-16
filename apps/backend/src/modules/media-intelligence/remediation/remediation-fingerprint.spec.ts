import {
  desiredStateFingerprint,
  fingerprintDrift,
  recommendationFingerprint,
  verificationFingerprint,
  type DesiredStateFingerprintInput,
  type RecommendationFingerprintInput,
  type VerificationFingerprintInput,
} from './remediation-fingerprint';

/**
 * What "the world has not changed" means for a plan.
 *
 * The claims worth pinning are the two failure directions. Hash too much and
 * every plan supersedes on the next sweep, which is indistinguishable from
 * the feature not working. Hash too little and an approval executes something
 * the operator never saw.
 */

const desired = (over: Partial<DesiredStateFingerprintInput> = {}): DesiredStateFingerprintInput => ({
  entityType: 'series',
  entityId: 'show-1',
  quality: 'maintain_preferred',
  completeness: 'maintain_aired',
  subtitleLanguages: ['en', 'es'],
  mode: 'approval_required',
  sourcePolicyIds: ['pol-1'],
  conflictedDimensions: [],
  ...over,
});

const rec = (over: Partial<RecommendationFingerprintInput> = {}): RecommendationFingerprintInput => ({
  recommendationId: 'r1',
  type: 'REFRESH_METADATA',
  status: 'active',
  confidence: 'high',
  capabilityId: 'media.metadata.refresh',
  evidence: { missing: 3 },
  ...over,
});

const ver = (over: Partial<VerificationFingerprintInput> = {}): VerificationFingerprintInput => ({
  releaseName: 'Show.S01E01.1080p.WEB-DL.x265',
  indexerName: 'Example',
  sizeBytes: 1_000_000,
  matchedRung: 0,
  verifiedAt: '2026-09-16T00:00:00.000Z',
  ...over,
});

describe('desired-state fingerprint', () => {
  it('is stable across identical input', () => {
    expect(desiredStateFingerprint(desired())).toBe(desiredStateFingerprint(desired()));
  });

  it('ignores the order a policy happened to list languages in', () => {
    // Requiring en+es and es+en is the same requirement; superseding a plan
    // over the ordering would be churn with no meaning.
    expect(desiredStateFingerprint(desired({ subtitleLanguages: ['es', 'en'] }))).toBe(
      desiredStateFingerprint(desired({ subtitleLanguages: ['en', 'es'] })),
    );
  });

  it('distinguishes "says nothing" from "explicitly none"', () => {
    // The whole three-valued contract: null inherits, [] is a decision.
    expect(desiredStateFingerprint(desired({ subtitleLanguages: null }))).not.toBe(
      desiredStateFingerprint(desired({ subtitleLanguages: [] })),
    );
  });

  it('changes when the governing intent changes', () => {
    expect(desiredStateFingerprint(desired({ quality: 'maintain_acceptable' }))).not.toBe(
      desiredStateFingerprint(desired()),
    );
  });

  it('changes when a different policy starts supplying the intent', () => {
    // Same values, different author. An override taking effect is a material
    // change even when the resolved value is identical.
    expect(desiredStateFingerprint(desired({ sourcePolicyIds: ['pol-2'] }))).not.toBe(
      desiredStateFingerprint(desired()),
    );
  });

  it('changes when a dimension becomes conflicted', () => {
    // Determinism is not consent: a newly-conflicted dimension must not keep
    // an old approval alive.
    expect(desiredStateFingerprint(desired({ conflictedDimensions: ['quality'] }))).not.toBe(
      desiredStateFingerprint(desired()),
    );
  });

  it('is unaffected by anything not hashed — no timestamp leaks in', () => {
    // Computed twice at different instants, same result. A clock-sensitive
    // fingerprint would supersede every plan on every sweep.
    const a = desiredStateFingerprint(desired());
    const b = desiredStateFingerprint(desired());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('recommendation fingerprint', () => {
  it('changes when the evidence moves', () => {
    // Phase 4 already treats changed evidence as invalidating a verification.
    expect(recommendationFingerprint(rec({ evidence: { missing: 4 } }))).not.toBe(
      recommendationFingerprint(rec()),
    );
  });

  it('is insensitive to the key order of the evidence object', () => {
    const a = recommendationFingerprint(rec({ evidence: { a: 1, b: 2 } }));
    const b = recommendationFingerprint(rec({ evidence: { b: 2, a: 1 } }));
    expect(a).toBe(b);
  });

  it('changes when the capability it would invoke changes', () => {
    // A recommendation that now routes somewhere else is a different plan.
    expect(recommendationFingerprint(rec({ capabilityId: null }))).not.toBe(
      recommendationFingerprint(rec()),
    );
  });

  it('distinguishes an absent value from a null one', () => {
    const withUndefined = recommendationFingerprint(rec({ evidence: { x: undefined } }));
    const withNull = recommendationFingerprint(rec({ evidence: { x: null } }));
    expect(withUndefined).not.toBe(withNull);
  });
});

describe('verification fingerprint', () => {
  it('changes when the candidate is re-verified, even for the same release', () => {
    /*
     * The deliberate exception: `verifiedAt` IS hashed here. A twelve-hour-old
     * check must not pass as current, and freshness is the property this
     * fingerprint exists to protect.
     */
    expect(verificationFingerprint(ver({ verifiedAt: '2026-09-16T06:00:00.000Z' }))).not.toBe(
      verificationFingerprint(ver()),
    );
  });

  it('changes when a different release would be grabbed', () => {
    expect(verificationFingerprint(ver({ releaseName: 'Other.Release' }))).not.toBe(
      verificationFingerprint(ver()),
    );
  });

  it('changes when the candidate stops satisfying the same rung', () => {
    expect(verificationFingerprint(ver({ matchedRung: 2 }))).not.toBe(verificationFingerprint(ver()));
  });
});

describe('drift reporting', () => {
  it('names which input moved, not merely that something did', () => {
    const drift = fingerprintDrift(
      { desiredState: 'a', recommendation: 'b', verification: 'c' },
      { desiredState: 'a', recommendation: 'CHANGED', verification: 'c' },
    );
    expect(drift).toEqual(['recommendation']);
  });

  it('reports every input that moved', () => {
    const drift = fingerprintDrift(
      { desiredState: 'a', recommendation: 'b', verification: 'c' },
      { desiredState: 'X', recommendation: 'Y', verification: 'Z' },
    );
    expect(drift).toEqual(['desired_state', 'recommendation', 'verification']);
  });

  it('ignores an input the plan never pinned', () => {
    // A plan with no candidate must not be superseded by a verification field
    // it never depended on.
    const drift = fingerprintDrift(
      { desiredState: 'a', verification: null },
      { desiredState: 'a', verification: 'now-there-is-one' },
    );
    expect(drift).toEqual([]);
  });

  it('reports nothing when the world held still', () => {
    const pinned = { desiredState: 'a', recommendation: 'b', verification: 'c' };
    expect(fingerprintDrift(pinned, pinned)).toEqual([]);
  });
});
