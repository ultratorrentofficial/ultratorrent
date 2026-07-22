import {
  assembleEvaluationFacts, assembleExclusionFacts, isAmbiguous, isProbeMeasured,
  type RawContext, type RawMediaFile, type RawMediaItem,
} from './fact-assembly';
import { aggregatePlays } from './playback-aggregate';
import { evaluatePolicy } from './policy-evaluator';
import { rankCandidate, compareRanked } from './candidate-ranking';

const NOW = new Date('2026-06-01T00:00:00Z');

const file = (over: Partial<RawMediaFile> = {}): RawMediaFile => ({
  id: 'f1',
  path: '/media/Movies/Film (1998)/film.mkv',
  size: 6_442_450_944n,
  width: 1280, height: 720,
  videoCodec: 'x264', videoBitDepth: 8,
  techSource: 'probe', probedAt: new Date('2026-01-01T00:00:00Z'),
  modifiedAt: new Date('2025-01-01T00:00:00Z'),
  ...over,
});

const item = (over: Partial<RawMediaItem> = {}): RawMediaItem => ({
  id: 'i1', libraryId: 'lib1', mediaType: 'movie', year: 1998,
  matchStatus: 'matched', confidence: 0.95, locked: false,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  externalIds: [{ provider: 'imdb', externalId: 'tt123' }],
  metadata: { rating: 7.2, genres: ['Drama'] },
  ...over,
});

const ctx = (over: Partial<RawContext> = {}): RawContext => ({
  libraryKind: 'movie',
  playback: aggregatePlays([]),
  playbackComputedAt: new Date('2026-05-30T00:00:00Z'),
  onWatchlist: false, inCollection: false, collectionIds: [],
  activePlayback: false, hasActiveJob: false, incompleteDownload: false,
  inFlightOperation: false, pendingDuplicateResolution: false,
  isLastSurvivingCopy: false, hasVerifiedReplacement: true, betterReplacementExists: false,
  isProtected: false, hasLegalHold: false,
  withinHardRoots: true, isSystemPath: false, isLibraryRoot: false, fileExists: true,
  now: NOW,
  ...over,
});

describe('technical provenance', () => {
  it('treats a probed row as measured', () => {
    expect(isProbeMeasured(file())).toBe(true);
  });

  it('treats a filename-derived row as unmeasured', () => {
    expect(isProbeMeasured(file({ techSource: 'filename', probedAt: null }))).toBe(false);
  });

  it('classifies resolution only from measured pixels', () => {
    const measured = assembleEvaluationFacts(file(), item(), ctx());
    expect(measured.technical?.resolutionClass).toBe('720p');
    expect(measured.technical?.resolutionOrdinal).toBe(3);

    const guessed = assembleEvaluationFacts(
      file({ techSource: 'filename', probedAt: null }), item(), ctx(),
    );
    // Absent, not 'unknown' as a value — the evaluator must see UNMEASURED.
    expect(guessed.technical?.resolutionClass).toBeUndefined();
    expect(guessed.technical?.resolutionOrdinal).toBeUndefined();
  });

  it('keeps a 1920x800 scope encode at 1080p', () => {
    const f = assembleEvaluationFacts(file({ width: 1920, height: 800 }), item(), ctx());
    expect(f.technical?.resolutionClass).toBe('1080p');
  });
});

describe('playback facts — absence is not zero', () => {
  // The single most dangerous confusion in the feature.
  it('leaves every playback fact undefined when there is no aggregate', () => {
    const f = assembleEvaluationFacts(file(), item(), ctx({ playback: null }));
    expect(f.playback).toEqual({});
    expect(f.playback?.completedPlayCount).toBeUndefined();
  });

  it('a policy on completed plays is UNMEASURED, not matched, without an aggregate', () => {
    const f = assembleEvaluationFacts(file(), item(), ctx({ playback: null }));
    const r = evaluatePolicy(
      { type: 'condition', field: 'playback.completedPlayCount', operator: 'eq', value: 0 },
      f,
    );
    expect(r.outcome).toBe('unmeasured');
  });

  it('a genuinely empty aggregate does report zero plays', () => {
    const f = assembleEvaluationFacts(file(), item(), ctx());
    expect(f.playback?.completedPlayCount).toBe(0);
    expect(f.playback?.neverWatched).toBe(true);
  });

  it('marks a missing aggregate untrustworthy for the exclusion pass', () => {
    const ex = assembleExclusionFacts(file(), item(), ctx({ playback: null }), { measured: true, playback: true });
    expect(ex.playbackTrustworthy).toBe(false);
  });
});

