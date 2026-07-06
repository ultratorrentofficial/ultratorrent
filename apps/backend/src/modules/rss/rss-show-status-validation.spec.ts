import { RssService } from './rss.module';
import type { ShowStatusResult } from './tv-show-status/tv-show-status-provider';

function statusResult(over: Partial<ShowStatusResult>): ShowStatusResult {
  return {
    title: 'Show',
    normalizedTitle: 'show',
    provider: 'tmdb',
    providerShowId: '42',
    originalStatus: null,
    normalizedStatus: 'returning',
    recommendation: 'recommended',
    confidence: 0.95,
    firstAirDate: '2020-01-01',
    lastAirDate: null,
    nextEpisodeAirDate: null,
    lastEpisodeTitle: null,
    nextEpisodeTitle: null,
    totalSeasons: null,
    totalEpisodes: null,
    overview: null,
    posterUrl: null,
    warnings: [],
    ...over,
  };
}

function makeRss(resolved: ShowStatusResult | null) {
  const created: any[] = [];
  const prisma = {
    rssRule: { create: jest.fn(async ({ data }: any) => { created.push(data); return { id: 'r1', ...data }; }) },
  };
  const showStatus = { resolveByProviderId: jest.fn().mockResolvedValue(resolved) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  const engine = { evaluateEvent: jest.fn().mockResolvedValue(undefined) };
  const moduleRef = { get: jest.fn().mockReturnValue(engine) };
  const svc = new RssService(
    prisma as never,
    {} as never,
    showStatus as never,
    audit as never,
    realtime as never,
    moduleRef as never,
  );
  return { svc, created, showStatus, audit, realtime, engine };
}

const tvDto = {
  feedId: 'f1',
  name: 'Show',
  mediaType: 'tv',
  showStatusProvider: 'tmdb',
  showStatusProviderId: '42',
};

describe('RssService.createRule — show-status save validation', () => {
  it('blocks an ended show unless allowInactiveShowMonitoring is set', async () => {
    const { svc } = makeRss(statusResult({ normalizedStatus: 'ended', recommendation: 'not_recommended' }));
    await expect(svc.createRule({ ...tvDto, allowInactiveShowMonitoring: false } as never)).rejects.toThrow(
      /inactive show|ended/i,
    );
  });

  it('allows an ended show with override, persists the snapshot, audits + emits', async () => {
    const { svc, created, audit, realtime } = makeRss(
      statusResult({ normalizedStatus: 'canceled', recommendation: 'not_recommended' }),
    );
    await svc.createRule({ ...tvDto, allowInactiveShowMonitoring: true } as never);
    expect(created[0]).toMatchObject({
      mediaType: 'tv',
      showStatus: 'canceled',
      showStatusRecommendation: 'not_recommended',
      allowInactiveShowMonitoring: true,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rss.rule.created_for_inactive_show' }),
    );
    expect(realtime.broadcast).toHaveBeenCalledWith('rss.rule.created_for_inactive_show', expect.anything());
  });

  it('saves an active show normally with a recommended snapshot', async () => {
    const { svc, created, audit } = makeRss(statusResult({ normalizedStatus: 'returning', recommendation: 'recommended' }));
    await svc.createRule({ ...tvDto, allowInactiveShowMonitoring: false } as never);
    expect(created[0]).toMatchObject({ showStatus: 'returning', showStatusRecommendation: 'recommended' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('allows save with a warning when status is unresolvable (unknown)', async () => {
    const { svc, created } = makeRss(null);
    await svc.createRule({ ...tvDto, allowInactiveShowMonitoring: false } as never);
    expect(created[0]).toMatchObject({ showStatus: 'unknown', showStatusWarnings: ['status_unconfirmed'] });
  });

  it('skips the status check entirely for non-TV rules', async () => {
    const { svc, created, showStatus } = makeRss(statusResult({}));
    await svc.createRule({ feedId: 'f1', name: 'A Movie', mediaType: 'movie', showStatusProviderId: '99' } as never);
    expect(showStatus.resolveByProviderId).not.toHaveBeenCalled();
    expect(created[0].mediaType).toBe('movie');
    expect(created[0].showStatus).toBeUndefined();
  });
});
