import { PackAcquisitionService, type PackItem } from '../pack-acquisition.service';

const item: PackItem = {
  id: 'wl1', title: 'Mr. D', titleAliases: [], year: 2012,
  rssRuleId: null, targetLibraryId: 'tv1', libraryShowId: null, priority: 100,
};

function build(opts: {
  config?: Record<string, unknown>;
  noPath?: boolean;
  candidates?: Array<Record<string, unknown>>;
  best?: Record<string, unknown> | null;
  torrentHash?: string | null;
} = {}) {
  const updated: unknown[] = [];
  const prisma: any = { wantedEpisode: { updateMany: jest.fn(async (a: any) => void updated.push(a)) } };
  const indexers: any = {
    searchAllDetailed: jest.fn(async () => ({ queried: 2, failed: 0, candidates: opts.candidates ?? [], failures: [] })),
  };
  const evaluator: any = {
    grabSelected: jest.fn(async () => ({ evaluation: { id: 'ev1' }, torrentHash: opts.torrentHash === undefined ? 'HASH' : opts.torrentHash, refused: false })),
  };
  const matchPrefs: any = {
    resolveCandidates: jest.fn(async () => [{ id: 'p', name: '1080p', priorityOrder: 0, enabled: true, matchType: 'quality' }]),
    selectPack: jest.fn(() => (opts.best === undefined ? { candidate: { title: 'Mr. D S03 1080p', downloadUrl: 'magnet:x', sizeBytes: 5e9, seeders: 20 }, matchedPriority: 0, reason: 'matched pack' } : opts.best)),
  };
  const search: any = { resolveShowSavePath: jest.fn(async () => ({ path: opts.noPath ? undefined : '/media/TV/Mr. D', intakeRuleId: null })) };
  const acquisition: any = { getSettings: jest.fn(async () => ({ packBackfill: opts.config ?? { enabled: true, seriesPacks: true, seasonMissingThreshold: 1, wholeSeriesForSeriesPack: true, maxSeasonPackGb: 30, maxSeriesPackGb: 150 } })) };
  const audit: any = { record: jest.fn() };
  const realtime: any = { broadcast: jest.fn() };
  const svc = new PackAcquisitionService(prisma, indexers, evaluator, matchPrefs, search, acquisition, audit, realtime);
  return { svc, prisma, indexers, evaluator, matchPrefs, search, realtime, updated };
}

describe('PackAcquisitionService.trySeasonPack', () => {
  it('grabs a matching season pack and marks the covered episodes', async () => {
    const { svc, evaluator, matchPrefs, prisma } = build({ candidates: [{ title: 'Mr. D S03 1080p' }] });
    const r = await svc.trySeasonPack(item, 'tt100', 3, ['e1', 'e2', 'e3'], 'u1');
    expect(r).toMatchObject({ grabbed: true, covered: 3 });
    expect(matchPrefs.selectPack).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'Mr. D', { type: 'season', season: 3 }, 30 * 1024 ** 3, []);
    expect(evaluator.grabSelected).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'season_pack_backfill', savePath: '/media/TV/Mr. D' }), 'u1');
    const upd = (prisma.wantedEpisode.updateMany as jest.Mock).mock.calls[0][0];
    expect(upd.where.id.in).toEqual(['e1', 'e2', 'e3']);
    expect(upd.data.searchStatus).toBe('grabbed');
    expect(upd.data.torrentHash).toBe('HASH');
  });

  it('refuses (no grab) when no show folder resolves', async () => {
    const { svc, evaluator } = build({ noPath: true, candidates: [{ title: 'Mr. D S03 1080p' }] });
    const r = await svc.trySeasonPack(item, 'tt100', 3, ['e1'], 'u1');
    expect(r.grabbed).toBe(false);
    expect(r.reason).toBe('no_save_path');
    expect(evaluator.grabSelected).not.toHaveBeenCalled();
  });

  it('returns no-grab when the selector finds no pack', async () => {
    const { svc, evaluator } = build({ candidates: [{ title: 'Something Else S01E01' }], best: null });
    const r = await svc.trySeasonPack(item, 'tt100', 3, ['e1'], 'u1');
    expect(r.grabbed).toBe(false);
    expect(evaluator.grabSelected).not.toHaveBeenCalled();
  });

  it('returns no-grab when the grab adds no torrent', async () => {
    const { svc, prisma } = build({ candidates: [{ title: 'Mr. D S03 1080p' }], torrentHash: null });
    const r = await svc.trySeasonPack(item, 'tt100', 3, ['e1'], 'u1');
    expect(r.grabbed).toBe(false);
    expect(prisma.wantedEpisode.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing when pack backfill is disabled', async () => {
    const { svc, indexers } = build({ config: { enabled: false } });
    const r = await svc.trySeasonPack(item, 'tt100', 3, ['e1'], 'u1');
    expect(r.grabbed).toBe(false);
    expect(indexers.searchAllDetailed).not.toHaveBeenCalled();
  });
});

describe('PackAcquisitionService.trySeriesPack', () => {
  it('searches with the series cap and grabs a complete-series pack', async () => {
    const { svc, matchPrefs } = build({ candidates: [{ title: 'Mr. D Complete Series 1080p' }], best: { candidate: { title: 'Mr. D Complete Series 1080p', downloadUrl: 'magnet:y', sizeBytes: 4e10, seeders: 8 }, matchedPriority: 0, reason: 'pack' } });
    const r = await svc.trySeriesPack(item, 'tt100', [1, 2, 3], ['e1', 'e2'], 'u1');
    expect(r.grabbed).toBe(true);
    expect(matchPrefs.selectPack).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'Mr. D', { type: 'series', seasons: [1, 2, 3] }, 150 * 1024 ** 3, []);
  });

  it('skips series packs when seriesPacks is off', async () => {
    const { svc, indexers } = build({ config: { enabled: true, seriesPacks: false } });
    const r = await svc.trySeriesPack(item, 'tt100', [1], ['e1'], 'u1');
    expect(r.grabbed).toBe(false);
    expect(indexers.searchAllDetailed).not.toHaveBeenCalled();
  });
});
