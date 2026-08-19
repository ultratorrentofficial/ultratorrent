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
