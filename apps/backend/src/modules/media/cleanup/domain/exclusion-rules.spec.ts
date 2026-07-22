import { evaluateExclusions, type ExclusionFacts, type ExclusionOptions } from './exclusion-rules';
import { candidateFingerprint, fingerprintDiff, type FingerprintInput } from './candidate-fingerprint';

const NOW = new Date('2026-06-01T00:00:00Z');

/** A candidate with nothing wrong with it. */
const clean = (over: Partial<ExclusionFacts> = {}): ExclusionFacts => ({
  isProtected: false, hasLegalHold: false, isLocked: false,
  withinHardRoots: true, isSystemPath: false, isLibraryRoot: false, fileExists: true,
  activePlayback: false, incompleteDownload: false, inFlightOperation: false,
  hasActiveJob: false, pendingDuplicateResolution: false,
  addedAt: new Date('2025-01-01T00:00:00Z'),
  ambiguousIdentity: false,
  technicalMeasured: true, policyUsesMeasuredConditions: true,
  playbackTrustworthy: true, policyUsesPlaybackConditions: true,
  playbackComputedAt: new Date('2026-05-31T00:00:00Z'),
  maximumProgressPercent: 0,
  isLastSurvivingCopy: false, hasVerifiedReplacement: true,
  ...over,
});

const opts = (over: Partial<ExclusionOptions> = {}): ExclusionOptions => ({
  exclusions: {
    protected: true, locked: true, activePlayback: true,
    incompleteDownload: true, inFlightOperation: true,
    addedWithinDays: 90, ambiguousIdentity: true, requireMeasuredTechnical: true,
  },
  replacementRequired: false,
  now: NOW,
  ...over,
});

describe('a clean candidate is not excluded', () => {
  it('passes every gate', () => {
    const v = evaluateExclusions(clean(), opts());
    expect(v.excluded).toBe(false);
    expect(v.allReasons).toEqual([]);
  });
});

describe('absolute exclusions', () => {
  it.each([
    ['protected', { isProtected: true }, 'excluded_protected'],
    ['legal_hold', { hasLegalHold: true }, 'excluded_protected'],
    ['locked', { isLocked: true }, 'excluded_locked'],
    ['outside_roots', { withinHardRoots: false }, 'excluded_protected'],
    ['system_path', { isSystemPath: true }, 'excluded_protected'],
    ['library_root', { isLibraryRoot: true }, 'excluded_protected'],
  ] as const)('excludes on %s', (reason, patch, status) => {
    const v = evaluateExclusions(clean(patch as Partial<ExclusionFacts>), opts());
    expect(v.excluded).toBe(true);
    expect(v.allReasons).toContain(reason);
    expect(v.status).toBe(status);
  });

  // A legal hold must be the reported reason even alongside ordinary protection,
  // because it is the one an operator cannot lift.
  it('reports legal hold ahead of ordinary protection', () => {
    const v = evaluateExclusions(clean({ isProtected: true, hasLegalHold: true }), opts());
    expect(v.reason).toBe('legal_hold');
  });
});

describe('busy files are never touched', () => {
  it.each([
    ['active_playback', { activePlayback: true }],
    ['incomplete_download', { incompleteDownload: true }],
    ['in_flight_operation', { inFlightOperation: true }],
    ['active_job', { hasActiveJob: true }],
    ['pending_duplicate_resolution', { pendingDuplicateResolution: true }],
  ] as const)('excludes on %s', (reason, patch) => {
    const v = evaluateExclusions(clean(patch as Partial<ExclusionFacts>), opts());
    expect(v.excluded).toBe(true);
    expect(v.allReasons).toContain(reason);
    expect(v.status).toBe('excluded_active');
  });
});

describe('grace period', () => {
  it('excludes a file added inside the window', () => {
    const v = evaluateExclusions(clean({ addedAt: new Date('2026-05-20T00:00:00Z') }), opts());
    expect(v.allReasons).toContain('within_grace_period');
  });

  it('allows a file older than the window', () => {
    const v = evaluateExclusions(clean({ addedAt: new Date('2026-01-01T00:00:00Z') }), opts());
    expect(v.excluded).toBe(false);
  });

  // We cannot show it is old enough, so we do not act.
  it('fails closed when the added date is unknown', () => {
    const v = evaluateExclusions(clean({ addedAt: null }), opts());
    expect(v.allReasons).toContain('within_grace_period');
  });

  it('is skipped when the policy sets no grace period', () => {
    const v = evaluateExclusions(
      clean({ addedAt: new Date('2026-05-31T00:00:00Z') }),
      opts({ exclusions: { ...opts().exclusions, addedWithinDays: undefined } }),
    );
    expect(v.excluded).toBe(false);
  });
});

describe('measured-data and playback trust', () => {
  it('excludes an unmeasured file when the policy uses technical conditions', () => {
    const v = evaluateExclusions(clean({ technicalMeasured: false }), opts());
    expect(v.allReasons).toContain('unmeasured_technical');
    expect(v.status).toBe('excluded_unmeasured');
  });

  it('does not care about measurement when the policy uses no technical conditions', () => {
    const v = evaluateExclusions(
      clean({ technicalMeasured: false, policyUsesMeasuredConditions: false }),
      opts(),
    );
    expect(v.excluded).toBe(false);
  });

  // The single most dangerous failure mode: an untrustworthy aggregate reads as
  // "0 plays", identical to a genuinely untouched file.
  it('excludes when playback data cannot be vouched for', () => {
    const v = evaluateExclusions(clean({ playbackTrustworthy: false }), opts());
    expect(v.allReasons).toContain('stale_playback_data');
  });

  it('excludes when the aggregate is older than the policy tolerates', () => {
    const v = evaluateExclusions(
      clean({ playbackComputedAt: new Date('2026-01-01T00:00:00Z') }),
      opts({ exclusions: { ...opts().exclusions, maxPlaybackAggregateAgeDays: 7 } }),
    );
    expect(v.allReasons).toContain('stale_playback_data');
  });

  it('ignores playback staleness when the policy asks nothing of playback', () => {
    const v = evaluateExclusions(
      clean({ playbackTrustworthy: false, policyUsesPlaybackConditions: false }),
      opts(),
    );
    expect(v.excluded).toBe(false);
  });
});

