import {
  UniversalMetadataProvider,
  hasValue,
  mergeDetails,
  type ProviderResult,
} from './universal-metadata.provider';
import { MetadataProviderRegistry } from './metadata-provider-registry.service';

/**
 * The Universal scraper is a merge policy, so the merge is where the whole thing
 * lives or dies. The invariants pinned here:
 *
 *   - a PREFERENCE is "prefer", never "only" — naming a provider that has nothing
 *     to say must not blank the field,
 *   - EMPTY is not an answer (`[]`, `''`, whitespace) — a hollow record must not
 *     out-rank a real one,
 *   - external ids are UNIONED, never picked — this is the bit Trakt needs,
 *   - a provider that THROWS drops out and the rest still compose.
 */
const tvdb: ProviderResult = {
  provider: 'tvdb',
  details: {
    title: 'The Librarians',
    overview: '', // ← TVDB has the show but no synopsis here
    year: 2014,
    genres: ['Adventure', 'Fantasy'],
    certification: 'TV-PG',
    cast: [],
    externalIds: { tvdb: '279121', imdb: 'tt3663490' },
  },
};

const tmdb: ProviderResult = {
  provider: 'tmdb',
  details: {
    title: 'The Librarians (US)',
    overview: 'A team of librarians protects magical artefacts.',
    year: 2014,
    genres: ['Sci-Fi'],
    cast: [{ name: 'Rebecca Romijn', role: 'Eve Baird' }],
    rating: 7.4,
    externalIds: { tmdb: '60767', imdb: 'tt3663490' },
  },
};

describe('hasValue', () => {
  it('treats empty as "no answer", not as an answer', () => {
    expect(hasValue('')).toBe(false);
    expect(hasValue('   ')).toBe(false);
    expect(hasValue([])).toBe(false);
    expect(hasValue(null)).toBe(false);
    expect(hasValue(undefined)).toBe(false);

    expect(hasValue('x')).toBe(true);
    expect(hasValue(['x'])).toBe(true);
    expect(hasValue(0)).toBe(true); // a real zero (e.g. runtime 0) IS an answer
    expect(hasValue(false)).toBe(true);
  });
});

describe('mergeDetails', () => {
  it('takes each field from the first provider that actually has it', () => {
    const d = mergeDetails([tvdb, tmdb])!;

    // Chain order (tvdb first) wins where tvdb has a value...
    expect(d.title).toBe('The Librarians');
    expect(d.genres).toEqual(['Adventure', 'Fantasy']);
    expect(d.certification).toBe('TV-PG');
    // ...and TMDB fills what TVDB left empty, which is the entire point.
    expect(d.overview).toBe('A team of librarians protects magical artefacts.');
    expect(d.cast).toEqual([{ name: 'Rebecca Romijn', role: 'Eve Baird' }]);
    expect(d.rating).toBe(7.4);
    expect(d.providerName).toBe('universal');
  });

  it('honours a per-field preference over chain order', () => {
    const d = mergeDetails([tvdb, tmdb], { title: 'tmdb', genres: 'tmdb' })!;

    expect(d.title).toBe('The Librarians (US)');
    expect(d.genres).toEqual(['Sci-Fi']);
    // Unpreferenced fields still follow chain order.
    expect(d.certification).toBe('TV-PG');
  });

  it('falls back to chain order when the PREFERRED provider has nothing — a preference must never blank a field', () => {
    // Prefer TVDB for the overview; TVDB's overview is ''. The field must come
    // from TMDB rather than come back empty.
    const d = mergeDetails([tvdb, tmdb], { overview: 'tvdb' })!;

    expect(d.overview).toBe('A team of librarians protects magical artefacts.');
  });

  it('ignores a preference naming a provider that is not in the chain', () => {
    const d = mergeDetails([tvdb, tmdb], { title: 'anidb' })!;

    expect(d.title).toBe('The Librarians'); // chain order, unharmed
  });

  it('UNIONS external ids across every provider — the ids Trakt and cross-matching need', () => {
    const d = mergeDetails([tvdb, tmdb])!;

    // A plain chain would have carried only the winner's ids. Composing leaves us
    // holding all three at once.
    expect(d.externalIds).toEqual({
      tvdb: '279121',
      imdb: 'tt3663490',
      tmdb: '60767',
    });
  });

  it('resolves an id conflict by chain order rather than last-write-wins', () => {
    const a: ProviderResult = { provider: 'tvdb', details: { externalIds: { imdb: 'tt-correct' } } };
    const b: ProviderResult = { provider: 'tmdb', details: { externalIds: { imdb: 'tt-wrong' } } };

    expect(mergeDetails([a, b])!.externalIds).toEqual({ imdb: 'tt-correct' });
  });

  it('records which provider supplied each field', () => {
    const d = mergeDetails([tvdb, tmdb])!;

    expect(d.fieldSources).toMatchObject({
      title: 'tvdb',
      overview: 'tmdb', // ← "why is this the TMDB synopsis?" now has an answer
      rating: 'tmdb',
    });
  });

  it('returns null when nobody answered', () => {
    expect(mergeDetails([])).toBeNull();
  });
});

