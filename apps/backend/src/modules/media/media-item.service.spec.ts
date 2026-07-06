import { MediaItemService } from './media-item.service';

function make(total = 0, rows: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const count = jest.fn().mockResolvedValue(total);
  const prisma = { mediaItem: { findMany, count } };
  return { svc: new MediaItemService(prisma as any), findMany, count };
}

describe('MediaItemService.series (TV grouping)', () => {
  function makeSeries() {
    const groupBy = jest.fn().mockImplementation(({ by }: { by: string[] }) => {
      if (by.length === 1) {
        // distinct shows
        return Promise.resolve([
          { title: 'Interview with the Vampire', _count: { _all: 12 }, _max: { createdAt: new Date('2026-06-01') }, _min: { year: 2022 } },
          { title: 'Reginald the Vampire', _count: { _all: 20 }, _max: { createdAt: new Date('2026-05-01') }, _min: { year: 2022 } },
        ]);
      }
      // title + season
      return Promise.resolve([
        { title: 'Interview with the Vampire', season: 1, _count: { _all: 7 } },
        { title: 'Interview with the Vampire', season: 2, _count: { _all: 5 } },
        { title: 'Reginald the Vampire', season: 1, _count: { _all: 10 } },
        { title: 'Reginald the Vampire', season: 2, _count: { _all: 10 } },
      ]);
    });
    const findMany = jest.fn().mockResolvedValue([
      { title: 'Interview with the Vampire', artwork: [{ id: 'a1', url: 'http://x/p.jpg', localPath: null, type: 'poster', selected: true }] },
    ]);
    const prisma = { mediaItem: { groupBy, findMany, count: jest.fn() } };
    return { svc: new MediaItemService(prisma as any), groupBy };
  }

  it('returns one row per show with season + episode counts and a poster', async () => {
    const { svc } = makeSeries();
    const res = await svc.series({});
    expect(res).toMatchObject({ total: 2, page: 1, pageSize: 30 });
    const interview = res.items.find((s) => s.title === 'Interview with the Vampire')!;
    expect(interview).toMatchObject({ episodeCount: 12, seasonCount: 2, year: 2022 });
    expect(interview.poster).toMatchObject({ id: 'a1', type: 'poster' });
    // A show without a poster row falls back to null.
    expect(res.items.find((s) => s.title === 'Reginald the Vampire')!.poster).toBeNull();
  });

  it('filters to TV media types and honors matchStatus/library filters', async () => {
    const { svc, groupBy } = makeSeries();
    await svc.series({ matchStatus: 'unmatched', libraryId: 'lib1' });
    const where = groupBy.mock.calls[0][0].where;
    expect(where.mediaType).toEqual({ in: ['tv', 'anime', 'episode'] });
    expect(where).toMatchObject({ matchStatus: 'unmatched', libraryId: 'lib1' });
  });
});

describe('MediaItemService.list pagination', () => {
  it('defaults to page 1 / pageSize 60 and returns a paged envelope', async () => {
    const { svc, findMany } = make(28480, [{ id: 'a' }]);
    const res = await svc.list({});
    expect(res).toMatchObject({ total: 28480, page: 1, pageSize: 60 });
    expect(res.items).toEqual([{ id: 'a' }]);
    const arg = findMany.mock.calls[0][0];
    expect(arg.skip).toBe(0);
    expect(arg.take).toBe(60);
  });

  it('computes skip from the page number', async () => {
    const { svc, findMany } = make(1000);
    await svc.list({ page: 4, pageSize: 25 });
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 75, take: 25 });
  });

  it('caps pageSize at 200 and floors page/pageSize at sane minimums', async () => {
    const { svc, findMany } = make(1000);
    await svc.list({ page: 0, pageSize: 100000 });
    const arg = findMany.mock.calls[0][0];
    expect(arg.take).toBe(200);
    expect(arg.skip).toBe(0); // page floored to 1
  });

  it('builds a case-insensitive title search and passes filters through', async () => {
    const { svc, findMany, count } = make(3);
    await svc.list({ search: '  Matrix ', mediaType: 'movie', matchStatus: 'matched', libraryId: 'lib1' });
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      mediaType: 'movie',
      matchStatus: 'matched',
      libraryId: 'lib1',
      title: { contains: 'Matrix', mode: 'insensitive' },
    });
    // count and findMany share the same where (accurate total for the pager).
    expect(count.mock.calls[0][0].where).toEqual(where);
  });

  it('only narrows artwork to a single poster in the row includes', async () => {
    const { svc, findMany } = make(0);
    await svc.list({});
    const include = findMany.mock.calls[0][0].include;
    expect(include.artwork).toMatchObject({ where: { type: 'poster' }, take: 1 });
  });
});
