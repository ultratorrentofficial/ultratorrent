import { scoreCandidate, tierFor, type ScoringContext } from './scoring';
import type { NormalizedSubtitle } from '../providers/subtitle-provider';

const base = (over: Partial<NormalizedSubtitle> = {}): NormalizedSubtitle => ({
  provider: 'opensubtitles',
  language: 'en',
  ...over,
});

const ctx = (over: Partial<ScoringContext> = {}): ScoringContext => ({
  movieHash: 'abcd000000000001',
  fileSize: 1000,
  imdbId: 'tt0111161',
  season: 1,
  episode: 2,
  releaseGroup: 'NTB',
  source: 'WEB-DL',
  resolution: '1080p',
  runtimeSec: 1400,
  preferredLanguages: ['en'],
  preferredProviders: ['opensubtitles'],
  ...over,
});

describe('tierFor', () => {
  it('maps score ranges to tiers', () => {
    expect(tierFor(95)).toBe('auto');
    expect(tierFor(90)).toBe('auto');
    expect(tierFor(80)).toBe('download');
    expect(tierFor(60)).toBe('present');
    expect(tierFor(10)).toBe('reject');
  });
});

describe('scoreCandidate', () => {
  it('floors an exact hash match at the auto tier even with sparse metadata', () => {
    const r = scoreCandidate(base({ movieHash: 'abcd000000000001' }), ctx({ preferredLanguages: [], preferredProviders: [] }));
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.tier).toBe('auto');
    expect(r.breakdown.movieHash).toBe(50);
  });

  it('rewards external id + season/episode + preferred language', () => {
    const r = scoreCandidate(
      base({ imdbId: 'tt0111161', season: 1, episode: 2, releaseName: 'Show.S01E02.1080p.WEB-DL.NTB' }),
      ctx({ movieHash: null }),
    );
    expect(r.breakdown.externalId).toBe(15);
    expect(r.breakdown.seasonEpisode).toBe(15);
    expect(r.breakdown.preferredLanguage).toBe(5);
    expect(r.score).toBeGreaterThanOrEqual(50);
  });

  it('penalizes machine translation', () => {
    const good = scoreCandidate(base({ imdbId: 'tt0111161', season: 1, episode: 2 }), ctx({ movieHash: null }));
    const mt = scoreCandidate(base({ imdbId: 'tt0111161', season: 1, episode: 2, machineTranslated: true }), ctx({ movieHash: null }));
    expect(mt.score).toBeLessThan(good.score);
    expect(mt.breakdown.machineTranslation).toBe(-20);
  });

  it('penalizes a clear runtime mismatch', () => {
    const r = scoreCandidate(base({ imdbId: 'tt0111161', runtimeSec: 100 }), ctx({ movieHash: null, runtimeSec: 1400 }));
    expect(r.breakdown.wrongRuntime).toBe(-25);
  });

  it('rejects a nothing-matches candidate', () => {
    const r = scoreCandidate(base({ language: 'de' }), ctx({ movieHash: null, imdbId: null, preferredLanguages: ['en'] }));
    expect(r.tier).toBe('reject');
  });

  it('penalizes an edition mismatch', () => {
    const r = scoreCandidate(
      base({ imdbId: 'tt0111161', releaseName: 'Movie.Extended.1080p' }),
      ctx({ movieHash: null, edition: 'theatrical' }),
    );
    expect(r.breakdown.wrongEdition).toBe(-40);
  });
});
