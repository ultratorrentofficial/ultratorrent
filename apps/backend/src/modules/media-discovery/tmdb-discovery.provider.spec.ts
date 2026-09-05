import { TmdbDiscoveryProvider } from './tmdb-discovery.provider';

/**
 * Every fixture here is the shape the live API actually returned on 2026-09-05,
 * because two of its behaviours are not what the endpoint names suggest.
 */
function provider(routes: Record<string, any>) {
  const p = new TmdbDiscoveryProvider('test-key');
  const calls: Array<{ path: string; params: Record<string, string> }> = [];
  (p as any).get = async (path: string, params: Record<string, string>) => {
    calls.push({ path, params });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    return key ? routes[key] : null;
  };
  return { p, calls };
}

const GENRES = { genres: [{ id: 878, name: 'Science Fiction' }, { id: 99, name: 'Documentary' }] };

describe('TmdbDiscoveryProvider — upcoming movies', () => {
  /*
   * `/movie/upcoming` returned "Avengers: Endgame" (2019-04-26) as its top
   * "upcoming" film. It is popularity-sorted over a loose window, so it is not
   * used at all — an explicit date window is the only thing that means what it
   * says.
   */
  it('queries /discover/movie with an explicit date window, never /movie/upcoming', async () => {
    const { p, calls } = provider({
      '/discover/movie': { results: [], total_pages: 1 },
      '/genre/': GENRES,
    });
    await p.getUpcomingMovies({ windowDays: 60 });

    expect(calls.some((c) => c.path.startsWith('/movie/upcoming'))).toBe(false);
    const discover = calls.find((c) => c.path.startsWith('/discover/movie'))!;
    expect(discover.params['release_date.gte']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(discover.params['release_date.lte']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('translates release types into TMDB’s with_release_type codes', async () => {
    const { p, calls } = provider({ '/discover/movie': { results: [], total_pages: 1 }, '/genre/': GENRES });
    await p.getUpcomingMovies({ windowDays: 60, releaseTypes: ['digital', 'streaming'] });

    // 4 = Digital, 6 = TV/streaming.
    expect(calls[0].params.with_release_type).toBe('4|6');
  });

  it('omits the filter entirely when no release type was asked for', async () => {
    const { p, calls } = provider({ '/discover/movie': { results: [], total_pages: 1 }, '/genre/': GENRES });
    await p.getUpcomingMovies({ windowDays: 30 });
    expect(calls[0].params.with_release_type).toBeUndefined();
  });

  /*
   * The measured trap: /discover filters on TYPED dates but returns the film's
   * PRIMARY one. A digital window from 2026-09-05 returned "Toy Story 5 —
   * 2026-06-17", its theatrical date. Storing that would record a date the query
   * never matched.
   */
  it('replaces the headline date with the film’s typed release dates', async () => {
    const { p } = provider({
      '/discover/movie': {
        results: [{ id: 1022789, title: 'Toy Story 5', release_date: '2026-06-17', genre_ids: [878] }],
        total_pages: 1,
      },
      '/movie/1022789/release_dates': {
        results: [
          { iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2026-06-17T00:00:00.000Z' }, { type: 4, release_date: '2026-09-20T00:00:00.000Z' }] },
        ],
      },
      '/genre/': GENRES,
    });

    const [film] = await p.getUpcomingMovies({ windowDays: 60, releaseTypes: ['digital'] });
    expect(film.releaseDates).toEqual([
      { releaseType: 'wide_theatrical', date: '2026-06-17', region: 'US', confidence: 0.9 },
      { releaseType: 'digital', date: '2026-09-20', region: 'US', confidence: 0.9 },
    ]);
  });

  it('keeps the primary date at LOW confidence when typed dates are unavailable', async () => {
    const { p } = provider({
      '/discover/movie': { results: [{ id: 7, title: 'Something', release_date: '2026-10-01', genre_ids: [] }], total_pages: 1 },
      '/genre/': GENRES,
    });
    const [film] = await p.getUpcomingMovies({ windowDays: 60 });
    // 'unknown' + 0.3: we know the film has A date, not that it is the one asked for.
    expect(film.releaseDates).toEqual([{ releaseType: 'unknown', date: '2026-10-01', confidence: 0.3 }]);
  });

  it('never invents a date from a malformed value', async () => {
    const { p } = provider({
      '/discover/movie': { results: [{ id: 8, title: 'Undated', release_date: '', genre_ids: [] }], total_pages: 1 },
      '/genre/': GENRES,
    });
    const [film] = await p.getUpcomingMovies({ windowDays: 60 });
    expect(film.releaseDates).toEqual([]);
    expect(film.year).toBeNull();
  });
});

describe('TmdbDiscoveryProvider — genres', () => {
  it('resolves genre ids to names so the category policy has something to match', async () => {
    const { p } = provider({
      '/discover/movie': { results: [{ id: 1, title: 'X', release_date: '2026-10-01', genre_ids: [878, 99] }], total_pages: 1 },
      '/genre/': GENRES,
    });
    const [film] = await p.getUpcomingMovies({ windowDays: 30 });
    expect(film.genres).toEqual(['Science Fiction', 'Documentary']);
  });

  /*
   * Caching an empty map after one failed call would strip every genre for the
   * life of the process, and a category policy seeing no categories quietly
   * ignores everything it should have matched.
   */
  it('does not cache an empty genre map after a failed lookup', async () => {
    let genreCalls = 0;
    const p = new TmdbDiscoveryProvider('k');
    (p as any).get = async (path: string) => {
      if (path.startsWith('/genre/')) {
        genreCalls++;
        return genreCalls === 1 ? null : GENRES;
      }
      return { results: [{ id: 1, title: 'X', release_date: '2026-10-01', genre_ids: [878] }], total_pages: 1 };
    };

    expect((await p.getUpcomingMovies({ windowDays: 30 }))[0].genres).toEqual([]);
    expect((await p.getUpcomingMovies({ windowDays: 30 }))[0].genres).toEqual(['Science Fiction']);
  });
});

describe('TmdbDiscoveryProvider — series', () => {
  it('uses first_air_date for NEW series', async () => {
    const { p, calls } = provider({ '/discover/tv': { results: [], total_pages: 1 }, '/genre/': GENRES });
    await p.getUpcomingSeries({ windowDays: 90 });
    expect(calls[0].params['first_air_date.gte']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /*
   * Returning series are already running, so a first-air-date window is exactly
   * the wrong filter — it would exclude every one of them.
   */
  it('uses /tv/on_the_air for RETURNING series, not a first-air-date window', async () => {
    const { p, calls } = provider({
      '/tv/on_the_air': { results: [{ id: 108978, name: 'Reacher', first_air_date: '2022-02-03', genre_ids: [878], origin_country: ['US'] }], total_pages: 1 },
      '/genre/': GENRES,
    });
    const [show] = await p.getReturningSeries({ windowDays: 30 });

    expect(calls[0].path).toBe('/tv/on_the_air');
    expect(calls[0].params['first_air_date.gte']).toBeUndefined();
    expect(show.title).toBe('Reacher');
    expect(show.releaseDates?.[0].releaseType).toBe('episode_air');
    expect(show.countries).toEqual(['US']);
  });
});

describe('TmdbDiscoveryProvider — bounds and safety', () => {
  it('stops at the last page rather than fetching the page cap', async () => {
    const { p, calls } = provider({ '/discover/movie': { results: [{ id: 1, title: 'A', release_date: '2026-10-01', genre_ids: [] }], total_pages: 1 }, '/genre/': GENRES });
    await p.getUpcomingMovies({ windowDays: 30 });
    expect(calls.filter((c) => c.path.startsWith('/discover/movie'))).toHaveLength(1);
  });

  it('honours the caller’s limit', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, title: `T${i}`, release_date: '2026-10-01', genre_ids: [] }));
    const { p } = provider({ '/discover/movie': { results: rows, total_pages: 9 }, '/genre/': GENRES });
    expect(await p.getUpcomingMovies({ windowDays: 30, limit: 5 })).toHaveLength(5);
  });

  it('reports unhealthy instead of throwing when TMDB rejects the key', async () => {
    const { p } = provider({});
    expect(await p.healthCheck()).toMatchObject({ healthy: false });
  });

  it('declares only the capabilities it implements', () => {
    const { p } = provider({});
    for (const cap of p.capabilities()) {
      expect(typeof (p as any)[`get${cap.split('_').map((s) => s[0].toUpperCase() + s.slice(1)).join('')}`] === 'function' || cap === 'details').toBe(true);
    }
    expect(p.capabilities()).not.toContain('upcoming_episodes');
  });
});

describe('TmdbDiscoveryProvider — confirming the window locally', () => {
  /*
   * TMDB evaluates `release_date.gte/lte` and `with_release_type` independently
   * unless a region pins them together, so the server-side filter alone is
   * evidence rather than a verdict. Measured live: a 60-day US digital query
   * returned *Spider-Man: No Way Home* (2021), which qualifies only on a French
   * TV airing.
   */
  const spider = {
    '/discover/movie': { results: [{ id: 634649, title: 'Spider-Man: No Way Home', release_date: '2021-12-15', genre_ids: [] }], total_pages: 1 },
    '/movie/634649/release_dates': {
      results: [{ iso_3166_1: 'FR', release_dates: [{ type: 6, release_date: '2026-09-06T00:00:00.000Z' }] }],
    },
    '/genre/': GENRES,
  };

  it('keeps a film whose confirmed date is in window when no region was asked for', async () => {
    const { p } = provider(spider);
    const out = await p.getUpcomingMovies({ windowDays: 60, releaseTypes: ['streaming'] });
    expect(out).toHaveLength(1);
  });

  it('drops it once the template scopes to a region it has no date in', async () => {
    const { p } = provider(spider);
    const out = await p.getUpcomingMovies({ windowDays: 60, releaseTypes: ['streaming'], regions: ['US'] });
    expect(out).toEqual([]);
  });

  it('drops a film whose only date of the wanted type is outside the window', async () => {
    const { p } = provider({
      '/discover/movie': { results: [{ id: 5, title: 'Old', release_date: '2019-01-01', genre_ids: [] }], total_pages: 1 },
      '/movie/5/release_dates': { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2019-04-01T00:00:00.000Z' }] }] },
      '/genre/': GENRES,
    });
    expect(await p.getUpcomingMovies({ windowDays: 60, releaseTypes: ['digital'] })).toEqual([]);
  });

  it('confirms nothing away when the caller asked for no particular release type', async () => {
    const { p } = provider({
      '/discover/movie': { results: [{ id: 5, title: 'Anything', release_date: '2026-10-01', genre_ids: [] }], total_pages: 1 },
      '/genre/': GENRES,
    });
    expect(await p.getUpcomingMovies({ windowDays: 60 })).toHaveLength(1);
  });
});
