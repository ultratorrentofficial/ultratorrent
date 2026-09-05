import { TvmazeDiscoveryProvider } from './tvmaze-discovery.provider';

/** Fixtures follow the real `/schedule/full` shape: the show is EMBEDDED. */
const show = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  status: 'Running',
  genres: ['Drama'],
  language: 'English',
  premiered: '2024-01-01',
  externals: { thetvdb: null, imdb: null },
  rating: { average: 7.5 },
  ...over,
});
const ep = (airdate: string, season: number, number: number, s: any) => ({
  airdate,
  season,
  number,
  _embedded: { show: s },
});

/** Builds a provider whose schedule fetch is the given fixture. */
function provider(rows: any[]) {
  const p = new TvmazeDiscoveryProvider();
  let fetches = 0;
  (p as any).schedule = async () => {
    fetches++;
    return rows;
  };
  return { p, fetches: () => fetches };
}

const soon = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('TvmazeDiscoveryProvider — slicing the schedule', () => {
  it('treats S1E1 as a SERIES premiere', async () => {
    const { p } = provider([ep(soon(10), 1, 1, show(1, 'Brand New Show'))]);
    const out = await p.getUpcomingSeries({ windowDays: 30 });
    expect(out.map((r) => r.title)).toEqual(['Brand New Show']);
    expect(out[0].releaseDates?.[0].releaseType).toBe('series_premiere');
  });

  it('treats episode 1 of a later season as a SEASON premiere, not a series one', async () => {
    const { p } = provider([ep(soon(10), 4, 1, show(2, 'Returning Show'))]);
    expect(await p.getUpcomingSeries({ windowDays: 30 })).toEqual([]);
    const seasons = await p.getUpcomingSeasons({ windowDays: 30 });
    expect(seasons.map((r) => r.title)).toEqual(['Returning Show']);
    expect(seasons[0].releaseDates?.[0].releaseType).toBe('season_premiere');
  });

  it('excludes anything outside the window', async () => {
    const { p } = provider([ep(soon(200), 1, 1, show(3, 'Far Future'))]);
    expect(await p.getUpcomingSeries({ windowDays: 30 })).toEqual([]);
  });

  /*
   * The reason this matters: a daily programme contributes one episode per day.
   * Over a 90-day window that is ninety rows all saying the same thing.
   */
  it('collapses a daily programme to ONE row at its earliest airing', async () => {
    const daily = show(9697, 'Bloomberg Daybreak: Europe', { genres: [] });
    const { p } = provider([
      ep(soon(3), 2026, 144, daily),
      ep(soon(1), 2026, 142, daily),
      ep(soon(2), 2026, 143, daily),
    ]);
    const out = await p.getUpcomingEpisodes({ windowDays: 30 });
    expect(out).toHaveLength(1);
    expect(out[0].releaseDates?.[0].date).toBe(soon(1));
  });

  it('reports an empty genre list faithfully rather than inventing one', async () => {
    const { p } = provider([ep(soon(5), 2026, 144, show(9697, 'CBS News 24/7', { genres: [] }))]);
    // The category policy decides what to do with this; the provider does not
    // pre-filter, and must not pretend a genre exists.
    expect((await p.getUpcomingEpisodes({ windowDays: 30 }))[0].genres).toEqual([]);
  });

  it('excludes an ENDED show from returning series even when it is scheduled', async () => {
    const { p } = provider([
      ep(soon(5), 3, 2, show(4, 'Repeat Airing', { status: 'Ended' })),
      ep(soon(5), 3, 2, show(5, 'Still Going', { status: 'Running' })),
    ]);
    expect((await p.getReturningSeries({ windowDays: 30 })).map((r) => r.title)).toEqual(['Still Going']);
  });

  it('honours the caller’s limit', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ep(soon(2), 1, 1, show(100 + i, `Show ${i}`)));
    const { p } = provider(rows);
    expect(await p.getUpcomingSeries({ windowDays: 30, limit: 3 })).toHaveLength(3);
  });
});

