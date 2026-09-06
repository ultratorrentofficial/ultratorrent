import { DiscoveryWatchlistService, type LinkableMedia } from './discovery-watchlist.service';

const media = (over: Partial<LinkableMedia> = {}): LinkableMedia => ({
  id: 'dm1',
  mediaType: 'tv',
  title: 'Silo',
  year: 2023,
  externalIds: { imdb: 'tt14688458', tmdb: '125988' },
  ...over,
});

function harness(existing?: any) {
  const prisma = {
    mediaAcquisitionWatchlistItem: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (!existing) return null;
        // Mimic the two lookup shapes: by id filters, or by normalized title.
        if (where.OR && where.OR[0]?.externalIds) {
          const stored = (existing.externalIds ?? {}) as Record<string, string>;
          const hit = where.OR.some((f: any) => stored[f.externalIds.path[0]] === f.externalIds.equals);
          return hit ? existing : null;
        }
        if (where.normalizedTitle) {
          return existing.normalizedTitle === where.normalizedTitle ? existing : null;
        }
        return null;
      }),
    },
  };
  const watchlist = {
    create: jest.fn(async (input: any, _userId?: string) => ({ id: 'w1', ...input })),
    update: jest.fn(async (_id: string, _patch: any, _userId?: string) => ({ id: existing?.id ?? 'w1' })),
  };
  return { svc: new DiscoveryWatchlistService(prisma as any, watchlist as any), watchlist, prisma };
}

describe('creating an entry', () => {
  it('goes through the watchlist service, never the table', async () => {
    const { svc, watchlist } = harness();
    const r = await svc.linkOrCreate(media(), { targetLibraryId: 'lib-tv' });

    expect(r.outcome).toBe('created');
    expect(watchlist.create).toHaveBeenCalledTimes(1);
    expect(watchlist.create.mock.calls[0][0]).toMatchObject({
      type: 'series',
      title: 'Silo',
      year: 2023,
      externalIds: { imdb: 'tt14688458', tmdb: '125988' },
      targetLibraryId: 'lib-tv',
    });
  });

  it('records where the entry came from', async () => {
    const { svc, watchlist } = harness();
    await svc.linkOrCreate(media());
    expect(watchlist.create.mock.calls[0][0].settings).toEqual({
      discoveredMediaId: 'dm1',
      createdByDiscovery: true,
    });
  });

  it('monitors episodic media as a whole series, not an episode', async () => {
    const { svc } = harness();
    expect(svc.watchlistType('tv')).toBe('series');
    expect(svc.watchlistType('movie')).toBe('movie');
  });
});

describe('not creating a second entry', () => {
  it('reuses an entry that shares an external id', async () => {
    const { svc, watchlist } = harness({
      id: 'w-existing',
      status: 'active',
      externalIds: { imdb: 'tt14688458' },
      rssRuleId: null,
      normalizedTitle: 'silo',
    });
    const r = await svc.linkOrCreate(media());

    expect(r.watchlistItemId).toBe('w-existing');
    expect(watchlist.create).not.toHaveBeenCalled();
  });

  /*
   * The two tables normalize titles DIFFERENTLY: the watchlist stores
   * `toLowerCase().trim()`, discovery stores the punctuation-stripped form.
   * Comparing the columns directly would miss every title with punctuation.
   */
  it('finds a hand-added entry by title even though the two tables normalize differently', async () => {
    const { svc, watchlist } = harness({
      id: 'w-manual',
      status: 'active',
      externalIds: {},
      rssRuleId: null,
      normalizedTitle: 'sila: the life within everything',
    });
    const r = await svc.linkOrCreate(
      media({ title: 'SILA: The Life Within Everything', externalIds: {}, year: null }),
    );

    expect(r.watchlistItemId).toBe('w-manual');
    expect(watchlist.create).not.toHaveBeenCalled();
  });

  it('adds only the ids the entry was missing', async () => {
    const { svc, watchlist } = harness({
      id: 'w1',
      status: 'active',
      externalIds: { imdb: 'tt14688458' },
      rssRuleId: null,
      normalizedTitle: 'silo',
    });
    const r = await svc.linkOrCreate(media());

    expect(r.outcome).toBe('updated');
    const patch = watchlist.update.mock.calls[0][1];
    expect(patch.externalIds).toEqual({ imdb: 'tt14688458', tmdb: '125988' });
    // Nothing an operator may have customised is sent.
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('priority');
    expect(patch).not.toHaveProperty('profileId');
    expect(patch).not.toHaveProperty('targetLibraryId');
  });

  it('does nothing at all when there is nothing to add', async () => {
    const { svc, watchlist } = harness({
      id: 'w1',
      status: 'active',
      externalIds: { imdb: 'tt14688458', tmdb: '125988' },
      rssRuleId: 'r1',
      normalizedTitle: 'silo',
    });
    const r = await svc.linkOrCreate(media(), { rssRuleId: 'r1' });

    expect(r.outcome).toBe('unchanged');
    expect(watchlist.update).not.toHaveBeenCalled();
  });
});

