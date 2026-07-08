import { MediaItemService } from './media-item.service';

function make(total = 0, rows: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const count = jest.fn().mockResolvedValue(total);
  const prisma = { mediaItem: { findMany, count } };
  return { svc: new MediaItemService(prisma as any), findMany, count };
}

import { decodeSeriesKey } from './series-grouping';

describe('MediaItemService.series (folder-based TV grouping)', () => {
  // Two episodes of one folder-organised show whose *titles* are the episode
  // names (the fragmentation trap), plus a loose file at a library root.
  const ROWS = [
    { id: 'e1', title: 'Pilot',        year: null, season: 1, seriesImdbId: 'tt7235466', createdAt: new Date('2026-05-01'), path: '/tv/9-1-1 (2018)/Season 1/9-1-1 - S01E01.mkv' },
    { id: 'e2', title: 'Let Go',       year: null, season: 1, seriesImdbId: null,         createdAt: new Date('2026-05-03'), path: '/tv/9-1-1 (2018)/Season 1/9-1-1 - S01E02.mkv' },
    { id: 'e3', title: 'Next of Kin',  year: null, season: 2, seriesImdbId: null,         createdAt: new Date('2026-05-05'), path: '/tv/9-1-1 (2018)/Season 2/9-1-1 - S02E01.mkv' },
    { id: 'x1', title: 'Loose Show',   year: 2020, season: 1, seriesImdbId: null,         createdAt: new Date('2026-05-02'), path: '/tv/Loose Show - S01E01.mkv' },
  ];
  function makeSeries(rows = ROWS, posters: any[] = []) {
    const prisma = {
      mediaItem: { findMany: jest.fn().mockResolvedValue(rows), count: jest.fn() },
      mediaLibrary: { findMany: jest.fn().mockResolvedValue([{ path: '/tv' }]) },
      mediaArtwork: { findMany: jest.fn().mockResolvedValue(posters) },
    };
    return { svc: new MediaItemService(prisma as any), prisma };
  }

  it('collapses episode-titled files into ONE show by folder — never per-episode rows', async () => {
    const { svc } = makeSeries();
    const res = await svc.series({});
    // Two shows total: the 9-1-1 folder (3 eps) + the loose-root file.
    expect(res.total).toBe(2);
    const show = res.items.find((s) => s.title === '9-1-1')!;
    expect(show).toMatchObject({ title: '9-1-1', year: 2018, episodeCount: 3, seasonCount: 2, seriesImdbId: 'tt7235466' });
    // The episode titles ("Pilot"/"Let Go"/"Next of Kin") must NOT appear as shows.
    expect(res.items.some((s) => ['Pilot', 'Let Go', 'Next of Kin'].includes(s.title))).toBe(false);
    // The show key round-trips to the folder for episode fetching.
    expect(decodeSeriesKey(show.key)).toEqual({ kind: 'dir', value: '/tv/9-1-1 (2018)' });
  });

  it('falls back to title grouping for files directly at a library root', async () => {
    const { svc } = makeSeries();
    const res = await svc.series({});
    const loose = res.items.find((s) => s.title === 'Loose Show')!;
    expect(loose).toMatchObject({ episodeCount: 1 });
    expect(decodeSeriesKey(loose.key)).toEqual({ kind: 'title', value: 'Loose Show' });
  });

  it('attaches one poster per show from any of its items', async () => {
    const { svc } = makeSeries(ROWS, [{ itemId: 'e2', id: 'a1', url: 'http://x/p.jpg', localPath: null, type: 'poster', selected: true }]);
    const res = await svc.series({});
    expect(res.items.find((s) => s.title === '9-1-1')!.poster).toMatchObject({ id: 'a1', type: 'poster' });
  });

  it('filters to TV media types on the item query', async () => {
    const { svc, prisma } = makeSeries();
    await svc.series({ matchStatus: 'unmatched', libraryId: 'lib1' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.mediaType).toEqual({ in: ['tv', 'anime', 'episode'] });
    expect(where).toMatchObject({ matchStatus: 'unmatched', libraryId: 'lib1' });
  });
});

describe('MediaItemService.episodesForSeries', () => {
  function make(episodes: any[]) {
    const findMany = jest.fn().mockResolvedValue(episodes);
    const prisma = { mediaItem: { findMany } };
    return { svc: new MediaItemService(prisma as any), findMany };
  }
  const key = Buffer.from('dir:/tv/9-1-1 (2018)', 'utf8').toString('base64url');

  it('queries by the folder path prefix and groups episodes into ordered seasons (specials last)', async () => {
    const eps = [
      { id: 'e1', season: 1, episode: 1, artwork: [] },
      { id: 'e2', season: 1, episode: 2, artwork: [{ type: 'season_poster', seasonNumber: 1, id: 'sp1' }] },
      { id: 'e3', season: 2, episode: 1, artwork: [] },
      { id: 'e0', season: 0, episode: 1, artwork: [] }, // special → last
    ];
    const { svc, findMany } = make(eps);
    const res = await svc.episodesForSeries(key);
    expect(findMany.mock.calls[0][0].where.path).toEqual({ startsWith: '/tv/9-1-1 (2018)/' });
    expect(res.seasons.map((s) => s.seasonNumber)).toEqual([1, 2, 0]);
    expect(res.seasons[0]).toMatchObject({ seasonNumber: 1, episodeCount: 2 });
    expect(res.seasons[0].poster).toMatchObject({ type: 'season_poster' });
  });

  it('rejects a malformed key', async () => {
    const { svc } = make([]);
    await expect(svc.episodesForSeries('!!!not-base64!!!')).rejects.toThrow(/invalid series key/i);
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
