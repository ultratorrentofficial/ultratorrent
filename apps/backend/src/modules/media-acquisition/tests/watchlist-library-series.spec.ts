import { AcquisitionWatchlistService } from '../watchlist.service';

function build() {
  const prisma = {
    mediaItem: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    mediaExternalId: { findMany: jest.fn().mockResolvedValue([]) },
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

describe('AcquisitionWatchlistService.librarySeries', () => {
  it('resolves a per-series IMDb id (seriesImdbId preferred, external id fallback) + flags', async () => {
    const { svc, prisma } = build();
    prisma.mediaItem.groupBy.mockResolvedValue([
      { title: 'Foo', _count: { _all: 5 }, _min: { year: 2020 } },
      { title: 'The Rookie', _count: { _all: 144 }, _min: { year: 2018 } },
    ]);
    prisma.mediaItem.findMany.mockResolvedValue([{ title: 'Foo', seriesImdbId: 'tt999' }]); // resolved id
    prisma.mediaExternalId.findMany.mockResolvedValue([
      { externalId: 'tt7587890', item: { title: 'The Rookie' } }, // fallback id
    ]);
    prisma.mediaAcquisitionWatchlistItem.findMany.mockResolvedValue([{ normalizedTitle: 'foo' }]);

    const rows = await svc.librarySeries();

    const foo = rows.find((r) => r.title === 'Foo')!;
    const rookie = rows.find((r) => r.title === 'The Rookie')!;
    expect(foo).toMatchObject({ imdbId: 'tt999', monitorable: true, onWatchlist: true, episodeCount: 5 });
    expect(rookie).toMatchObject({ imdbId: 'tt7587890', monitorable: true, onWatchlist: false, year: 2018 });
  });

  it('marks a series with no resolvable id as not monitorable', async () => {
    const { svc, prisma } = build();
    prisma.mediaItem.groupBy.mockResolvedValue([{ title: 'Mystery Show', _count: { _all: 3 }, _min: { year: null } }]);
    const rows = await svc.librarySeries();
    expect(rows[0]).toMatchObject({ imdbId: null, monitorable: false, year: null });
  });

  it('returns [] with no shows (no extra queries)', async () => {
    const { svc, prisma } = build();
    const rows = await svc.librarySeries();
    expect(rows).toEqual([]);
    expect(prisma.mediaExternalId.findMany).not.toHaveBeenCalled();
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