describe('UniversalMetadataProvider', () => {
  const provider = (name: string, impl: () => Promise<any>) => ({
    name,
    lookup: jest.fn(async () => ({})),
    fetchDetails: jest.fn(impl),
  });

  const query = { kind: 'tv' as const, title: 'The Librarians', year: 2014 };

  it('queries every provider and composes them', async () => {
    const a = provider('tvdb', async () => tvdb.details);
    const b = provider('tmdb', async () => tmdb.details);
    const uni = new UniversalMetadataProvider([a, b]);

    const d = await uni.fetchDetails(query);

    expect(a.fetchDetails).toHaveBeenCalled();
    expect(b.fetchDetails).toHaveBeenCalled(); // ← unlike the plain chain, which stops early
    expect(d?.title).toBe('The Librarians');
    expect(d?.overview).toContain('magical artefacts');
  });

  it('drops a provider that throws and composes from the survivors', async () => {
    const sick = provider('tvdb', async () => {
      throw new Error('TVDB is down');
    });
    const healthy = provider('tmdb', async () => tmdb.details);
    const uni = new UniversalMetadataProvider([sick, healthy]);

    const d = await uni.fetchDetails(query);

    expect(d?.title).toBe('The Librarians (US)');
    expect(d?.externalIds).toEqual({ tmdb: '60767', imdb: 'tt3663490' });
  });

  it('returns null when every provider fails, so the caller falls back to local NFO', async () => {
    const uni = new UniversalMetadataProvider([
      provider('tvdb', async () => {
        throw new Error('down');
      }),
      provider('tmdb', async () => null),
    ]);

    await expect(uni.fetchDetails(query)).resolves.toBeNull();
  });
});

describe('the registry wiring', () => {
  const settingsWith = (values: Record<string, unknown>) => ({
    get: jest.fn(async (key: string) => values[key]),
  });

  beforeEach(() => {
    delete process.env.TMDB_API_KEY;
    delete process.env.TVDB_API_KEY;
  });

  it('collapses the chain to the composing provider when Universal is on', async () => {
    const reg = new MetadataProviderRegistry(
      settingsWith({
        'media.tmdbApiKey': 'tm',
        'media.tvdbApiKey': 'tv',
        'media.universalScraper.enabled': true,
      }) as any,
    );

    const chain = await reg.chain('tv');

    expect(chain.map((p) => p.name)).toEqual(['universal']);
  });

  it('stays inert with only ONE provider — composing a single source can add nothing', async () => {
    const reg = new MetadataProviderRegistry(
      settingsWith({
        'media.tmdbApiKey': 'tm',
        'media.universalScraper.enabled': true,
      }) as any,
    );

    // Not ['universal'] — that would be pure overhead for an identical answer.
    expect((await reg.chain('tv')).map((p) => p.name)).toEqual(['tmdb']);
  });

  it('leaves the plain chain alone when Universal is off', async () => {
    const reg = new MetadataProviderRegistry(
      settingsWith({ 'media.tmdbApiKey': 'tm', 'media.tvdbApiKey': 'tv' }) as any,
    );

    expect((await reg.chain('tv')).map((p) => p.name)).toEqual(['tvdb', 'tmdb']);
  });
});
