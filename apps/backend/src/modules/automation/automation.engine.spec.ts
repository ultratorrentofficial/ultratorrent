import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, AutomationEngine } from './automation.module';
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
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
    const engine = new AutomationEngine(
      prisma,
      registry,
      notifications,
      media,
      mediaActions,
      rssActions,
      { execute: jest.fn().mockResolvedValue(undefined) } as any,
      audit,
      { get: () => ({ dispatchDirect: async () => ({ enqueued: 0 }) }) } as any,
    );
    return { engine, provider, mediaActions, audit };
  }

  it('fires when the ratio first crosses the threshold', async () => {
    const { engine, provider } = make();
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ ratio: 2.1 }), previous: torrent({ ratio: 1.9 }) },
    ]);
    expect(provider.stopTorrent).toHaveBeenCalledTimes(1);
  });

  it('mirrors a successful run into the audit trail', async () => {
    const { engine, audit } = make();
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ hash: 'HH', name: 'My Torrent', ratio: 2.1 }), previous: torrent({ ratio: 1.9 }) },
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'automation.rule.executed',
        result: 'success',
        objectType: 'torrent',
        objectId: 'HH',
        metadata: expect.objectContaining({ rule: 'Stop at 2.0', actions: ['stop'], name: 'My Torrent' }),
      }),
    );
  });

  it('records a failed run with result=failure and the error', async () => {
    const { engine, provider, audit } = make();
    provider.stopTorrent.mockRejectedValueOnce(new Error('engine offline'));
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ ratio: 2.1 }), previous: torrent({ ratio: 1.9 }) },
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'automation.rule.executed',
        result: 'failure',
        metadata: expect.objectContaining({ rule: 'Stop at 2.0', error: 'engine offline' }),
      }),
    );
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
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
    const engine = new AutomationEngine(
      prisma,
      registry,
      notifications,
      media,
      mediaActions,
      rssActions,
      { execute: jest.fn().mockResolvedValue(undefined) } as any,
      audit,
      { get: () => ({ dispatchDirect: async () => ({ enqueued: 0 }) }) } as any,
    );

    await engine.evaluate('torrent.completed', torrent());

    expect(mediaActions.execute).toHaveBeenCalledWith('media_scan_library', {
      libraryId: 'L1',
    });
    // Media actions never resolve a torrent engine provider.
    expect(registry.resolve).not.toHaveBeenCalled();
  });
});

describe('AutomationEngine — duplicate actions dispatch to media, non-destructively', () => {
  const engineWith = (mediaActions: any) =>
    new AutomationEngine(
      { automationRule: { findMany: jest.fn().mockResolvedValue([{ id: 'd1', name: 'r', conditions: [], actions: [{ type: DUP_ACTION, params: {} }] }]) }, automationLog: { create: jest.fn() } } as any,
      { resolve: jest.fn() } as any,
      { dispatch: jest.fn() } as any,
      {} as any,
      mediaActions,
      { execute: jest.fn() } as any,
      { execute: jest.fn() } as any,
      { record: jest.fn() } as any,
      { get: () => ({ dispatchDirect: async () => ({ enqueued: 0 }) }) } as any,
    );

  let DUP_ACTION = 'media_run_duplicate_scan';

  it.each([
    'media_run_duplicate_scan',
    'media_ignore_duplicate_group',
    'media_duplicate_report',
  ])('routes %s to MediaAutomationActions (never a destructive resolve)', async (action) => {
    DUP_ACTION = action;
    const mediaActions = { execute: jest.fn().mockResolvedValue(undefined) } as any;
    const engine = engineWith(mediaActions);

    await engine.evaluateEvent('media.duplicate_scan_completed', { groupCount: 3 });

    expect(mediaActions.execute).toHaveBeenCalledWith(action, expect.any(Object));
    // Prove the negative the brief cares about: there is no resolve/cleanup action.
    expect(mediaActions.execute).not.toHaveBeenCalledWith(
      expect.stringMatching(/resolve|cleanup|delete/),
      expect.anything(),
    );
  });
});