describe('TvmazeDiscoveryProvider — mapping', () => {
  it('carries every external id it has, and omits the ones it does not', async () => {
    const { p } = provider([
      ep(soon(5), 1, 1, show(42, 'With Ids', { externals: { thetvdb: 12345, imdb: 'tt999' } })),
      ep(soon(5), 1, 1, show(43, 'No Ids', { externals: { thetvdb: null, imdb: null } })),
    ]);
    const [a, b] = await p.getUpcomingSeries({ windowDays: 30 });
    expect(a.externalIds).toEqual({ tvmaze: '42', tvdb: '12345', imdb: 'tt999' });
    // TVmaze's own id is the only stable identity for most shows — enough to key
    // a record, not enough to auto-monitor on.
    expect(b.externalIds).toEqual({ tvmaze: '43' });
  });

  it('normalizes status into the vocabulary TvShowStatus already uses', async () => {
    const { p } = provider([
      ep(soon(5), 1, 1, show(1, 'A', { status: 'Running' })),
      ep(soon(5), 1, 1, show(2, 'B', { status: 'In Development' })),
      ep(soon(5), 1, 1, show(3, 'C', { status: 'Ended' })),
      ep(soon(5), 1, 1, show(4, 'D', { status: 'Weird New Value' })),
    ]);
    const out = await p.getUpcomingSeries({ windowDays: 30 });
    expect(out.map((r) => r.seriesStatus)).toEqual(['continuing', 'planned', 'ended', 'unknown']);
  });

  it('strips the HTML out of a summary rather than storing markup', async () => {
    const { p } = provider([
      ep(soon(5), 1, 1, show(1, 'X', { summary: '<p><b>X</b> is a show &amp; more.</p>' })),
    ]);
    expect((await p.getUpcomingSeries({ windowDays: 30 }))[0].overview).toBe('X is a show & more.');
  });

  it('prefers the web channel as the streaming service and falls back for the network', async () => {
    const { p } = provider([
      ep(soon(5), 1, 1, show(1, 'Streamer', { network: null, webChannel: { name: 'Peacock' } })),
    ]);
    const [r] = await p.getUpcomingSeries({ windowDays: 30 });
    expect(r.streamingService).toBe('Peacock');
    expect(r.network).toBe('Peacock');
  });

  it('never invents a date from a missing airdate', async () => {
    const { p } = provider([{ airdate: null, season: 1, number: 1, _embedded: { show: show(1, 'Undated') } }]);
    expect(await p.getUpcomingSeries({ windowDays: 30 })).toEqual([]);
  });
});

describe('TvmazeDiscoveryProvider — capabilities', () => {
  it('does not claim movies, trending or popular', () => {
    const caps = new TvmazeDiscoveryProvider().capabilities();
    expect(caps).not.toContain('upcoming_movies');
    expect(caps).not.toContain('trending');
    expect(caps).not.toContain('popular');
    expect(caps).toEqual(
      expect.arrayContaining(['upcoming_series', 'upcoming_seasons', 'returning_series']),
    );
  });
});

describe('TvmazeDiscoveryProvider — locale', () => {
  /*
   * `/schedule/full` is global: 3,430 English rows against 541 Chinese, 384
   * Japanese and 214 Russian on the live feed. An unfiltered 90-day premiere
   * slice came back almost entirely non-English, so a template scoped to
   * English/US would have been handed Russian, Thai and Turkish daily
   * programming.
   */
  const mixed = [
    ep(soon(5), 1, 1, show(1, 'English US', { language: 'English', network: { name: 'PBS', country: { code: 'US' } } })),
    ep(soon(5), 1, 1, show(2, 'English GB', { language: 'English', network: { name: 'ITV1', country: { code: 'GB' } } })),
    ep(soon(5), 1, 1, show(3, 'Russian', { language: 'Russian', network: { name: 'ТВ Центр', country: { code: 'RU' } } })),
    ep(soon(5), 1, 1, show(4, 'Turkish', { language: 'Turkish', network: { name: 'ATV', country: { code: 'TR' } } })),
  ];

  it('filters by language, matching an ISO code against TVmaze’s English words', async () => {
    const { p } = provider(mixed);
    const out = await p.getUpcomingSeries({ windowDays: 30, languages: ['en'] });
    expect(out.map((r) => r.title)).toEqual(['English US', 'English GB']);
  });

  it('accepts the language spelled out, as TVmaze itself spells it', async () => {
    const { p } = provider(mixed);
    expect((await p.getUpcomingSeries({ windowDays: 30, languages: ['English'] }))).toHaveLength(2);
  });

  it('filters by the network’s country', async () => {
    const { p } = provider(mixed);
    const out = await p.getUpcomingSeries({ windowDays: 30, regions: ['US'] });
    expect(out.map((r) => r.title)).toEqual(['English US']);
  });

  /*
   * A web-only show has no network and therefore no country. Excluding it for
   * lacking a field it was never going to have would silently drop streaming
   * premieres — the ones a template is most likely to want.
   */
  it('does not exclude a web-only show for having no country', async () => {
    const { p } = provider([
      ep(soon(5), 1, 1, show(9, 'Streaming Only', { language: 'English', network: null, webChannel: { name: 'Peacock' } })),
    ]);
    expect((await p.getUpcomingSeries({ windowDays: 30, regions: ['US'] }))).toHaveLength(1);
  });

  it('returns everything when the template named no locale', async () => {
    const { p } = provider(mixed);
    expect(await p.getUpcomingSeries({ windowDays: 30 })).toHaveLength(4);
  });

  it('drops a show whose language TVmaze does not state, when a language was required', async () => {
    const { p } = provider([ep(soon(5), 1, 1, show(1, 'Unknown Lang', { language: null }))]);
    expect(await p.getUpcomingSeries({ windowDays: 30, languages: ['en'] })).toEqual([]);
  });
});