describe('optional and last-copy guards', () => {
  it('honours the substantial-progress opt-in', () => {
    const o = opts({ exclusions: { ...opts().exclusions, excludeIfProgressAbovePercent: 75 } });
    expect(evaluateExclusions(clean({ maximumProgressPercent: 85 }), o).allReasons)
      .toContain('substantial_progress');
    expect(evaluateExclusions(clean({ maximumProgressPercent: 10 }), o).excluded).toBe(false);
  });

  it('never removes the last surviving copy', () => {
    const v = evaluateExclusions(clean({ isLastSurvivingCopy: true }), opts());
    expect(v.allReasons).toContain('last_surviving_copy');
  });

  it('refuses when a replacement is required but none was verified', () => {
    const v = evaluateExclusions(clean({ hasVerifiedReplacement: false }), opts({ replacementRequired: true }));
    expect(v.allReasons).toContain('replacement_required');
  });

  it('allows when the required replacement was verified', () => {
    const v = evaluateExclusions(clean({ hasVerifiedReplacement: true }), opts({ replacementRequired: true }));
    expect(v.excluded).toBe(false);
  });

  it('a vanished file is skipped_changed, not an error', () => {
    const v = evaluateExclusions(clean({ fileExists: false }), opts());
    expect(v.allReasons).toContain('file_missing');
    expect(v.status).toBe('skipped_changed');
  });
});

describe('multiple reasons', () => {
  it('reports all of them while surfacing the most important', () => {
    const v = evaluateExclusions(
      clean({ isProtected: true, isLocked: true, activePlayback: true }),
      opts(),
    );
    expect(v.reason).toBe('protected');
    expect(v.allReasons).toEqual(expect.arrayContaining(['protected', 'locked', 'active_playback']));
  });
});

// ── Fingerprint ──────────────────────────────────────────────────────────────
describe('candidateFingerprint', () => {
  const base = (over: Partial<FingerprintInput> = {}): FingerprintInput => ({
    mediaFileId: 'f1',
    path: '/media/Movies/Film (1998)/film.mkv',
    fileSizeBytes: 6_442_450_944n,
    modifiedAtMs: 1_700_000_000_000,
    identityKeys: ['ty:film:1998', 'external_id:imdb:tt123:1998'],
    policyVersionId: 'pv1',
    facts: { 'metadata.releaseYear': 1998, 'playback.completedPlayCount': 0 },
    factKeys: ['metadata.releaseYear', 'playback.completedPlayCount'],
    isProtected: false,
    protectionIds: [],
    replacementFileId: null,
    ...over,
  });

  it('is stable and 64-hex', () => {
    const fp = candidateFingerprint(base());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(candidateFingerprint(base())).toBe(fp);
  });

  it('is insensitive to identity-key and fact ordering', () => {
    const reordered = base({
      identityKeys: ['external_id:imdb:tt123:1998', 'ty:film:1998'],
      factKeys: ['playback.completedPlayCount', 'metadata.releaseYear'],
    });
    expect(candidateFingerprint(reordered)).toBe(candidateFingerprint(base()));
  });

  it.each([
    ['path', { path: '/media/Movies/Moved/film.mkv' }],
    ['size', { fileSizeBytes: 999n }],
    ['mtime', { modifiedAtMs: 1_800_000_000_000 }],
    ['identity', { identityKeys: ['ty:other:2000'] }],
    ['policy version', { policyVersionId: 'pv2' }],
    ['protection', { isProtected: true, protectionIds: ['p1'] }],
    ['replacement', { replacementFileId: 'f2' }],
  ])('changes when %s changes', (_label, patch) => {
    expect(candidateFingerprint(base(patch as Partial<FingerprintInput>)))
      .not.toBe(candidateFingerprint(base()));
  });

  it('changes when a policy-relevant fact changes', () => {
    const changed = base({ facts: { 'metadata.releaseYear': 1998, 'playback.completedPlayCount': 3 } });
    expect(candidateFingerprint(changed)).not.toBe(candidateFingerprint(base()));
  });

  // Unrelated churn must NOT invalidate every plan, or "changed" stops meaning
  // anything to an operator.
  it('ignores facts the policy does not read', () => {
    const irrelevant = base({
      facts: { 'metadata.releaseYear': 1998, 'playback.completedPlayCount': 0, 'metadata.rating': 9.9 },
    });
    expect(candidateFingerprint(irrelevant)).toBe(candidateFingerprint(base()));
  });

  it('diff names exactly what moved', () => {
    const after = base({ fileSizeBytes: 123n, isProtected: true, protectionIds: ['p9'] });
    const d = fingerprintDiff(base(), after);
    expect(d).toEqual(expect.arrayContaining(['size', 'protected', 'protections']));
    expect(d).not.toContain('path');
  });
});
