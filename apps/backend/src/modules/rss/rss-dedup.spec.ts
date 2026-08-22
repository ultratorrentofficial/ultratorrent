import { RssService } from './rss.module';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const magnet = (h: string, name: string) =>
  `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(name)}`;

// A legacy include-regex rule owned by the feed — keeps the stub small (no match
// candidates ⇒ processFeed takes the legacy-evaluation path and skips the
// per-candidate evaluation bookkeeping).
const michaelRule = (feedId: string) => ({
  id: 'rule1',
  feedId,
  isEnabled: true,
  autoDownload: true,
  savePath: null,
  includeRegex: 'Michael',
  excludeRegex: null,
  matchCandidates: [],
});

// In-memory Prisma covering exactly what processFeed touches.
function makePrisma(rules: any[]) {
  const history: any[] = [];
  const acquisitions: any[] = [];
  const acqKey = (w: any) => `${w.rssRuleId}::${w.identity}`;
  return {
    _history: history,
    _acquisitions: acquisitions,
    rssRule: { findMany: async () => rules },
    rssHistory: {
      findUnique: async ({ where }: any) =>
        history.find(
          (h) =>
            h.feedId === where.feedId_itemGuid.feedId &&
            h.itemGuid === where.feedId_itemGuid.itemGuid,
        ) ?? null,
      findFirst: async ({ where }: any) =>
        history.find((h) => h.infoHash === where.infoHash && h.downloaded === where.downloaded) ??
        null,
      create: async ({ data }: any) => {
        const row = { id: `h${history.length}`, ...data };
        history.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = history.find((h) => h.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    rssAcquisition: {
      findUnique: async ({ where }: any) =>
        acquisitions.find((a) => acqKey(a) === acqKey(where.rssRuleId_identity)) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const found = acquisitions.find(
          (a) => acqKey(a) === acqKey(where.rssRuleId_identity),
        );
        if (found) {
          Object.assign(found, update);
          return found;
        }
        const row = { ...create };
        acquisitions.push(row);
        return row;
      },
    },
    rssRuleMatchCandidate: { update: async () => ({}) },
    rssRuleMatchEvaluation: { create: async () => ({}) },
    rssFeed: { update: async () => ({}) },
    // Nothing in these tests was ever imported, so a supersede has no library
    // copy to trash and goes straight on to removing the torrent. The dedicated
    // coverage for the library half lives in rss-supersede-library.spec.ts.
    mediaIntakeJob: { findMany: async () => [] },
    mediaItem: { findUnique: async () => null },
  };
}

/** Stubs for the two file-layer deps the supersede path needs. */
const fileStubs = () =>
  [
    { remove: jest.fn(async () => ({})) } as any,
    {
      assertWithinHardRoots: (p: string) => p,
      storageSafety: { toRelative: (p: string) => p },
    } as any,
  ] as const;

function makeService(prisma: any, items: any[]) {
  let n = 0;
  const addMagnet = jest.fn(async () => `engine-hash-${++n}`); // distinct per grab
  const removeTorrentAndData = jest.fn(async () => undefined);
  const registry = {
    getDefault: async () => ({ addMagnet, addTorrentURL: jest.fn(), removeTorrentAndData }),
  };
  const svc = new RssService(prisma as any, registry as any, {} as any, {} as any, {} as any, {} as any, { get: async () => null, defaultProfile: async () => null } as any, ...fileStubs());
  (svc as any).parser = { parseURL: async () => ({ items }) };
  return { svc, addMagnet, removeTorrentAndData };
}

describe('RssService info-hash dedup in processFeed', () => {
  it('extracts a lowercased btih info-hash from a magnet, null for non-magnets', () => {
    const svc = new RssService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { get: async () => null, defaultProfile: async () => null } as any, ...fileStubs()) as any;
    expect(svc.extractInfoHash(magnet(HASH.toUpperCase(), 'x'))).toBe(HASH);
    expect(svc.extractInfoHash('https://tracker/file.torrent')).toBeNull();
    expect(svc.extractInfoHash(null)).toBeNull();
  });

  it('grabs the same torrent only once when it reappears under a different guid', async () => {
    const prisma = makePrisma([michaelRule('feed1')]);
    // Same info-hash, two distinct guids (the rotated-guid / re-post case).
    const items = [
      { guid: 'g1', title: 'Michael 2024 1080p', link: magnet(HASH, 'Michael 2024 1080p') },
      {
        guid: 'g2',
        title: 'Michael 2024 1080p REPACK',
        link: magnet(HASH.toUpperCase(), 'Michael 2024 1080p REPACK'),
      },
    ];
    const { svc, addMagnet } = makeService(prisma, items);

    const res = await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

    expect(addMagnet).toHaveBeenCalledTimes(1); // second item deduped on info-hash
    expect(res.downloaded).toBe(1);
    expect(res.newItems).toBe(2);
    expect(prisma._history.map((h: any) => h.downloaded)).toEqual([true, false]);
  });

  /**
   * The operator-facing promise of "clear the downloaded status so it can be
   * downloaded again". `processFeed` skips any feed item it already holds
   * history for, so clearing the flag alone changed nothing an automatic path
   * could act on: the poll never looked at the row again.
   */
  describe('re-grab after an operator clears the status', () => {
    const cleared = (over: any = {}) => ({
      id: 'seed',
      feedId: 'feed1',
      itemGuid: 'g1',
      title: 'Michael 2024 1080p',
      infoHash: HASH,
      downloaded: false,
      regrabRequestedAt: new Date('2026-08-18T00:58:00Z'),
      ...over,
    });
    const item = () => [
      { guid: 'g1', title: 'Michael 2024 1080p', link: magnet(HASH, 'Michael 2024 1080p') },
    ];

    it('downloads it again on the next poll', async () => {
      const prisma = makePrisma([michaelRule('feed1')]);
      prisma._history.push(cleared());
      const { svc, addMagnet } = makeService(prisma, item());

      const res = await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

      expect(addMagnet).toHaveBeenCalledTimes(1);
      expect(res.downloaded).toBe(1);
    });

    it('updates the row it already has rather than inserting a second one', async () => {
      // (feedId, itemGuid) is unique — an insert here is a constraint violation,
      // and the history the operator is looking at must stay one row.
      const prisma = makePrisma([michaelRule('feed1')]);
      prisma._history.push(cleared());
      const { svc } = makeService(prisma, item());

      const res = await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

      expect(prisma._history).toHaveLength(1);
      expect(prisma._history[0].downloaded).toBe(true);
      expect(res.newItems).toBe(0); // a re-grab is not a new item
    });

    it('clears the marker once the item is taken', async () => {
      const prisma = makePrisma([michaelRule('feed1')]);
      prisma._history.push(cleared());
      const { svc } = makeService(prisma, item());

      await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

      expect(prisma._history[0].regrabRequestedAt).toBeNull();
    });

    it('keeps the request outstanding when no rule matched it', async () => {
      // The operator's next move is usually to fix the rule; the request must
      // survive until something can honour it.
      const prisma = makePrisma([michaelRule('feed1')]);
      prisma._history.push(cleared({ itemGuid: 'g9', title: 'Unrelated release' }));
      const { svc, addMagnet } = makeService(prisma, [
        { guid: 'g9', title: 'Unrelated release', link: magnet(HASH, 'Unrelated release') },
      ]);

      await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

      expect(addMagnet).not.toHaveBeenCalled();
      expect(prisma._history[0].regrabRequestedAt).toBeInstanceOf(Date);
    });

    it('leaves an ordinary already-seen item alone', async () => {
      // The guard is the marker, not the flag: without it nothing changes, or
      // every poll would re-evaluate the whole feed window.
      const prisma = makePrisma([michaelRule('feed1')]);
      prisma._history.push(cleared({ regrabRequestedAt: null, downloaded: true }));
      const { svc, addMagnet } = makeService(prisma, item());

      const res = await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

      expect(addMagnet).not.toHaveBeenCalled();
      expect(res.newItems).toBe(0);
    });
  });

  it('does not download again when the info-hash was already grabbed on a prior poll', async () => {
    const prisma = makePrisma([michaelRule('feed1')]);
    // Seed history as if a previous poll already grabbed this hash.
    prisma._history.push({
      id: 'seed',
      feedId: 'feed1',
      itemGuid: 'old',
      infoHash: HASH,
      downloaded: true,
    });
    const items = [
      { guid: 'fresh', title: 'Michael 2024 1080p', link: magnet(HASH, 'Michael 2024 1080p') },
    ];
    const { svc, addMagnet } = makeService(prisma, items);

    const res = await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

    expect(addMagnet).not.toHaveBeenCalled();
    expect(res.downloaded).toBe(0);
  });

  it('still grabs distinct releases (different info-hashes) of the same title', async () => {
    const prisma = makePrisma([michaelRule('feed1')]);
    const other = 'fedcba9876543210fedcba9876543210fedcba98';
    const items = [
      { guid: 'g720', title: 'Michael 2024 720p', link: magnet(HASH, 'Michael 2024 720p') },
      { guid: 'g1080', title: 'Michael 2024 1080p', link: magnet(other, 'Michael 2024 1080p') },
    ];
    const { svc, addMagnet } = makeService(prisma, items);

    const res = await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

    // Info-hash dedup is content identity, not title identity: two different
    // torrents both download. (Collapsing quality variants is the preference /
    // per-title concern exercised below.)
    expect(addMagnet).toHaveBeenCalledTimes(2);
    expect(res.downloaded).toBe(2);
  });
});

// A preference list: BluRay preferred (priorityOrder 0), WEBRip fallback (1).
const cand = (id: string, order: number, source: string) => ({
  id,
  name: `${source} candidate`,
  priorityOrder: order,
  enabled: true,
  matchType: 'smart_movie_match',
  pattern: 'Michael',
  requiredTerms: [],
  excludedTerms: [],
  qualityRules: { year: 2024, source },
  sizeRules: {},
  feedScope: {},
});
const preferenceRule = (feedId: string) => ({
  id: 'rule1',
  feedId,
  isEnabled: true,
  autoDownload: true,
  savePath: null,
  includeRegex: null,
  excludeRegex: null,
  matchCandidates: [cand('cb', 0, 'BluRay'), cand('cw', 1, 'WEBRip')],
});

const bluray = { guid: 'b', title: 'Michael 2024 1080p BluRay x264', link: magnet(HASH, 'b') };
const webrip = {
  guid: 'w',
  title: 'Michael 2024 1080p WEBRip x264',
  link: magnet('fedcba9876543210fedcba9876543210fedcba98', 'w'),
};

describe('RssService per-title preference (upgrade + replace) in processFeed', () => {
  it('holds one release per title: grabs BluRay, skips the lower WEBRip', async () => {
    const prisma = makePrisma([preferenceRule('feed1')]);
    const { svc, addMagnet, removeTorrentAndData } = makeService(prisma, [bluray, webrip]);

    const res = await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

    expect(addMagnet).toHaveBeenCalledTimes(1); // WEBRip skipped as already-satisfied
    expect(res.downloaded).toBe(1);
    expect(removeTorrentAndData).not.toHaveBeenCalled();
    expect(prisma._acquisitions).toHaveLength(1);
    expect(prisma._acquisitions[0]).toMatchObject({
      identity: 'movie:michael:2024',
      priorityOrder: 0,
    });
  });

  it('upgrades when a higher-priority release arrives after a lower one', async () => {
    const prisma = makePrisma([preferenceRule('feed1')]);
    // WEBRip (priority 1) first, then BluRay (priority 0) — an upgrade.
    const { svc, addMagnet, removeTorrentAndData } = makeService(prisma, [webrip, bluray]);

    const res = await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

    expect(addMagnet).toHaveBeenCalledTimes(2); // both grabbed…
    expect(removeTorrentAndData).toHaveBeenCalledTimes(1); // …but the WEBRip is removed
    expect(removeTorrentAndData).toHaveBeenCalledWith('engine-hash-1'); // the WEBRip's hash
    expect(res.downloaded).toBe(2);
    // Acquisition now reflects the upgraded (BluRay) release.
    expect(prisma._acquisitions).toHaveLength(1);
    expect(prisma._acquisitions[0]).toMatchObject({
      identity: 'movie:michael:2024',
      priorityOrder: 0,
      torrentHash: 'engine-hash-2',
    });
  });

  it('does not re-grab or downgrade once the top preference is held', async () => {
    const prisma = makePrisma([preferenceRule('feed1')]);
    // Seed as if BluRay (priority 0) is already held.
    prisma._acquisitions.push({
      rssRuleId: 'rule1',
      identity: 'movie:michael:2024',
      priorityOrder: 0,
      torrentHash: 'existing',
    });
    const { svc, addMagnet, removeTorrentAndData } = makeService(prisma, [webrip]);

    const res = await svc.processFeed({ id: 'feed1', url: 'http://f/rss' });

    expect(addMagnet).not.toHaveBeenCalled();
    expect(removeTorrentAndData).not.toHaveBeenCalled();
    expect(res.downloaded).toBe(0);
  });
});
