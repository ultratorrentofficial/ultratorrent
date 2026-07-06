import { AutomationEngine } from './automation.module';
import type { NormalizedTorrent } from '@ultratorrent/shared';

// A ratio-cap rule: when ratio >= 2, stop the torrent.
const RATIO_RULE = {
  id: 'r1',
  name: 'Stop at 2.0',
  conditions: [{ field: 'ratio', op: 'gte', value: 2 }],
  actions: [{ type: 'stop' }],
};

function torrent(over: Partial<NormalizedTorrent> = {}): NormalizedTorrent {
  return {
    hash: 'H',
    name: 't',
    ratio: 0,
    state: 'seeding',
    progress: 1,
    size: 1,
    downloaded: 1,
    uploaded: 1,
    downloadRate: 0,
    uploadRate: 0,
    eta: null,
    engineId: 'e1',
    ...over,
  } as NormalizedTorrent;
}

describe('AutomationEngine — ratio.reached edge trigger', () => {
  function make() {
    const provider = { stopTorrent: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      automationRule: { findMany: jest.fn().mockResolvedValue([RATIO_RULE]) },
      automationLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;
    const registry = { resolve: jest.fn().mockResolvedValue(provider) } as any;
    const notifications = { dispatch: jest.fn().mockResolvedValue(undefined) } as any;
    const media = {} as any;
    const mediaActions = { execute: jest.fn().mockResolvedValue(undefined) } as any;
    const rssActions = { execute: jest.fn().mockResolvedValue(undefined) } as any;
    const engine = new AutomationEngine(
      prisma,
      registry,
      notifications,
      media,
      mediaActions,
      rssActions,
    );
    return { engine, provider, mediaActions };
  }

  it('fires when the ratio first crosses the threshold', async () => {
    const { engine, provider } = make();
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ ratio: 2.1 }), previous: torrent({ ratio: 1.9 }) },
    ]);
    expect(provider.stopTorrent).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-fire once the ratio was already above the threshold', async () => {
    const { engine, provider } = make();
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ ratio: 2.3 }), previous: torrent({ ratio: 2.1 }) },
    ]);
    expect(provider.stopTorrent).not.toHaveBeenCalled();
  });

  it('does not fire while still below the threshold', async () => {
    const { engine, provider } = make();
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ ratio: 1.5 }), previous: torrent({ ratio: 1.2 }) },
    ]);
    expect(provider.stopTorrent).not.toHaveBeenCalled();
  });

  it('skips all work when no rule uses the trigger (one cheap query)', async () => {
    const { engine, provider } = make();
    (engine as any).prisma.automationRule.findMany.mockResolvedValueOnce([]);
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ ratio: 2.1 }), previous: torrent({ ratio: 1.9 }) },
    ]);
    expect(provider.stopTorrent).not.toHaveBeenCalled();
  });
});

describe('AutomationEngine — media action dispatch', () => {
  const MEDIA_RULE = {
    id: 'm1',
    name: 'Scan on complete',
    conditions: [],
    actions: [{ type: 'media_scan_library', params: { libraryId: 'L1' } }],
  };

  it('delegates a media_* action to MediaAutomationActions (no engine call)', async () => {
    const prisma = {
      automationRule: { findMany: jest.fn().mockResolvedValue([MEDIA_RULE]) },
      automationLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;
    const provider = { stopTorrent: jest.fn() };
    const registry = { resolve: jest.fn().mockResolvedValue(provider) } as any;
    const notifications = { dispatch: jest.fn().mockResolvedValue(undefined) } as any;
    const media = {} as any;
    const mediaActions = { execute: jest.fn().mockResolvedValue(undefined) } as any;
    const rssActions = { execute: jest.fn().mockResolvedValue(undefined) } as any;
    const engine = new AutomationEngine(
      prisma,
      registry,
      notifications,
      media,
      mediaActions,
      rssActions,
    );

    await engine.evaluate('torrent.completed', torrent());

    expect(mediaActions.execute).toHaveBeenCalledWith('media_scan_library', {
      libraryId: 'L1',
    });
    // Media actions never resolve a torrent engine provider.
    expect(registry.resolve).not.toHaveBeenCalled();
  });
});

describe('AutomationEngine — evaluateEvent (non-torrent event context)', () => {
  const CTX = { provider: 'tmdb', providerShowId: '42', to: 'ended', title: 'Show' };

  function make(rules: unknown[]) {
    const prisma = {
      automationRule: { findMany: jest.fn().mockResolvedValue(rules) },
      automationLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;
    const registry = { resolve: jest.fn() } as any;
    const notifications = { dispatch: jest.fn().mockResolvedValue(undefined) } as any;
    const media = {} as any;
    const mediaActions = { execute: jest.fn().mockResolvedValue(undefined) } as any;
    const rssActions = { execute: jest.fn().mockResolvedValue(undefined) } as any;
    const engine = new AutomationEngine(prisma, registry, notifications, media, mediaActions, rssActions);
    return { engine, prisma, notifications, rssActions };
  }

  it('matches conditions against the event context and delegates an rss_* action', async () => {
    const { engine, rssActions } = make([
      {
        id: 'e1',
        name: 'Disable ended',
        conditions: [{ field: 'to', op: 'eq', value: 'ended' }],
        actions: [{ type: 'disable_rss_rule' }],
      },
    ]);
    await engine.evaluateEvent('rss.show.ended', CTX);
    expect(rssActions.execute).toHaveBeenCalledWith('disable_rss_rule', {}, CTX);
  });

  it('skips a rule whose condition does not match the context', async () => {
    const { engine, rssActions } = make([
      {
        id: 'e2',
        name: 'Only canceled',
        conditions: [{ field: 'to', op: 'eq', value: 'canceled' }],
        actions: [{ type: 'disable_rss_rule' }],
      },
    ]);
    await engine.evaluateEvent('rss.show.ended', CTX);
    expect(rssActions.execute).not.toHaveBeenCalled();
  });

  it('runs notify with the context title and logs success', async () => {
    const { engine, notifications, prisma } = make([
      { id: 'e3', name: 'Ping', conditions: [], actions: [{ type: 'notify' }] },
    ]);
    await engine.evaluateEvent('rss.show_status.changed', CTX);
    expect(notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Show' }),
    );
    expect(prisma.automationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'success' }) }),
    );
  });

  it('logs failure (and does not throw) when a torrent-only action is used', async () => {
    const { engine, prisma } = make([
      { id: 'e4', name: 'Bad', conditions: [], actions: [{ type: 'stop' }] },
    ]);
    await expect(
      engine.evaluateEvent('rss.show.ended', CTX),
    ).resolves.toBeUndefined();
    expect(prisma.automationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
