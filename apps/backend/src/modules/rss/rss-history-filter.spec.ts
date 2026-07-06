import { RssService } from './rss.module';

/**
 * Verifies RSS feed-history filtering: the status filter narrows the list, the
 * search narrows both list and count tiles, and the tiles stay scoped to the
 * search only (never the status) so they keep the full breakdown.
 */
describe('RssService.history filtering', () => {
  function make() {
    const rssHistory = {
      findMany: jest.fn().mockResolvedValue([{ id: 'a' }]),
      count: jest.fn(),
    };
    const prisma = {
      rssHistory,
      $transaction: (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
    };
    const svc = new RssService(prisma as never, undefined as never);
    return { svc, rssHistory };
  }

  // Order of the $transaction array: [findMany, count(list), count(search),
  // count(downloaded), count(matchedOnly)].
  const primeCounts = (rssHistory: { count: jest.Mock }) =>
    rssHistory.count
      .mockResolvedValueOnce(4) // list total (status+search)
      .mockResolvedValueOnce(10) // grand total (search only)
      .mockResolvedValueOnce(3) // downloaded
      .mockResolvedValueOnce(2); // matched-only

  it('maps status=downloaded and applies search to the list query', async () => {
    const { svc, rssHistory } = make();
    primeCounts(rssHistory);
    await svc.history('feed1', 1, 25, { status: 'downloaded', search: '  Vampire ' });
    expect(rssHistory.findMany.mock.calls[0][0].where).toEqual({
      feedId: 'feed1',
      title: { contains: 'Vampire', mode: 'insensitive' },
      downloaded: true,
    });
  });

  it('maps status=matched and status=seen to mutually-exclusive buckets', async () => {
    const m = make();
    primeCounts(m.rssHistory);
    await m.svc.history('f', 1, 25, { status: 'matched' });
    expect(m.rssHistory.findMany.mock.calls[0][0].where).toEqual({
      feedId: 'f',
      matched: true,
      downloaded: false,
    });

    const s = make();
    primeCounts(s.rssHistory);
    await s.svc.history('f', 1, 25, { status: 'seen' });
    expect(s.rssHistory.findMany.mock.calls[0][0].where).toEqual({
      feedId: 'f',
      matched: false,
      downloaded: false,
    });
  });

  it('scopes the count tiles to the search but NOT the status filter', async () => {
    const { svc, rssHistory } = make();
    primeCounts(rssHistory);
    const res = await svc.history('f', 1, 25, { status: 'downloaded', search: 'x' });

    // grand-total + per-status counts must omit the `downloaded` status clause.
    const searchOnly = { feedId: 'f', title: { contains: 'x', mode: 'insensitive' } };
    expect(rssHistory.count.mock.calls[1][0].where).toEqual(searchOnly);
    expect(rssHistory.count.mock.calls[2][0].where).toEqual({ ...searchOnly, downloaded: true });
    expect(rssHistory.count.mock.calls[3][0].where).toEqual({
      ...searchOnly,
      matched: true,
      downloaded: false,
    });

    expect(res.total).toBe(4); // status+search filtered (pagination)
    expect(res.counts).toEqual({ total: 10, downloaded: 3, matched: 2, seen: 5 });
  });

  it('applies no title/status clause when unfiltered', async () => {
    const { svc, rssHistory } = make();
    primeCounts(rssHistory);
    await svc.history('f');
    expect(rssHistory.findMany.mock.calls[0][0].where).toEqual({ feedId: 'f' });
  });
});
