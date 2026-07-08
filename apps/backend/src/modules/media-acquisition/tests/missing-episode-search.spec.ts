import { NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { MissingEpisodeSearchService } from '../missing-episode-search.service';
import type { IndexerCandidate } from '../../indexers/torznab-client';

const cand = (over: Partial<IndexerCandidate> = {}): IndexerCandidate => ({
  indexerId: 'ix', indexerName: 'ix',
  title: 'The Wire S01E01 1080p WEB-DL x265-GRP',
  downloadUrl: 'magnet:?xt=urn:btih:aaaa', infoHash: 'aaaa',
  sizeBytes: 1_000_000_000, seeders: 100, categories: [5030], ...over,
});

const selection = (c: IndexerCandidate) => ({ candidate: c, matchedPriority: 0, reason: 'matched “1080p x265 (≤1 GB)”' });

function build(over: {
  candidates?: IndexerCandidate[];
  selected?: any; // pass `null` to force no-match; omit to auto-select the first candidate
  evaluation?: any;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  wanted?: Record<string, unknown>;
  item?: Record<string, unknown>;
  rssRule?: Record<string, unknown> | null;
} = {}) {
  const wanted = {
    id: 'w1', watchlistItemId: 'wl1', seriesTconst: 'ttS', seasonNumber: 1, episodeNumber: 1,
    status: 'missing', searchStatus: 'idle', lastSearchedAt: null, ...over.wanted,
  };
  const updates: any[] = [];
  const prisma = {
    wantedEpisode: {
      findMany: jest.fn(async () => [wanted]),
      findUnique: jest.fn(async ({ where }: any) => (where.id === wanted.id ? wanted : null)),
      update: jest.fn(async ({ data }: any) => { updates.push(data); return { ...wanted, ...data }; }),
    },
    mediaAcquisitionWatchlistItem: {
      findUnique: jest.fn(async () => ({ id: 'wl1', title: 'The Wire', priority: 100, rssRuleId: null, ...over.item })),
    },
    rssRule: {
      findUnique: jest.fn(async () => ('rssRule' in over ? over.rssRule : { savePath: '/media/tv/The Wire' })),
    },
  };
  const indexers = { searchAll: jest.fn(async () => over.candidates ?? []) };
  const evaluator = { grabSelected: jest.fn(async () => over.evaluation ?? { id: 'ev1' }) };
  const matchPrefs = {
    resolveCandidates: jest.fn(async () => []),
    select: jest.fn((candidates: IndexerCandidate[]) => {
      if ('selected' in over) return over.selected;
      return candidates.length ? selection(candidates[0]) : null;
    }),
  };
  const acquisition = {
    getSettings: jest.fn(async () => ({
      autoSearchMissing: true, searchIntervalMinutes: 60, missingSearchProfileId: null, maxSearchesPerSweep: 50,
      ...over.settings,
    })),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  const eventBus = { emit: jest.fn() };
  const registry = { getStatus: jest.fn(() => ({ enabled: over.enabled ?? true })) };
  const svc = new MissingEpisodeSearchService(
    prisma as any, indexers as any, evaluator as any, matchPrefs as any, acquisition as any,
    audit as any, realtime as any, eventBus as any, registry as any,
  );
  return { svc, prisma, indexers, evaluator, matchPrefs, acquisition, audit, realtime, eventBus, updates };
}

describe('MissingEpisodeSearchService.sweep — gating', () => {
  it('no-ops when the module is disabled', async () => {
    const { svc, evaluator, acquisition } = build({ enabled: false });
    expect(await svc.sweep()).toBeNull();
    expect(acquisition.getSettings).not.toHaveBeenCalled();
    expect(evaluator.grabSelected).not.toHaveBeenCalled();
  });

  it('no-ops when autoSearchMissing is off', async () => {
    const { svc, evaluator } = build({ settings: { autoSearchMissing: false } });
    expect(await svc.sweep()).toBeNull();
    expect(evaluator.grabSelected).not.toHaveBeenCalled();
  });
});

describe('MissingEpisodeSearchService.sweep — grab flow', () => {
  it('grabs the release the match preferences selected', async () => {
    const { svc, updates, evaluator, matchPrefs, eventBus, realtime } = build({ candidates: [cand()] });
    const summary = await svc.sweep();
    expect(summary).toMatchObject({ scanned: 1, grabbed: 1 });
    // preferences decided the pick; grabSelected got the release + magnet + source.
    expect(matchPrefs.select).toHaveBeenCalled();
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseName: 'The Wire S01E01 1080p WEB-DL x265-GRP',
        downloadUrl: 'magnet:?xt=urn:btih:aaaa',
        sourceType: 'missing_episode_sweep',
        sourceId: 'w1',
        reason: expect.stringContaining('1080p'),
      }),
      undefined,
    );
    const last = updates[updates.length - 1];
    expect(last).toMatchObject({ searchStatus: 'grabbed', grabbedEvaluationId: 'ev1', releaseTitle: 'The Wire S01E01 1080p WEB-DL x265-GRP' });
    expect(eventBus.emit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: NOTIFICATION_EVENTS.MEDIA_MISSING_EPISODE_FILLED }));
    expect(realtime.broadcast).toHaveBeenCalledWith('media_acquisition.missing_episode.grabbed', expect.anything());
  });

  it('grabs into the parent Show Rule save path when the show is linked to an RSS rule', async () => {
    const { svc, evaluator, prisma } = build({
      candidates: [cand()],
      item: { rssRuleId: 'rule1' },
      rssRule: { savePath: '/media/tv/The Wire' },
    });
    await svc.sweep();
    expect(prisma.rssRule.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rule1' } }),
    );
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: '/media/tv/The Wire' }),
      undefined,
    );
  });

  it('leaves save path undefined (engine default) when the show has no RSS rule', async () => {
    const { svc, evaluator, prisma } = build({ candidates: [cand()] });
    await svc.sweep();
    expect(prisma.rssRule.findUnique).not.toHaveBeenCalled();
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: undefined }),
      undefined,
    );
  });

  it('leaves save path undefined when the linked Show Rule has an empty save path', async () => {
    const { svc, evaluator } = build({
      candidates: [cand()],
      item: { rssRuleId: 'rule1' },
      rssRule: { savePath: '   ' },
    });
    await svc.sweep();
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: undefined }),
      undefined,
    );
  });

  it('records no_results and never grabs when nothing matches the preferences', async () => {
    const { svc, updates, evaluator, eventBus } = build({ candidates: [cand()], selected: null });
    const summary = await svc.sweep();
    expect(summary).toMatchObject({ noResults: 1, grabbed: 0 });
    expect(evaluator.grabSelected).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(updates[updates.length - 1]).toMatchObject({ searchStatus: 'no_results' });
  });
});

describe('MissingEpisodeSearchService — manual triggers', () => {
  it('searchEpisode rejects an episode that is not missing', async () => {
    const { svc } = build({ wanted: { status: 'owned' } });
    await expect(svc.searchEpisode('w1')).rejects.toThrow(/not missing/i);
  });

  it('searchEpisode rejects when the module is disabled', async () => {
    const { svc } = build({ enabled: false });
    await expect(svc.searchEpisode('w1')).rejects.toThrow(/disabled/i);
  });
});
