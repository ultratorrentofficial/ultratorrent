import { NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { MissingEpisodeSearchService } from '../missing-episode-search.service';
import type { IndexerCandidate } from '../../indexers/torznab-client';

const cand = (over: Partial<IndexerCandidate> = {}): IndexerCandidate => ({
  indexerId: 'ix', indexerName: 'ix',
  title: 'The Wire S01E01 1080p WEB-DL x265-GRP',
  downloadUrl: 'magnet:?xt=urn:btih:aaaa', infoHash: 'aaaa',
  sizeBytes: 1_000_000_000, seeders: 100, categories: [5030], ...over,
});

function build(over: {
  candidates?: IndexerCandidate[];
  evaluation?: any;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  wanted?: Record<string, unknown>;
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
      findUnique: jest.fn(async () => ({ id: 'wl1', title: 'The Wire', profileId: 'wlProfile' })),
    },
  };
  const indexers = { searchAll: jest.fn(async () => over.candidates ?? []) };
  const evaluator = { evaluate: jest.fn(async () => over.evaluation ?? { id: 'ev1', decision: 'download', requiresApproval: false }) };
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
    prisma as any, indexers as any, evaluator as any, acquisition as any,
    audit as any, realtime as any, eventBus as any, registry as any,
  );
  return { svc, prisma, indexers, evaluator, acquisition, audit, realtime, eventBus, updates };
}

describe('MissingEpisodeSearchService.sweep — gating', () => {
  it('no-ops when the module is disabled', async () => {
    const { svc, evaluator, acquisition } = build({ enabled: false });
    expect(await svc.sweep()).toBeNull();
    expect(acquisition.getSettings).not.toHaveBeenCalled();
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('no-ops when autoSearchMissing is off', async () => {
    const { svc, evaluator } = build({ settings: { autoSearchMissing: false } });
    expect(await svc.sweep()).toBeNull();
    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });
});

describe('MissingEpisodeSearchService.sweep — grab flow', () => {
  it('auto-grabs when the evaluator downloads without approval', async () => {
    const { svc, updates, evaluator, eventBus, realtime } = build({
      candidates: [cand()],
      evaluation: { id: 'ev1', decision: 'download', requiresApproval: false },
    });
    const summary = await svc.sweep();
    expect(summary).toMatchObject({ scanned: 1, grabbed: 1 });
    // evaluate got the candidate release + magnet, with the missing_episode source.
    expect(evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseName: 'The Wire S01E01 1080p WEB-DL x265-GRP',
        downloadUrl: 'magnet:?xt=urn:btih:aaaa',
        sourceType: 'missing_episode_sweep',
        sourceId: 'w1',
      }),
      undefined,
    );
    const last = updates[updates.length - 1];
    expect(last).toMatchObject({ searchStatus: 'grabbed', grabbedEvaluationId: 'ev1', releaseTitle: 'The Wire S01E01 1080p WEB-DL x265-GRP' });
    expect(eventBus.emit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: NOTIFICATION_EVENTS.MEDIA_MISSING_EPISODE_FILLED }));
    expect(realtime.broadcast).toHaveBeenCalledWith('media_acquisition.missing_episode.grabbed', expect.anything());
  });

  it('queues for approval when the evaluator requires it (no grab event)', async () => {
    const { svc, updates, eventBus } = build({
      candidates: [cand()],
      evaluation: { id: 'ev2', decision: 'hold_for_approval', requiresApproval: true },
    });
    const summary = await svc.sweep();
    expect(summary).toMatchObject({ pendingApproval: 1 });
    expect(updates[updates.length - 1]).toMatchObject({ searchStatus: 'pending_approval', grabbedEvaluationId: 'ev2' });
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('records no_results and never evaluates when no candidate matches the SxxEyy', async () => {
    const { svc, updates, evaluator } = build({
      candidates: [cand({ title: 'The Wire S02E05 1080p WEB-DL x265-GRP' })], // wrong episode
    });
    const summary = await svc.sweep();
    expect(summary).toMatchObject({ noResults: 1, grabbed: 0 });
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(updates[updates.length - 1]).toMatchObject({ searchStatus: 'no_results' });
  });

  it('passes the configured missingSearchProfileId to the evaluator', async () => {
    const { svc, evaluator } = build({ candidates: [cand()], settings: { missingSearchProfileId: 'p1' } });
    await svc.sweep();
    expect(evaluator.evaluate).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'p1' }), undefined);
  });

  it('falls back to the watchlist item profile when no setting is configured', async () => {
    const { svc, evaluator } = build({ candidates: [cand()], settings: { missingSearchProfileId: null } });
    await svc.sweep();
    expect(evaluator.evaluate).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'wlProfile' }), undefined);
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
