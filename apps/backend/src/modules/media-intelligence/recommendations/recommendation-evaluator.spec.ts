import { MEDIA_FINDING_CODES, ALL_MEDIA_FINDING_CODES } from '@ultratorrent/shared';

import { evaluateRecommendation, evaluateRecommendations } from './recommendation-evaluator';
import type { RecommendationInput } from './recommendation-evaluator';

/**
 * Finding → recommendation.
 *
 * The claims worth pinning are the ones that keep this layer honest: that a
 * finding with no real remedy produces NOTHING, that "potential" never becomes
 * "available", and that the conservative verbs (review) are chosen wherever
 * the destructive or failing ones (delete, retry) cannot be proven safe.
 */

const F = MEDIA_FINDING_CODES;

const input = (over: Partial<RecommendationInput> = {}): RecommendationInput => ({
  findingId: 'f1',
  code: F.QUALITY_UPGRADE_POTENTIAL,
  severity: 'opportunity',
  entityType: 'series',
  entityId: 'show-1',
  evidence: {},
  ...over,
});

describe('evaluateRecommendation — quality', () => {
  it('proposes a SEARCH for upgrade potential, never an available upgrade', () => {
    const r = evaluateRecommendation(
      input({ evidence: { matchedRung: 2, preferredRung: 0, totalRungs: 4 } }),
    );
    expect(r?.type).toBe('SEARCH_FOR_QUALITY_UPGRADE');
    expect(r?.recommendationClass).toBe('search');
    // The whole point of the phase: nothing has asked an indexer yet.
    expect(r?.verification).toBe('not_checked');
    expect(r?.unknowns).toContain('whether_a_superior_release_is_obtainable');
  });

  it('carries the rung evidence the finding proved, and invents none', () => {
    const r = evaluateRecommendation(
      input({ evidence: { matchedRung: 2, totalRungs: 4, preferenceSource: 'global_ladder' } }),
    );
    expect(r?.evidence).toMatchObject({ matchedRung: 2, totalRungs: 4, preferenceSource: 'global_ladder' });
    // Absent facts stay null rather than becoming zero or a guess.
    expect(r?.evidence.matchedRungName).toBeNull();
  });

  it('trusts a below-preference finding more when the comparison was measured', () => {
    const measured = evaluateRecommendation(
      input({ code: F.QUALITY_BELOW_PREFERENCE, evidence: { measuredFileCount: 12 } }),
    );
    const unmeasured = evaluateRecommendation(
      input({ code: F.QUALITY_BELOW_PREFERENCE, evidence: { measuredFileCount: 0 } }),
    );
    expect(measured?.confidence).toBe('high');
    // Nothing was measured, so the verdict rests on nothing worth trusting.
    expect(unmeasured?.confidence).toBe('low');
  });

  it('routes the grab to the owning domain rather than claiming a capability', () => {
    const r = evaluateRecommendation(input({ code: F.QUALITY_BELOW_PREFERENCE }));
    // Acquisition registers no per-item search capability; a dangling CAMA id
    // would render as a dead control.
    expect(r?.capabilityId).toBeNull();
    expect(r?.plan).toContain('require_approval');
    expect(r?.plan).toContain('hand_off_to_owning_domain');
  });
});

describe('evaluateRecommendation — intake', () => {
  it('offers retry ONLY when a retryable job was proven', () => {
    const proven = evaluateRecommendation(
      input({ code: F.INTAKE_FAILED, evidence: { failed: 1 }, retryableIntakeJobId: 'job-9' }),
    );
    expect(proven?.type).toBe('RETRY_FAILED_INTAKE');
    expect(proven?.evidence.intakeJobId).toBe('job-9');
  });

  it('falls back to review when retryability is unproven', () => {
    // `MediaIntakeService.retry()` accepts exactly one state and throws for
    // every other, so an unproven retry would render a button that 500s.
    const r = evaluateRecommendation(input({ code: F.INTAKE_FAILED, evidence: { failed: 3 } }));
    expect(r?.type).toBe('REVIEW_FAILED_INTAKE');
    expect(r?.unknowns).toContain('whether_the_failure_is_retryable');
  });

  it('never proposes releasing a quarantine automatically', () => {
    const r = evaluateRecommendation(input({ code: F.INTAKE_QUARANTINED, evidence: { quarantined: 2 } }));
    expect(r?.type).toBe('REVIEW_FAILED_INTAKE');
    expect(r?.recommendationClass).toBe('review');
    // Releasing requires choosing a resume stage — a human judgement.
    expect(r?.unknowns).toContain('which_stage_should_resume');
  });
});