describe('Automation catalog — duplicate triggers and actions', () => {
  it('registers the duplicate triggers, and no exact-hash trigger that could never fire', () => {
    const ids = AUTOMATION_TRIGGERS.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([
      'media.duplicate_scan_completed',
      'media.duplicate_detected',
      'media.duplicate_requires_review',
      'media.duplicate_cleanup_completed',
      'media.duplicate_cleanup_failed',
    ]));
    // No exact-duplicate trigger: exact match needs content hashing, which does not
    // exist, and a rule that can never fire is worse than an absent one.
    expect(ids).not.toContain('media.exact_duplicate_detected');
  });

  it('offers only non-destructive duplicate actions', () => {
    const ids = AUTOMATION_ACTIONS.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([
      'media_run_duplicate_scan',
      'media_ignore_duplicate_group',
      'media_duplicate_report',
    ]));
    // The line the safety model rests on: no action resolves a duplicate.
    expect(ids.some((id) => /resolve_duplicate|duplicate_cleanup|duplicate_resolve/.test(id))).toBe(false);
  });
});

describe('AutomationEngine — reconcileCompleted (completion backfill)', () => {
  // "Delete on complete" rule with no conditions — should fire on any
  // already-complete torrent that hasn't had it run yet.
  const DELETE_RULE = {
    id: 'd1',
    name: 'Delete on complete',
    conditions: [],
    actions: [{ type: 'delete' }],
  };

  function make(rules: unknown[], existingLogs: unknown[] = []) {
    const provider = { removeTorrent: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      automationRule: { findMany: jest.fn().mockResolvedValue(rules) },
      automationLog: {
        create: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue(existingLogs),
      },
    } as any;
    const registry = { resolve: jest.fn().mockResolvedValue(provider) } as any;
    const notifications = { dispatch: jest.fn().mockResolvedValue(undefined) } as any;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
    const engine = new AutomationEngine(
      prisma,
      registry,
      notifications,
      {} as any,
      { execute: jest.fn() } as any,
      { execute: jest.fn() } as any,
      { execute: jest.fn() } as any,
      audit,
      { get: () => ({ dispatchDirect: async () => ({ enqueued: 0 }) }) } as any,
    );
    return { engine, provider, prisma };
  }

  it('fires a completion rule for an already-complete torrent (no prior edge)', async () => {
    const { engine, provider } = make([DELETE_RULE]);
    await engine.reconcileCompleted([torrent({ hash: 'A', progress: 1 })]);
    expect(provider.removeTorrent).toHaveBeenCalledWith('A');
  });

  it('ignores torrents that are not yet complete', async () => {
    const { engine, provider } = make([DELETE_RULE]);
    await engine.reconcileCompleted([torrent({ hash: 'A', progress: 0.5 })]);
    expect(provider.removeTorrent).not.toHaveBeenCalled();
  });

  it('does not re-run when the rule already succeeded for that torrent', async () => {
    const { engine, provider } = make([DELETE_RULE], [
      { ruleId: 'd1', context: { hash: 'A' } },
    ]);
    await engine.reconcileCompleted([torrent({ hash: 'A', progress: 1 })]);
    expect(provider.removeTorrent).not.toHaveBeenCalled();
  });

  it('skips a torrent whose conditions do not match', async () => {
    const { engine, provider } = make([
      {
        id: 'd2',
        name: 'Only 4K',
        conditions: [{ field: 'name', op: 'contains', value: '2160p' }],
        actions: [{ type: 'delete' }],
      },
    ]);
    await engine.reconcileCompleted([torrent({ hash: 'A', name: '1080p', progress: 1 })]);
    expect(provider.removeTorrent).not.toHaveBeenCalled();
  });

  it('does no work (no ledger query) when no completion rules exist', async () => {
    const { engine, prisma } = make([]);
    await engine.reconcileCompleted([torrent({ hash: 'A', progress: 1 })]);
    expect(prisma.automationLog.findMany).not.toHaveBeenCalled();
  });

  it('retries next cycle on a failed run (not recorded as done)', async () => {
    const { engine, provider, prisma } = make([DELETE_RULE]);
    provider.removeTorrent.mockRejectedValueOnce(new Error('engine offline'));
    await engine.reconcileCompleted([torrent({ hash: 'A', progress: 1 })]);
    expect(prisma.automationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    // No success ledger row was written, so a later cycle would try again.
    await engine.reconcileCompleted([torrent({ hash: 'A', progress: 1 })]);
    expect(provider.removeTorrent).toHaveBeenCalledTimes(2);
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
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
    const engine = new AutomationEngine(prisma, registry, notifications, media, mediaActions, rssActions, { execute: jest.fn().mockResolvedValue(undefined) } as any, audit, { get: () => ({ dispatchDirect: async () => ({ enqueued: 0 }) }) } as any);
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