describe('never overruling the operator', () => {
  /*
   * `paused`, `archived` and `completed` are decisions somebody made. A
   * six-hourly sweep that undid them would be indistinguishable from a bug.
   */
  for (const status of ['paused', 'archived', 'completed']) {
    it(`leaves a ${status} entry ${status}`, async () => {
      const { svc, watchlist } = harness({
        id: 'w1',
        status,
        externalIds: { imdb: 'tt14688458' },
        rssRuleId: null,
        normalizedTitle: 'silo',
      });
      const r = await svc.linkOrCreate(media());

      expect(r.note).toMatch(new RegExp(status));
      // It still gains the id it was missing — that is information, not a decision.
      expect(watchlist.update.mock.calls[0][1]).toHaveProperty('externalIds');
      expect(watchlist.update.mock.calls[0][1]).not.toHaveProperty('status');
    });
  }

  it('explains an untouched decided entry rather than reporting silence', async () => {
    const { svc } = harness({
      id: 'w1',
      status: 'archived',
      externalIds: { imdb: 'tt14688458', tmdb: '125988' },
      rssRuleId: null,
      normalizedTitle: 'silo',
    });
    const r = await svc.linkOrCreate(media());
    expect(r.outcome).toBe('unchanged');
    expect(r.note).toMatch(/archived — left as it is/);
  });

  /*
   * An entry already pointing at a rule is pointing at one somebody chose.
   */
  it('attaches a generated rule but never replaces an existing one', async () => {
    const attach = harness({ id: 'w1', status: 'active', externalIds: { imdb: 'tt14688458', tmdb: '125988' }, rssRuleId: null, normalizedTitle: 'silo' });
    await attach.svc.linkOrCreate(media(), { rssRuleId: 'generated-1' });
    expect(attach.watchlist.update.mock.calls[0][1].rssRuleId).toBe('generated-1');

    const keep = harness({ id: 'w1', status: 'active', externalIds: { imdb: 'tt14688458', tmdb: '125988' }, rssRuleId: 'chosen-by-hand', normalizedTitle: 'silo' });
    const r = await keep.svc.linkOrCreate(media(), { rssRuleId: 'generated-1' });
    expect(r.outcome).toBe('unchanged');
    expect(keep.watchlist.update).not.toHaveBeenCalled();
  });
});

describe('idempotence', () => {
  it('a repeated discovery of the same title creates exactly one entry', async () => {
    const store: any = { id: 'w1', status: 'active', externalIds: { imdb: 'tt14688458', tmdb: '125988' }, rssRuleId: null, normalizedTitle: 'silo' };
    const first = harness();
    await first.svc.linkOrCreate(media());
    expect(first.watchlist.create).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      const again = harness(store);
      const r = await again.svc.linkOrCreate(media());
      expect(again.watchlist.create).not.toHaveBeenCalled();
      expect(r.outcome).toBe('unchanged');
    }
  });
});
