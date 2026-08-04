import { SchedulerSweepService } from './scheduler-sweep.service';
import { SchedulerModeService } from './scheduler-mode.service';
import { SchedulerCapabilityService } from './scheduler-capability.service';
import { BadRequestException } from '@nestjs/common';

/**
 * Observe Only means Observe Only.
 *
 * The guarantee that matters for an upgrade: an installation that did not ask
 * for a scheduler gets one that does nothing — not even planning — and no code
 * path exists from the sweep to a torrent. These pin both halves, plus the
 * refusal to accept a mode that would imply enforcement while enforcing nothing.
 */
function sweepHarness(configs: Array<{ engineId: string; mode: string }>, engines: string[]) {
  const created: any[] = [];
  const upserts: any[] = [];
  const prisma = {
    torrentSchedulerEngineConfig: {
      findMany: jest.fn(async () => configs),
      upsert: jest.fn(async (args: any) => { upserts.push(args); return args; }),
    },
    torrentSchedulerDecision: {
      create: jest.fn(async (args: any) => { created.push(args); return args; }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const registry = {
    list: jest.fn(() => engines.map((engineId) => ({ engineId, kind: 'qbittorrent' }))),
    get: jest.fn((engineId: string) => ({ engineId, kind: 'qbittorrent' })),
  };
  const previewEngine = jest.fn(async (engineId: string) => ({
    engineId,
    decisions: [
      { hash: 'a', action: 'pause' }, { hash: 'b', action: 'none' }, { hash: 'c', action: 'resume' },
    ],
    summary: { activeDownloads: 1, activeSeeds: 1, totalActive: 2, queuedDownloads: 0, queuedSeeds: 0 },
    limitations: [],
  }));
  const apply = jest.fn(async () => ({
    engineId: 'e1', attempted: 0, applied: 0, failed: 0, unverified: 0,
    limitations: [], failures: [],
  }));
  const bus = { publish: jest.fn(() => ({ published: true })) };
  const svc = new SchedulerSweepService(
    prisma as never, registry as never, { previewEngine } as never, { apply } as never,
    bus as never,
  );
  return { svc, prisma, created, upserts, previewEngine, registry, apply };
}

describe('the sweep', () => {
  it('does no work at all when every engine is native', async () => {
    // An installation that never opted in must not even plan. Planning nobody
    // asked for still costs a query per engine per minute.
    const { svc, previewEngine, created } = sweepHarness(
      [{ engineId: 'e1', mode: 'native' }], ['e1'],
    );
    await svc.tick();
    expect(previewEngine).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('treats an engine with no config row as native', async () => {
    const { svc, previewEngine } = sweepHarness([], ['e1']);
    await svc.tick();
    expect(previewEngine).not.toHaveBeenCalled();
  });

  it('plans for an observing engine but applies nothing', async () => {
    const { svc, created } = sweepHarness([{ engineId: 'e1', mode: 'observe' }], ['e1']);
    await svc.tick();

    expect(created).toHaveLength(1);
    // Two of the three decisions wanted an action; none was applied, and the
    // gap between the two numbers is exactly "what enforcement would change".
    expect(created[0].data.proposedActions).toBe(2);
    expect(created[0].data.appliedActions).toBe(0);
  });

  it('never reconciles an observing engine', async () => {
    // The guarantee that replaced "holds no provider reference" once enforcement
    // existed: observing plans and records, and makes no provider call at all.
    const { svc, apply, created } = sweepHarness([{ engineId: 'e1', mode: 'observe' }], ['e1']);
    await svc.tick();

    expect(apply).not.toHaveBeenCalled();
    expect(created[0].data.appliedActions).toBe(0);
  });

  it('reconciles a managed engine, and records what was applied', async () => {
    const { svc, apply, created } = sweepHarness([{ engineId: 'e1', mode: 'managed' }], ['e1']);
    apply.mockResolvedValueOnce({
      engineId: 'e1', attempted: 2, applied: 2, failed: 0, unverified: 0,
      limitations: [], failures: [],
    } as never);

    await svc.tick();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(created[0].data.proposedActions).toBe(2);
    expect(created[0].data.appliedActions).toBe(2);
  });

  it('records a failure for one engine without abandoning the others', async () => {
    const { svc, created, previewEngine } = sweepHarness(
      [{ engineId: 'bad', mode: 'observe' }, { engineId: 'good', mode: 'observe' }],
      ['bad', 'good'],
    );
    previewEngine.mockImplementationOnce(async () => { throw new Error('engine offline'); });

    await svc.tick();

    // The healthy engine still produced a decision.
    expect(created).toHaveLength(1);
    expect(created[0].data.engineId).toBe('good');
  });

  it('does not overlap itself', async () => {
    const { svc, previewEngine } = sweepHarness([{ engineId: 'e1', mode: 'observe' }], ['e1']);
    // The gate exists BEFORE the mock runs, so releasing it can never race the
    // assignment of the release function.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    previewEngine.mockImplementationOnce(async () => {
      await gate;
      return { engineId: 'e1', decisions: [], summary: {}, limitations: [] } as never;
    });

    const first = svc.tick();
    await svc.tick();               // must be a no-op while the first is running
    release();
    await first;
    expect(previewEngine).toHaveBeenCalledTimes(1);
  });
});

describe('mode changes', () => {
  const build = () => {
    const prisma = {
      torrentSchedulerEngineConfig: {
        findMany: jest.fn(async () => []),
        upsert: jest.fn(async (a: any) => a),
      },
      torrentSchedulerDecision: { findMany: jest.fn(async () => []) },
    };
    const registry = {
      get: jest.fn((id: string) => {
        if (id !== 'e1') throw new Error('nope');
        return { engineId: 'e1', kind: 'qbittorrent' };
      }),
      list: jest.fn(() => [{ engineId: 'e1', kind: 'qbittorrent' }]),
    };
    const audit = { record: jest.fn(async () => undefined) };
    return new SchedulerModeService(
      prisma as never, registry as never, audit as never, new SchedulerCapabilityService(),
      { publish: jest.fn(() => ({ published: true })) } as never,
    );
  };

  it('refuses managed mode while nothing can enforce it', async () => {
    // A mode that claims enforcement and enforces nothing is worse than a
    // missing mode: an operator would stop watching the queue.
    await expect(build().setMode('e1', 'managed')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts native and observe', async () => {
    await expect(build().setMode('e1', 'observe')).resolves.toBeDefined();
    await expect(build().setMode('e1', 'native')).resolves.toBeDefined();
  });

  it('rejects an unknown engine', async () => {
    await expect(build().setMode('nope', 'observe')).rejects.toThrow();
  });

  it('reports every engine as native when nothing was ever configured', async () => {
    const list = await build().list();
    expect(list).toHaveLength(1);
    expect(list[0].mode).toBe('native');
  });
});

describe('capabilities are read off the providers, not wished for', () => {
  const caps = new SchedulerCapabilityService();

  it('marks rTorrent force-start as approximated, not supported', () => {
    // Its provider: "rTorrent has no force flag; priority 3 is the closest
    // equivalent". A boolean would let the UI promise a guarantee it lacks.
    expect(caps.for('rtorrent').forceStart).toBe('approximated');
    expect(caps.for('qbittorrent').forceStart).toBe('native');
  });

  it('admits rTorrent cannot report a queued torrent', () => {
    expect(caps.for('rtorrent').reportsQueuedState).toBe('unsupported');
    expect(caps.for('qbittorrent').reportsQueuedState).toBe('native');
  });

  it('admits neither engine exposes seed duration', () => {
    // Nothing in the repository records it, so time-based seed targets are
    // unenforceable today on both engines.
    expect(caps.for('rtorrent').seedTimeReporting).toBe('unsupported');
    expect(caps.for('qbittorrent').seedTimeReporting).toBe('unsupported');
  });

  it('credits an unknown engine kind with nothing', () => {
    const unknown = caps.for('transmission' as never);
    expect(unknown.pause).toBe('unsupported');
    expect(unknown.nativeQueueModel).toBe('none');
  });
});