describe('evaluateRecommendation — conservative verbs', () => {
  it('recommends reviewing duplicates, never deleting one', () => {
    const r = evaluateRecommendation(
      input({ code: F.DUPLICATE_MEDIA_PRESENT, evidence: { groups: 2, reclaimableBytes: 1024 } }),
    );
    expect(r?.type).toBe('REVIEW_DUPLICATES');
    expect(r?.recommendationClass).toBe('review');
    expect(r?.unknowns).toContain('which_copy_should_be_kept');
    expect(JSON.stringify(r)).not.toMatch(/delete/i);
  });

  it('recommends reviewing identity, never an automatic match', () => {
    const r = evaluateRecommendation(
      input({ code: F.IDENTITY_UNRESOLVED, evidence: { knownTitle: 'Some Show' } }),
    );
    expect(r?.type).toBe('REVIEW_IDENTITY');
    expect(r?.recommendationClass).toBe('review');
    expect(JSON.stringify(r)).not.toMatch(/rematch|auto/i);
  });

  it('keeps subtitle coverage low-confidence until a policy is actually read', () => {
    const r = evaluateRecommendation(
      input({ code: F.SUBTITLE_COVERAGE_INCOMPLETE, evidence: { withSubtitles: 3, total: 10, without: 7 } }),
    );
    expect(r?.type).toBe('SEARCH_SUBTITLES');
    // The finding proves uneven coverage within the title, NOT that a
    // required language is missing. Saying more would be a fabrication.
    expect(r?.confidence).toBe('low');
    expect(r?.unknowns).toContain('whether_any_required_language_is_missing');
  });
});

describe('evaluateRecommendation — capability routing', () => {
  it.each([
    [F.DUPLICATE_MEDIA_PRESENT, 'duplicates.ignore'],
    [F.METADATA_INCOMPLETE, 'media.metadata.refresh'],
    [F.SUBTITLE_COVERAGE_INCOMPLETE, 'subtitles.search'],
    [F.LIBRARY_NEVER_SCANNED, 'media.library.scan'],
    [F.TORRENT_ERROR, 'torrents.recheck'],
  ])('%s points at the capability its owning module already registered', (code, capabilityId) => {
    expect(evaluateRecommendation(input({ code }))?.capabilityId).toBe(capabilityId);
  });
});

describe('evaluateRecommendation — refuses to invent', () => {
  /*
   * Each of these was audited against the real capability surface and has no
   * remedy in this codebase. A recommendation here would render a control
   * that does not exist, which teaches operators to distrust the surface.
   */
  it.each([
    // No user-invocable mediainfo probe exists anywhere.
    F.MEDIA_TECHNICAL_DATA_MISSING,
    // Documented as never auto-merged; nothing can resolve it.
    F.IDENTITY_EXTERNAL_ID_CONFLICT,
    // Every artwork route needs a human to choose an image.
    F.ARTWORK_INCOMPLETE,
    // The remedy is editing configuration, not an entity-scoped action.
    F.ACQUISITION_NOT_READY,
    F.ACQUISITION_SEARCH_FAILING,
    // The search endpoint is keyed to a watchlist item and grabs as it goes;
    // there is no read-only per-entity search to point at.
    F.EPISODES_MISSING,
    // Declared but never emitted by any evaluator.
    F.BACKFILL_STALLED,
  ])('produces no recommendation for %s', (code) => {
    expect(evaluateRecommendation(input({ code }))).toBeNull();
  });

  it('produces nothing for a code it has never heard of', () => {
    expect(evaluateRecommendation(input({ code: 'SOME_FUTURE_CODE' }))).toBeNull();
  });

  it('never emits a type whose evidence it could not fill', () => {
    // Every rule must survive a finding whose evidence object is empty —
    // a real possibility, since evidence shape is the evaluator's choice.
    for (const code of ALL_MEDIA_FINDING_CODES) {
      const r = evaluateRecommendation(input({ code, evidence: {} }));
      if (!r) continue;
      expect(r.type).toBeTruthy();
      expect(r.confidence).toBeTruthy();
      expect(Array.isArray(r.plan)).toBe(true);
    }
  });
});

describe('evaluateRecommendations', () => {
  it('preserves the order it was given and drops the unsupported', () => {
    const drafts = evaluateRecommendations([
      input({ findingId: 'a', code: F.DUPLICATE_MEDIA_PRESENT }),
      // Unsupported — must vanish rather than becoming a placeholder.
      input({ findingId: 'b', code: F.ARTWORK_INCOMPLETE }),
      input({ findingId: 'c', code: F.METADATA_INCOMPLETE }),
    ]);
    expect(drafts.map((d) => d.findingId)).toEqual(['a', 'c']);
  });

  it('is deterministic — identical input yields byte-identical output', () => {
    const inputs = [input({ code: F.DUPLICATE_MEDIA_PRESENT }), input({ code: F.METADATA_INCOMPLETE })];
    expect(JSON.stringify(evaluateRecommendations(inputs))).toBe(
      JSON.stringify(evaluateRecommendations(inputs)),
    );
  });
});
