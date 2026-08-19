/**
 * An episode's metadata is the EPISODE's, not its series'.
 *
 * Measured on a live library before this: two consecutive episodes of the same
 * show carried an identical overview and an identical 5.833 rating, because the
 * only TV call the rich path made was `/tv/{id}`. The episode endpoint was
 * already known to work — `lookup()` has always used it for the episode name —
 * the enrichment simply never asked for it.
 */
import { TmdbMetadataProvider } from './metadata-provider';

const SERIES = {
  id: 42,
  name: 'Beyond the Gates',
  overview: 'A powerful family reigns over a posh gated community.',
  first_air_date: '2025-02-24',
  vote_average: 5.833,
  genres: [{ name: 'Soap' }],
  credits: { cast: [{ name: 'Regular Star', character: 'Lead' }], crew: [] },
  episode_run_time: [42],
};

const EPISODE = {
  id: 9001,
  name: 'The Reckoning',
  overview: 'Nicole confronts Ted about the will.',
  air_date: '2026-08-14',
  vote_average: 7.4,
  runtime: 41,
  guest_stars: [{ name: 'Guest Actor', character: 'Detective' }],
  crew: [{ name: 'Ep Director', job: 'Director' }],
};

function providerFor(calls: string[], episode: unknown = EPISODE) {
  const p = new TmdbMetadataProvider('key') as unknown as {
    get: (path: string, params: unknown) => Promise<unknown>;
    fetchDetails: (q: unknown) => Promise<Record<string, unknown> | null>;
  };
  p.get = async (path: string) => {
    calls.push(path);
    if (path === '/search/tv') return { results: [SERIES] };
    if (path === '/tv/42') return SERIES;
    if (path.startsWith('/tv/42/season/')) return episode;
    return null;
  };
  return p;
}

const query = { kind: 'tv' as const, title: 'Beyond the Gates', year: 2025, season: 2, episode: 148 };

describe('TMDB fetchDetails for one episode', () => {
  it('returns the episode’s own overview, air date, rating and runtime', async () => {
    const calls: string[] = [];
    const details = await providerFor(calls).fetchDetails(query);

    expect(calls).toContain('/tv/42/season/2/episode/148');
    expect(details).toMatchObject({
      title: 'The Reckoning',
      overview: 'Nicole confronts Ted about the will.',
      releaseDate: '2026-08-14',
      year: 2026,
      runtime: 41,
      rating: 7.4,
    });
  });

  it('keeps what genuinely belongs to the series', async () => {
    // Genres and the regular cast are true of every episode; dropping them to
    // make room for episode fields would lose information, not sharpen it.
    const details = await providerFor([]).fetchDetails(query);
    expect(details?.genres).toEqual(['Soap']);
    expect(details?.cast).toEqual(
      expect.arrayContaining([{ name: 'Regular Star', role: 'Lead' }]),
    );
  });

  it('appends guest stars rather than replacing the regulars', async () => {
    const details = await providerFor([]).fetchDetails(query);
    expect(details?.cast).toEqual(
      expect.arrayContaining([
        { name: 'Regular Star', role: 'Lead' },
        { name: 'Guest Actor', role: 'Detective' },
      ]),
    );
  });

  it('falls back to the series record when the episode call returns nothing', async () => {
    // Degrading to the series is what the caller had before; degrading to null
    // would lose metadata an episode already displays.
    const details = await providerFor([], null).fetchDetails(query);
    expect(details).toMatchObject({ title: 'Beyond the Gates', rating: 5.833 });
  });

  it('does not call the episode endpoint for a series-level query', async () => {
    const calls: string[] = [];
    await providerFor(calls).fetchDetails({ kind: 'tv', title: 'Beyond the Gates', year: 2025 });
    expect(calls.some((c) => c.includes('/season/'))).toBe(false);
  });

  it('treats an unrated episode as unrated, not as rated zero', async () => {
    const details = await providerFor([], { ...EPISODE, vote_average: 0 }).fetchDetails(query);
    expect(details?.rating).toBe(5.833);
  });
});

/**
 * `Magnum P.I.` is a 1980 series and a 2018 one. TMDB ranks by popularity, so a
 * title-only search returned the 1980 show for a folder plainly named
 * `Magnum P.I. (2018)` — and the refresh then wrote the wrong series over the
 * right one, on a library whose identity had already been corrected.
 */
describe('choosing between two series with the same name', () => {
  const OLD = { id: 1, name: 'Magnum, P.I.', overview: '1980', first_air_date: '1980-12-11' };
  const NEW = { id: 2, name: 'Magnum P.I.', overview: '2018', first_air_date: '2018-09-24' };

  function provider(byYear: Record<string, unknown[]>) {
    const calls: Array<Record<string, unknown>> = [];
    const p = new TmdbMetadataProvider('key') as unknown as {
      get: (path: string, params: Record<string, unknown>) => Promise<unknown>;
      fetchDetails: (q: unknown) => Promise<Record<string, unknown> | null>;
      fetchDetailsById: (id: string, q: unknown) => Promise<Record<string, unknown> | null>;
    };
    p.get = async (path: string, params: Record<string, unknown>) => {
      calls.push({ path, ...params });
      if (path === '/search/tv') {
        const year = String(params?.first_air_date_year ?? '');
        return { results: byYear[year] ?? byYear.any ?? [] };
      }
      if (path === '/tv/2') return NEW;
      if (path === '/tv/1') return OLD;
      return null;
    };
    return { p, calls };
  }

  it('asks with the year, so the 2018 series wins', async () => {
    const { p, calls } = provider({ '2018': [NEW], any: [OLD, NEW] });
    const details = await p.fetchDetails({ kind: 'tv', title: 'Magnum P.I.', year: 2018 });

    expect(calls[0]).toMatchObject({ path: '/search/tv', first_air_date_year: '2018' });
    expect(details).toMatchObject({ overview: '2018' });
  });

  it('falls back to the unfiltered search when the year matches nothing', async () => {
    // A year that excludes everything is worse than no year: reporting the show
    // as unknown loses more than an imperfect match.
    const { p } = provider({ '1999': [], any: [OLD] });
    const details = await p.fetchDetails({ kind: 'tv', title: 'Magnum P.I.', year: 1999 });
    expect(details).toMatchObject({ overview: '1980' });
  });

  it('skips search entirely when the id is already known', async () => {
    // An id is an answer; a title is a question. A corrected library must not
    // have its answer re-litigated by a popularity ranking.
    const { p, calls } = provider({ any: [OLD] });
    const details = await p.fetchDetailsById('2', { kind: 'tv', title: 'Magnum P.I.', year: 2018 });

    expect(details).toMatchObject({ overview: '2018' });
    expect(calls.some((c) => c.path === '/search/tv')).toBe(false);
  });
});
