import { TmdbMetadataProvider } from './metadata-provider';

/**
 * TMDB's `year` is a filter, not a hint — and the filter was deciding matches
 * the verification gate never got to see.
 *
 * `verifiedMovieMatches` allows +/-1 on the year precisely so a
 * festival-vs-wide-release drift still matches, and it skips the year gate
 * entirely for a candidate TMDB holds with no release date. Neither tolerance
 * could ever fire while the SEARCH excluded those candidates first. Both cases
 * below are films measured live on 2026-09-04, each sent out in the Movies
 * newsletter with no artwork and no synopsis.
 */
function provider(byUrl: (path: string, params: Record<string, string>) => any) {
  const p = new TmdbMetadataProvider('test-key');
  const calls: Array<{ path: string; params: Record<string, string> }> = [];
  (p as unknown as { get: (path: string, params: Record<string, string>) => Promise<any> }).get =
    async (path, params) => {
      calls.push({ path, params });
      return byUrl(path, params);
    };
  return { p, calls };
}

/** `Lola Dust`: the folder says 2024, TMDB dates it 2025-01-06. */
const lolaDust = { id: 1395035, title: 'Lola Dust', original_title: 'Lola Dust', release_date: '2025-01-06' };
/** `SILA: The Life Within Everything`: on TMDB with no release date at all. */
const sila = { id: 1761542, title: 'SILA: The Life Within Everything', original_title: 'SILA: The Life Within Everything', release_date: null };

describe('TMDB movie search — widening past the year filter', () => {
  it('finds a film TMDB dates one year later than the folder says', async () => {
    const { p, calls } = provider((path, params) => {
      if (!path.startsWith('/search/movie')) return { title: 'Lola Dust' };
      // The live API's behaviour: year=2024 excludes a 2025-01-06 release.
      return { results: params.year ? [] : [lolaDust] };
    });

    const details = await p.fetchDetails({ kind: 'movie', title: 'Lola Dust', year: 2024 });

    expect(details?.externalIds?.tmdb).toBe('1395035');
    // Narrow first, wide only if the narrow search found nothing.
    expect(calls[0].params.year).toBe('2024');
    expect(calls[1].params.year).toBeUndefined();
  });

  it('finds a film TMDB holds with no release date', async () => {
    const { p } = provider((path, params) => {
      if (!path.startsWith('/search/movie')) return { title: 'SILA: The Life Within Everything' };
      return { results: params.year ? [] : [sila] };
    });

    const details = await p.fetchDetails({
      kind: 'movie',
      title: 'SILA The Life Within Everything',
      year: 2026,
    });
    expect(details?.externalIds?.tmdb).toBe('1761542');
  });

  it('does not search twice when the year-filtered search already answered', async () => {
    const { p, calls } = provider((path) =>
      path.startsWith('/search/movie') ? { results: [lolaDust] } : { title: 'Lola Dust' },
    );
    await p.fetchDetails({ kind: 'movie', title: 'Lola Dust', year: 2025 });
    expect(calls.filter((c) => c.path.startsWith('/search/movie'))).toHaveLength(1);
  });

  it('does not search twice when there was no year to filter on', async () => {
    const { p, calls } = provider((path) => (path.startsWith('/search/movie') ? { results: [] } : {}));
    await p.fetchDetails({ kind: 'movie', title: 'Lola Dust', year: null });
    expect(calls.filter((c) => c.path.startsWith('/search/movie'))).toHaveLength(1);
  });

  /*
   * The widened search only ADDS candidates; the gate is untouched. A wrong film
   * that the year filter used to hide must still be rejected on its own merits.
   */
  it('still refuses a wrong film the widened search turns up', async () => {
    const mazeRunner = { id: 198663, title: 'The Maze Runner', original_title: 'The Maze Runner', release_date: '2014-09-10' };
    const { p } = provider((path, params) =>
      path.startsWith('/search/movie') ? { results: params.year ? [] : [mazeRunner] } : {},
    );
    expect(await p.fetchDetails({ kind: 'movie', title: 'Maze', year: 2017 })).toBeNull();
  });

  it('still refuses two films it cannot tell apart (the Leviticus case)', async () => {
    // TMDB carries two 2026 films titled exactly "Leviticus".
    const results = [
      { id: 1564614, title: 'Leviticus', original_title: 'Leviticus', release_date: '2026-06-17' },
      { id: 1658905, title: 'Leviticus', original_title: 'Leviticus', release_date: '2026-03-26' },
    ];
    const { p } = provider((path) => (path.startsWith('/search/movie') ? { results } : {}));
    expect(await p.fetchDetails({ kind: 'movie', title: 'Leviticus', year: 2026 })).toBeNull();
  });
});
