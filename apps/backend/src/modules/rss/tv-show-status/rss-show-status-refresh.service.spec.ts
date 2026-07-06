import { RssShowStatusRefreshService } from './rss-show-status-refresh.service';
import { WS_EVENTS } from '@ultratorrent/shared';
import type { ShowStatusResult } from './tv-show-status-provider';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeResult(overrides: Partial<ShowStatusResult> = {}): ShowStatusResult {
  return {
    title: 'Test Show',
    normalizedTitle: 'test show',
    provider: 'tmdb',
    providerShowId: '42',
    originalStatus: 'Ended',
    normalizedStatus: 'ended',
    recommendation: 'not_recommended',
    confidence: 0.95,
    firstAirDate: '2010-01-01',
    lastAirDate: '2015-06-01',
    nextEpisodeAirDate: null,
    lastEpisodeTitle: null,
    nextEpisodeTitle: null,
    totalSeasons: 5,
    totalEpisodes: 60,
    overview: null,
    posterUrl: null,
    warnings: [],
    ...overrides,
  };
}

function build() {
  const prisma = {
    tvShowStatus: { findMany: jest.fn() },
    rssRule: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
  };
  const showStatus = { resolveByProviderId: jest.fn() };
  const registry = { getStatus: jest.fn().mockReturnValue({ enabled: true }) };
  const realtime = { broadcast: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const engine = { evaluateEvent: jest.fn().mockResolvedValue(undefined) };
  const moduleRef = { get: jest.fn().mockReturnValue(engine) };
  const svc = new RssShowStatusRefreshService(
    prisma as any,
    showStatus as any,
    registry as any,
    realtime as any,
    audit as any,
    moduleRef as any,
  );
  return { svc, prisma, showStatus, registry, realtime, audit, engine };
}

describe('RssShowStatusRefreshService.isDue', () => {
  const { svc } = build();
  const now = new Date('2026-07-06T00:00:00Z');

  it('active shows are due after 24h, not before', () => {
    expect(svc.isDue('returning', new Date(now.getTime() - 23 * HOUR), now)).toBe(false);
    expect(svc.isDue('returning', new Date(now.getTime() - 25 * HOUR), now)).toBe(true);
  });

  it('on_hiatus uses a 7-day cadence', () => {
    expect(svc.isDue('on_hiatus', new Date(now.getTime() - 6 * DAY), now)).toBe(false);
    expect(svc.isDue('on_hiatus', new Date(now.getTime() - 8 * DAY), now)).toBe(true);
  });

  it('ended/canceled use a 30-day cadence', () => {
    expect(svc.isDue('ended', new Date(now.getTime() - 29 * DAY), now)).toBe(false);
    expect(svc.isDue('canceled', new Date(now.getTime() - 31 * DAY), now)).toBe(true);
  });

  it('unknown uses a 3-day cadence (also the fallback)', () => {
    expect(svc.isDue('unknown', new Date(now.getTime() - 2 * DAY), now)).toBe(false);
    expect(svc.isDue('weird', new Date(now.getTime() - 4 * DAY), now)).toBe(true);
  });
});

describe('RssShowStatusRefreshService.refreshDue', () => {
  const now = new Date('2026-07-06T00:00:00Z');

  it('re-resolves only due rows and skips unchanged statuses', async () => {
    const { svc, prisma, showStatus, realtime, audit } = build();
    prisma.tvShowStatus.findMany.mockResolvedValue([
      { provider: 'tmdb', providerShowId: '1', normalizedStatus: 'returning', checkedAt: new Date(now.getTime() - 2 * HOUR) }, // not due
      { provider: 'tmdb', providerShowId: '2', normalizedStatus: 'returning', checkedAt: new Date(now.getTime() - 2 * DAY) }, // due, unchanged
    ]);
    showStatus.resolveByProviderId.mockResolvedValue(
      makeResult({ providerShowId: '2', normalizedStatus: 'returning', recommendation: 'recommended' }),
    );

    const changed = await svc.refreshDue(now);

    expect(changed).toBe(0);
    expect(showStatus.resolveByProviderId).toHaveBeenCalledTimes(1);
    expect(showStatus.resolveByProviderId).toHaveBeenCalledWith('tmdb', '2', true);
    expect(realtime.broadcast).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('propagates a change: updates rules, emits generic + specific events, audits', async () => {
    const { svc, prisma, showStatus, realtime, audit, engine } = build();
    prisma.tvShowStatus.findMany.mockResolvedValue([
      { provider: 'tmdb', providerShowId: '42', normalizedStatus: 'returning', checkedAt: new Date(now.getTime() - 2 * DAY) },
    ]);
    showStatus.resolveByProviderId.mockResolvedValue(
      makeResult({ providerShowId: '42', normalizedStatus: 'ended' }),
    );

    const changed = await svc.refreshDue(now);

    expect(changed).toBe(1);
    expect(prisma.rssRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { showStatusProvider: 'tmdb', showStatusProviderId: '42' },
        data: expect.objectContaining({ showStatus: 'ended', showStatusRecommendation: 'not_recommended' }),
      }),
    );
    const events = realtime.broadcast.mock.calls.map((c) => c[0]);
    expect(events).toContain(WS_EVENTS.RSS_SHOW_STATUS_CHANGED);
    expect(events).toContain(WS_EVENTS.RSS_SHOW_ENDED);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rss.show_status.changed', result: 'success' }),
    );
    const firedTriggers = engine.evaluateEvent.mock.calls.map((c) => c[0]);
    expect(firedTriggers).toContain('rss.show_status.changed');
    expect(firedTriggers).toContain('rss.show.ended');
  });

  it('emits became_active when an inactive show returns', async () => {
    const { svc, prisma, showStatus, realtime } = build();
    prisma.tvShowStatus.findMany.mockResolvedValue([
      { provider: 'tmdb', providerShowId: '7', normalizedStatus: 'ended', checkedAt: new Date(now.getTime() - 40 * DAY) },
    ]);
    showStatus.resolveByProviderId.mockResolvedValue(
      makeResult({ providerShowId: '7', normalizedStatus: 'returning', recommendation: 'recommended' }),
    );

    await svc.refreshDue(now);

    const events = realtime.broadcast.mock.calls.map((c) => c[0]);
    expect(events).toContain(WS_EVENTS.RSS_SHOW_STATUS_CHANGED);
    expect(events).toContain(WS_EVENTS.RSS_SHOW_BECAME_ACTIVE);
  });

  it('continues past a provider error on one row', async () => {
    const { svc, prisma, showStatus } = build();
    prisma.tvShowStatus.findMany.mockResolvedValue([
      { provider: 'tmdb', providerShowId: 'a', normalizedStatus: 'unknown', checkedAt: new Date(now.getTime() - 10 * DAY) },
      { provider: 'tmdb', providerShowId: 'b', normalizedStatus: 'unknown', checkedAt: new Date(now.getTime() - 10 * DAY) },
    ]);
    showStatus.resolveByProviderId
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeResult({ providerShowId: 'b', normalizedStatus: 'ended' }));

    const changed = await svc.refreshDue(now);

    expect(changed).toBe(1);
    expect(showStatus.resolveByProviderId).toHaveBeenCalledTimes(2);
  });
});

describe('RssShowStatusRefreshService.tick', () => {
  it('skips when the RSS module is disabled', async () => {
    const { svc, prisma, registry } = build();
    registry.getStatus.mockReturnValue({ enabled: false });
    await svc.tick();
    expect(prisma.tvShowStatus.findMany).not.toHaveBeenCalled();
  });
});