describe('ambiguity is derived, since no column records it', () => {
  it('an unmatched item is ambiguous', () => {
    expect(isAmbiguous(item({ matchStatus: 'unmatched' }))).toBe(true);
  });

  it('a hand-corrected item is never ambiguous', () => {
    expect(isAmbiguous(item({ matchStatus: 'manual', confidence: 0, externalIds: [] }))).toBe(false);
  });

  it('a matched item with an external id is not ambiguous', () => {
    expect(isAmbiguous(item({ confidence: 0.4 }))).toBe(false);
  });

  it('a low-confidence match with no external id is ambiguous', () => {
    expect(isAmbiguous(item({ confidence: 0.4, externalIds: [] }))).toBe(true);
  });
});

describe('assembled facts drive a real policy', () => {
  it('matches the old/unwatched/low-res template shape', () => {
    const f = assembleEvaluationFacts(file(), item(), ctx());
    const r = evaluatePolicy({
      type: 'all',
      children: [
        { type: 'condition', field: 'metadata.releaseYear', operator: 'lt', value: 2001 },
        { type: 'condition', field: 'playback.completedPlayCount', operator: 'eq', value: 0 },
        { type: 'condition', field: 'technical.resolutionClass', operator: 'lt', value: '1080p' },
      ],
    }, f);
    expect(r.outcome).toBe('matched');
    expect(r.matchedConditions).toHaveLength(3);
  });

  it('surfaces lock and protection state to the exclusion pass', () => {
    const ex = assembleExclusionFacts(
      file(), item({ locked: true }), ctx({ isProtected: true, hasLegalHold: true }),
      { measured: true, playback: true },
    );
    expect(ex.isLocked).toBe(true);
    expect(ex.isProtected).toBe(true);
    expect(ex.hasLegalHold).toBe(true);
  });
});

describe('ranking is explainable', () => {
  it('every point is attributed to a named factor', () => {
    const r = rankCandidate({
      reclaimableBytes: 10 * 1024 ** 3,
      daysSinceLastPlay: null,
      completedPlayCount: 0,
      qualityTiersBelowBest: 2,
      replacementConfidence: 1,
      daysSinceAdded: 900,
      rating: 3,
      isDuplicate: true,
    });
    expect(r.score).toBe(r.contributions.reduce((n, c) => n + c.points, 0));
    expect(r.contributions.map((c) => c.factor)).toEqual(
      expect.arrayContaining(['replacement', 'duplicate', 'never_played', 'quality', 'reclaim']),
    );
    for (const c of r.contributions) expect(c.detail).toBeTruthy();
  });

  // A verified replacement must outrank the sum of weaker signals.
  it('a verified replacement dominates', () => {
    const withReplacement = rankCandidate({
      reclaimableBytes: 0, daysSinceLastPlay: 0, completedPlayCount: 50,
      qualityTiersBelowBest: 0, replacementConfidence: 1, daysSinceAdded: 0, rating: 10, isDuplicate: false,
    });
    const withoutButEverythingElse = rankCandidate({
      reclaimableBytes: 20 * 1024 ** 3, daysSinceLastPlay: 3000, completedPlayCount: 0,
      qualityTiersBelowBest: 3, replacementConfidence: null, daysSinceAdded: 3000, rating: 0, isDuplicate: false,
    });
    expect(withReplacement.score).toBeGreaterThan(withoutButEverythingElse.score);
  });

  it('scores nothing when there is nothing to say', () => {
    const r = rankCandidate({
      reclaimableBytes: 0, daysSinceLastPlay: 0, completedPlayCount: 10,
      qualityTiersBelowBest: 0, replacementConfidence: null, daysSinceAdded: 0, rating: 9, isDuplicate: false,
    });
    expect(r.score).toBe(0);
    expect(r.contributions).toEqual([]);
  });

  it('orders deterministically, ties included', () => {
    const ranked = [
      { score: 10, id: 'b' }, { score: 50, id: 'c' }, { score: 10, id: 'a' },
    ].sort(compareRanked);
    expect(ranked.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
});
