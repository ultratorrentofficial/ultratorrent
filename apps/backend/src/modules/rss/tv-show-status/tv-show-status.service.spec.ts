import { TvShowStatusService } from './tv-show-status.service';
import type { ShowDetails, ShowSearchHit, TvShowStatusProvider } from './tv-show-status-provider';

function fakeProvider(
  name: string,
  hits: ShowSearchHit[],
  details: ShowDetails | null,
  confidence = 0.9,
): TvShowStatusProvider {
  return {
    name,
    getProviderCapabilities: () => ({
      name,
      canSearch: true,
      canStatus: true,
      canNextEpisode: name === 'tmdb',
      canLastEpisode: name === 'tmdb',
      confidence,
    }),
    searchShow: async () => hits,
    getShowStatus: async () => details?.originalStatus ?? null,
    getShowDetails: async () => details,
    getNextEpisode: async () => details?.nextEpisode ?? null,
    getLastEpisode: async () => details?.lastEpisode ?? null,
  };
}

function makeService(providers: TvShowStatusProvider[]) {
  const prisma = {
    tvShowStatus: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const settings = { get: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  const svc = new TvShowStatusService(
    prisma as never,
    settings as never,
    audit as never,
    realtime as never,
  );
  (svc as unknown as { buildProviders: () => Promise<TvShowStatusProvider[]> }).buildProviders =
    async () => providers;
  return { svc, prisma, audit, realtime };
}

const endedDetails: ShowDetails = {
  providerShowId: '42',
  title: 'Dead Show',
  originalStatus: 'Ended',
  firstAirDate: '2010-01-01',
  lastAirDate: '2014-05-18',
  nextEpisode: null,
  lastEpisode: { airDate: '2014-05-18', title: 'Finale' },
  totalSeasons: 5,
  totalEpisodes: 60,
  overview: 'x',
  posterUrl: 'https://image.tmdb.org/t/p/w342/x.jpg',
};

describe('TvShowStatusService.lookup', () => {
  it('normalizes an ended show and caches it', async () => {
    const { svc, prisma, audit, realtime } = makeService([
      fakeProvider('tmdb', [{ providerShowId: '42', title: 'Dead Show', year: 2010 }], endedDetails),
    ]);
    const r = await svc.lookup({ title: 'Dead Show' });
    expect(r.normalizedStatus).toBe('ended');
    expect(r.recommendation).toBe('not_recommended');
    expect(r.provider).toBe('tmdb');
    expect(r.nextEpisodeAirDate).toBeNull();
    expect(r.lastEpisodeTitle).toBe('Finale');
    expect(prisma.tvShowStatus.upsert).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'rss.show_status.lookup', result: 'success' }));
    expect(realtime.broadcast).toHaveBeenCalledWith('rss.show_status.lookup.completed', expect.anything());
  });

  it('falls through to the next provider when the first has no match', async () => {
    const { svc } = makeService([
      fakeProvider('tmdb', [], null),
      fakeProvider('imdb', [{ providerShowId: 'tt1', title: 'Dead Show', year: 2010 }], {
        ...endedDetails,
        providerShowId: 'tt1',
        originalStatus: null,
        endYear: 2014,
      }, 0.6),
    ]);
    const r = await svc.lookup({ title: 'Dead Show' });
    expect(r.provider).toBe('imdb');
    expect(r.normalizedStatus).toBe('ended');
  });

  it('returns an unknown result (no throw) when nothing matches', async () => {
    const { svc, realtime } = makeService([fakeProvider('tmdb', [], null)]);
    const r = await svc.lookup({ title: 'Nonexistent Show' });
    expect(r.normalizedStatus).toBe('unknown');
    expect(r.recommendation).toBe('unknown');
    expect(realtime.broadcast).toHaveBeenCalledWith('rss.show_status.lookup.completed', expect.anything());
  });
});
