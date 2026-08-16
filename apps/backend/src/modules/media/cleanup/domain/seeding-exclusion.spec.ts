import { evaluateExclusions, type ExclusionFacts } from './exclusion-rules';

/**
 * A purge must not end someone's seed, and must not promise space it cannot
 * free.
 *
 * The library's import strategy is `hardlink`, so an imported file exists twice
 * by design: once in the library, once in the Intake payload a torrent seeds.
 * Deleting the library name frees NOTHING while the payload survives, and
 * strands the torrent — 29 of them on one live host, 10.3 GB. Discovery had no
 * notion of seeding at all, so an unattended run would have offered every one.
 */
const facts = (over: Partial<ExclusionFacts> = {}): ExclusionFacts => ({
  isProtected: false, hasLegalHold: false, isLocked: false,
  withinHardRoots: true, isSystemPath: false, isLibraryRoot: false, fileExists: true,
  activelySeeding: false, activePlayback: false, incompleteDownload: false,
  inFlightOperation: false, hasActiveJob: false, pendingDuplicateResolution: false,
  addedAt: new Date('2020-01-01'), ambiguousIdentity: false,
  policyUsesMeasuredConditions: false, technicalMeasured: true,
  policyUsesPlaybackConditions: false, playbackTrustworthy: true, playbackComputedAt: new Date(),
  isLastSurvivingCopy: false, hasVerifiedReplacement: true,
  ...over,
} as ExclusionFacts);

const evaluate = (over: Partial<ExclusionFacts>, exclusions: Record<string, unknown> = {}) =>
  evaluateExclusions(facts(over), { exclusions: exclusions as never, replacementRequired: false });

describe('the actively_seeding exclusion', () => {
  it('excludes an item a live torrent is still seeding', () => {
    const v = evaluate({ activelySeeding: true });
    expect(v.allReasons).toContain('actively_seeding');
  });

  it('leaves an item alone once nothing is seeding it', () => {
    expect(evaluate({ activelySeeding: false }).allReasons).not.toContain('actively_seeding');
  });

  it('lets a policy opt in deliberately', () => {
    // Reclaiming seeded media is a legitimate choice — it just has to be made.
    const v = evaluate({ activelySeeding: true }, { allowSeeding: true });
    expect(v.allReasons).not.toContain('actively_seeding');
  });

  it('excludes by default when the policy says nothing', () => {
    // A policy written before this rule existed must get the safe behaviour.
    expect(evaluate({ activelySeeding: true }, {}).allReasons).toContain('actively_seeding');
    expect(evaluate({ activelySeeding: true }, { allowSeeding: false }).allReasons).toContain('actively_seeding');
  });

  it('does not mask other reasons', () => {
    const v = evaluate({ activelySeeding: true, isLocked: true });
    expect(v.allReasons).toEqual(expect.arrayContaining(['locked', 'actively_seeding']));
  });
});
