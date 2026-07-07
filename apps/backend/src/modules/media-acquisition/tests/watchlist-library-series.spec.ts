import { AcquisitionWatchlistService } from '../watchlist.service';

function build() {
  const prisma = {
    mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
    mediaLibrary: { findMany: jest.fn().mockResolvedValue([{ path: '/tv' }]) },
    mediaAcquisitionWatchlistItem: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: any) => ({ id: 'w_' + data.title, ...data })),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  const svc = new AcquisitionWatchlistService(prisma as any, audit as any, realtime as any);
  return { svc, prisma };
}

const item = (over: Partial<{ title: string; year: number | null; path: string; seriesImdbId: string | null; ext: string | null }>) => ({
  title: over.title ?? 'Ep',
  year: over.year ?? null,
  path: over.path ?? '/tv/Show/Season 01/ep.mkv',
  seriesImdbId: over.seriesImdbId ?? null,
  externalIds: over.ext ? [{ externalId: over.ext }] : [],
});

describe('AcquisitionWatchlistService.librarySeries', () => {
  it('groups episodes of one folder-organised show into a single row (9-1-1 regression)', async () => {
    const { svc, prisma } = build();
    // Three episodes whose parsed titles are the *episode* names, all under the
    // same "9-1-1 (2018)" show folder across two seasons.
    prisma.mediaItem.findMany.mockResolvedValue([
      item({ title: 'The Searchers', year: 2021, path: '/tv/9-1-1 (2018)/Season 05/The Searchers.mkv', seriesImdbId: 'tt7587890' }),
      item({ title: 'Ohana', year: 2021, path: '/tv/9-1-1 (2018)/Season 05/Ohana.mkv' }),
      item({ title: 'Pilot', year: 2018, path: '/tv/9-1-1 (2018)/Season 01/Pilot.mkv', ext: 'tt-episode' }),
    ]);

    const rows = await svc.librarySeries();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '9-1-1',           // clean folder title, parenthesised year stripped
      year: 2018,               // earliest year across the group
      episodeCount: 3,
      imdbId: 'tt7587890',      // resolved seriesImdbId preferred over the episode ext id
      monitorable: true,
      onWatchlist: false,
    });
  });

  it('falls back to an episode external imdb id when no seriesImdbId exists', async () => {
    const { svc, prisma } = build();
    prisma.mediaItem.findMany.mockResolvedValue([
      item({ title: 'Ep1', path: '/tv/Some Show/Season 01/Ep1.mkv', ext: 'tt12345' }),
      item({ title: 'Ep2', path: '/tv/Some Show/Season 01/Ep2.mkv' }),
    ]);
    const rows = await svc.librarySeries();
    expect(rows[0]).toMatchObject({ title: 'Some Show', imdbId: 'tt12345', monitorable: true, episodeCount: 2 });
  });

  it('marks a show with no resolvable id as not monitorable', async () => {
    const { svc, prisma } = build();
    prisma.mediaItem.findMany.mockResolvedValue([
      item({ title: 'ep', path: '/tv/Mystery Show/Season 01/ep.mkv' }),
    ]);
    const rows = await svc.librarySeries();
    expect(rows[0]).toMatchObject({ title: 'Mystery Show', imdbId: null, monitorable: false, year: null });
  });

  it('flags shows already on the watchlist (by normalized title)', async () => {
    const { svc, prisma } = build();
    prisma.mediaItem.findMany.mockResolvedValue([
      item({ title: 'ep', path: '/tv/9-1-1 (2018)/Season 01/ep.mkv', seriesImdbId: 'tt1' }),
    ]);
    prisma.mediaAcquisitionWatchlistItem.findMany.mockResolvedValue([{ normalizedTitle: '9-1-1' }]);
    const rows = await svc.librarySeries();
    expect(rows[0]).toMatchObject({ title: '9-1-1', onWatchlist: true });
  });

  it('falls back to the parsed title for a loose file at a library root', async () => {
    const { svc, prisma } = build();
    // No show folder — the file sits directly in the "/tv" library root, so its
    // own parsed title (the series, for an SxxExx name) is the group key.
    prisma.mediaItem.findMany.mockResolvedValue([
      item({ title: 'The Rookie', year: 2018, path: '/tv/The Rookie.mkv', seriesImdbId: 'tt7587890' }),
    ]);
    const rows = await svc.librarySeries();
    expect(rows[0]).toMatchObject({ title: 'The Rookie', year: 2018, imdbId: 'tt7587890', episodeCount: 1 });
  });

  it('applies the search filter to the resolved series title', async () => {
    const { svc, prisma } = build();
    prisma.mediaItem.findMany.mockResolvedValue([
      item({ title: 'a', path: '/tv/9-1-1 (2018)/Season 01/a.mkv' }),
      item({ title: 'b', path: '/tv/The Rookie (2018)/Season 01/b.mkv' }),
    ]);
    const rows = await svc.librarySeries('rookie');
    expect(rows.map((r) => r.title)).toEqual(['The Rookie']);
  });

  it('returns [] with no shows (no library query)', async () => {
    const { svc, prisma } = build();
    const rows = await svc.librarySeries();
    expect(rows).toEqual([]);
    expect(prisma.mediaLibrary.findMany).not.toHaveBeenCalled();
  });
});

describe('AcquisitionWatchlistService.bulkCreate', () => {
  it('adds new series, skips ones already on the watchlist and blanks', async () => {
    const { svc, prisma } = build();
    prisma.mediaAcquisitionWatchlistItem.findMany.mockResolvedValue([{ normalizedTitle: 'the rookie' }]);

    const res = await svc.bulkCreate([
      { title: 'The Rookie', year: 2018, imdbId: 'tt7587890' }, // dup
      { title: 'New Show', year: 2020, imdbId: 'tt1' },
      { title: '   ', imdbId: 'tt2' }, // blank
    ]);

    expect(res).toEqual({ added: 1, skipped: 2 });
    expect(prisma.mediaAcquisitionWatchlistItem.create).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAcquisitionWatchlistItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'series', title: 'New Show', externalIds: { imdb: 'tt1' } }),
      }),
    );
  });

  it('adds a series with no IMDb id (externalIds undefined)', async () => {
    const { svc, prisma } = build();
    await svc.bulkCreate([{ title: 'No Id Show' }]);
    expect(prisma.mediaAcquisitionWatchlistItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'No Id Show', externalIds: undefined }) }),
    );
  });
});
