import { OpenSubtitlesProvider } from './opensubtitles.provider';

const raw = {
  attributes: {
    language: 'en',
    release: 'Show.S01E02.1080p.WEB-DL.NTB',
    download_count: 1200,
    from_trusted: true,
    hearing_impaired: false,
    moviehash_match: true,
    feature_details: { imdb_id: 111161, tmdb_id: 550, season_number: 1, episode_number: 2 },
    files: [{ file_id: 999, file_name: 'Show.S01E02.srt' }],
  },
};

describe('OpenSubtitlesProvider', () => {
  const p = new OpenSubtitlesProvider({ apiKey: 'k' });

  it('reports its capabilities', () => {
    expect(p.name).toBe('opensubtitles');
    expect(p.supportsHashSearch()).toBe(true);
    expect(p.supportsTvdbSearch()).toBe(false);
    expect(p.getCapabilities().machineTranslation).toBe(true);
  });

  it('is configured once an API key is present', () => {
    expect(new OpenSubtitlesProvider({}).validateConfiguration()).toBe(false);
    expect(p.validateConfiguration()).toBe(true);
  });

  it('normalizes a raw result and formats the IMDb id', () => {
    const n = p.normalizeResult(raw, 'abcd000000000001');
    expect(n).not.toBeNull();
    expect(n!.provider).toBe('opensubtitles');
    expect(n!.providerFileId).toBe('999');
    expect(n!.language).toBe('en');
    expect(n!.imdbId).toBe('tt0111161');
    expect(n!.tmdbId).toBe('550');
    expect(n!.season).toBe(1);
    expect(n!.episode).toBe(2);
    expect(n!.trustedUploader).toBe(true);
    expect(n!.downloads).toBe(1200);
  });

  it('records a hash match as match level 1 and carries the query hash', () => {
    const n = p.normalizeResult(raw, 'abcd000000000001');
    expect(n!.matchLevel).toBe(1);
    expect(n!.movieHash).toBe('abcd000000000001');
  });

  it('does not fabricate a hash when the result did not match one', () => {
    const n = p.normalizeResult({ attributes: { ...raw.attributes, moviehash_match: false } }, 'abcd000000000001');
    expect(n!.movieHash).toBeNull();
    expect(n!.matchLevel).toBeUndefined();
  });

  it('reads remaining quota from a download response', () => {
    expect(OpenSubtitlesProvider.quotaFrom({ remaining: 42, reset_time_utc: '2026-07-16T00:00:00Z' }).quotaRemaining).toBe(42);
    expect(OpenSubtitlesProvider.quotaFrom(null).quotaRemaining).toBeNull();
  });
});
