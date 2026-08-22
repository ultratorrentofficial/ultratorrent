import { makeAkaFilter, mapAkaRow } from './imdb-tsv';

/** Build an aka row the same way the importer does, from raw TSV fields. */
const row = (region: string, language: string, isOriginal = '0') =>
  mapAkaRow(['tt0001', '1', 'Some Title', region, language, '', '', isOriginal])!;

describe('makeAkaFilter', () => {
  it('returns null when neither preference is set, so the unfiltered path stays free of a per-row call', () => {
    expect(makeAkaFilter({ preferredRegion: null, preferredLanguage: null })).toBeNull();
    expect(makeAkaFilter({})).toBeNull();
    // Whitespace-only settings are not a preference.
    expect(makeAkaFilter({ preferredRegion: '  ', preferredLanguage: '' })).toBeNull();
  });

  it('keeps rows matching the preferred region and drops the rest', () => {
    const keep = makeAkaFilter({ preferredRegion: 'US' })!;
    expect(keep(row('US', 'en'))).toBe(true);
    expect(keep(row('DE', 'de'))).toBe(false);
    expect(keep(row('JP', 'ja'))).toBe(false);
  });

  it('matches region case-insensitively', () => {
    const keep = makeAkaFilter({ preferredRegion: 'us' })!;
    expect(keep(row('US', 'en'))).toBe(true);
  });

  it('accepts a comma-separated list of regions', () => {
    const keep = makeAkaFilter({ preferredRegion: 'US, GB ,PR' })!;
    expect(keep(row('US', 'en'))).toBe(true);
    expect(keep(row('GB', 'en'))).toBe(true);
    expect(keep(row('PR', 'es'))).toBe(true);
    expect(keep(row('FR', 'fr'))).toBe(false);
  });

  it('treats region and language as alternatives, not a conjunction', () => {
    const keep = makeAkaFilter({ preferredRegion: 'US', preferredLanguage: 'es' })!;
    expect(keep(row('US', 'en'))).toBe(true); // region matches
    expect(keep(row('MX', 'es'))).toBe(true); // language matches
    expect(keep(row('DE', 'de'))).toBe(false); // neither
  });

  it('does not carve out original titles, which imdb_titles already covers', () => {
    // `imdb_titles.originalTitle` holds the same string and the dataset search
    // matches primaryTitle OR originalTitle before it consults imdb_akas at all,
    // so keeping these buys no recall — and costs one row per title (9.0M of the
    // 9.97M otherwise kept under a US filter).
    const keep = makeAkaFilter({ preferredRegion: 'US' })!;
    expect(keep(row('JP', 'ja', '1'))).toBe(false);
    // ...but an original title that *does* match the preference is still kept.
    expect(keep(row('US', 'en', '1'))).toBe(true);
  });

  it('drops rows with an empty region when a region preference is set', () => {
    const keep = makeAkaFilter({ preferredRegion: 'US' })!;
    expect(keep(row('', ''))).toBe(false);
  });
});
