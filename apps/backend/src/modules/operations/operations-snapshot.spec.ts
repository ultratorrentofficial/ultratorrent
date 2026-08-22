import { PERMISSIONS, SystemRole, type OperationsTorrents } from '@ultratorrent/shared';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import {
  DEFAULT_ITEM_CAP,
  MAX_ITEM_CAP,
  OperationsSnapshotService,
} from './operations-snapshot.service';

/**
 * The snapshot's RBAC boundary.
 *
 * The property under test is stronger than "a forbidden domain is absent from
 * the response": a forbidden domain must never have been COLLECTED. Absence
 * alone would still mean the backend queried a media server on behalf of
 * someone with no right to know it exists, and a later refactor moving a filter
 * one line down would turn that into a disclosure. So every stub here throws,
 * and the tests assert on what was never called.
 */

const user = (permissions: string[], roles: string[] = [SystemRole.READ_ONLY]): AuthenticatedUser => ({
  id: 'u1',
  username: 'operator',
  roles,
  permissions,
});

/** Every dependency, each of which throws unless a test deliberately allows it. */
function makeService(over: Record<string, unknown> = {}): {
  service: OperationsSnapshotService;
  calls: string[];
} {
  const calls: string[] = [];
  const forbidden = (name: string) =>
    new Proxy(
      {},
      {
        get:
          (_t, prop) =>
          (...args: unknown[]) => {
            calls.push(`${name}.${String(prop)}`);
            void args;
            throw new Error(`${name}.${String(prop)} must not be called`);
          },
      },
    );

  const deps = {
    prisma: forbidden('prisma'),
    registry: forbidden('registry'),
    engineStatus: forbidden('engineStatus'),
    torrentCache: forbidden('torrentCache'),
    dashboard: forbidden('dashboard'),
    system: forbidden('system'),
    intake: forbidden('intake'),
    mediaHealth: forbidden('mediaHealth'),
    sessions: forbidden('sessions'),
    jobs: forbidden('jobs'),
    scheduler: forbidden('scheduler'),
    indexers: forbidden('indexers'),
    prowlarr: forbidden('prowlarr'),
    parking: forbidden('parking'),
    ...over,
  };

  const service = new OperationsSnapshotService(
    deps.prisma as never,
    deps.registry as never,
    deps.engineStatus as never,
    deps.torrentCache as never,
    deps.dashboard as never,
    deps.system as never,
    deps.intake as never,
    deps.mediaHealth as never,
    deps.sessions as never,
    deps.jobs as never,
    deps.scheduler as never,
    deps.indexers as never,
    deps.prowlarr as never,
    deps.parking as never,
  );
  return { service, calls };
}

describe('operations snapshot — permitted domains', () => {
  it('reports only the domains the caller holds the view permission for', () => {
    const { service } = makeService();
    expect(service.permittedDomains(user([PERMISSIONS.TORRENTS_VIEW]))).toEqual(
      expect.arrayContaining(['torrents', 'alerts']),
    );
    expect(service.permittedDomains(user([PERMISSIONS.TORRENTS_VIEW]))).not.toEqual(
      expect.arrayContaining(['system', 'jobs', 'playback']),
    );
  });

  it('gives SUPER_ADMIN every domain, matching the guard’s own short-circuit', () => {
    const { service } = makeService();
    const permitted = service.permittedDomains(user([], [SystemRole.SUPER_ADMIN]));
    expect(permitted).toEqual(
      expect.arrayContaining(['system', 'torrents', 'jobs', 'playback', 'alerts']),
    );
  });

  it('grants nothing on console.view alone', () => {
    // The whole point of the permission: it opens the client, not the data.
    const { service } = makeService();
    expect(service.permittedDomains(user([PERMISSIONS.CONSOLE_VIEW]))).toEqual(['alerts']);
  });
});

describe('operations snapshot — a forbidden domain is never collected', () => {
  it('does not touch any service for a caller with no domain permissions', async () => {
    const { service, calls } = makeService();
    const snapshot = await service.snapshot(user([PERMISSIONS.CONSOLE_VIEW]));

    expect(calls).toEqual([]);
    expect(snapshot.domains.torrents).toEqual({ available: false, reason: 'forbidden' });
    expect(snapshot.domains.playback).toEqual({ available: false, reason: 'forbidden' });
    expect(snapshot.domains.system).toEqual({ available: false, reason: 'forbidden' });
  });

  it('distinguishes "you may not see this" from "this is broken"', async () => {
    // Two different messages that send an operator to two different places.
    const { service } = makeService({
      registry: { list: () => [{ engineId: 'e1', kind: 'qbittorrent' }] },
      engineStatus: {
        get: () => {
          throw new Error('tracker exploded');
        },
      },
    });
    const snapshot = await service.snapshot(
      user([PERMISSIONS.SYSTEM_VIEW]),
      { domains: ['engines', 'torrents'] },
    );

    expect(snapshot.domains.engines).toMatchObject({ available: false, reason: 'unavailable' });
    expect(snapshot.domains.torrents).toEqual({ available: false, reason: 'forbidden' });
  });

  it('collects a domain the caller does hold, and only that one', async () => {
    const { service, calls } = makeService({
      registry: { list: () => [{ engineId: 'e1', kind: 'qbittorrent' }] },
      engineStatus: { get: () => null },
    });
    const snapshot = await service.snapshot(user([PERMISSIONS.SYSTEM_VIEW]), {
      domains: ['engines', 'playback'],
    });

    expect(snapshot.domains.engines).toEqual({
      available: true,
      data: [
        {
          engineId: 'e1',
          kind: 'qbittorrent',
          health: 'unknown',
          lastSeenAt: null,
          error: null,
          version: null,
          torrentCount: null,
        },
      ],
    });
    expect(snapshot.domains.playback).toEqual({ available: false, reason: 'forbidden' });
    expect(calls.filter((c) => c.startsWith('sessions.'))).toEqual([]);
  });
});

describe('operations snapshot — one sick domain degrades only itself', () => {
  it('returns the healthy domain alongside the failed one', async () => {
    const { service } = makeService({
      registry: {
        list: () => {
          throw new Error('registry down');
        },
      },
      dashboard: { recentActivity: async () => [] },
    });
    const snapshot = await service.snapshot(
      user([PERMISSIONS.SYSTEM_VIEW, PERMISSIONS.AUDIT_VIEW]),
      { domains: ['engines', 'recentActivity'] },
    );

    expect(snapshot.domains.engines).toMatchObject({ available: false, reason: 'unavailable' });
    expect(snapshot.domains.recentActivity).toEqual({ available: true, data: [] });
  });

  it('does not put an internal error object on the wire, only its message', async () => {
    const { service } = makeService({
      registry: {
        list: () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
        },
      },
    });
    const snapshot = await service.snapshot(user([PERMISSIONS.SYSTEM_VIEW]), {
      domains: ['engines'],
    });
    const engines = snapshot.domains.engines;
    expect(engines?.available).toBe(false);
    expect(Object.keys(engines as object).sort()).toEqual(['available', 'message', 'reason']);
  });
});

describe('operations snapshot — alerts are derived only from what was read', () => {
  it('raises no torrent alert for a caller who cannot see torrents', async () => {
    const { service } = makeService({
      registry: { list: () => [{ engineId: 'e1', kind: 'qbittorrent' }] },
      engineStatus: {
        get: () => ({
          engineId: 'e1',
          online: false,
          error: 'refused',
          at: '2026-08-22T00:00:00.000Z',
          lastSeenAt: null,
          torrentCount: null,
        }),
      },
    });

    const withEngines = await service.snapshot(user([PERMISSIONS.SYSTEM_VIEW]), {
      domains: ['engines', 'alerts'],
    });
    expect(withEngines.domains.alerts).toMatchObject({ available: true });
    expect((withEngines.domains.alerts as { data: unknown[] }).data).toHaveLength(1);

    // Same failing engine, a caller who may not read engines: no alert leaks
    // the existence of the engine, let alone its state.
    const without = await service.snapshot(user([PERMISSIONS.CONSOLE_VIEW]), {
      domains: ['engines', 'alerts'],
    });
    expect((without.domains.alerts as { data: unknown[] }).data).toEqual([]);
  });
});

describe('operations snapshot — the response is bounded by the server', () => {
  it('clamps a caller-supplied limit to the server cap', async () => {
    const seen: number[] = [];
    const { service } = makeService({
      dashboard: {
        recentActivity: async (limit: number) => {
          seen.push(limit);
          return [];
        },
      },
    });

    await service.snapshot(user([PERMISSIONS.AUDIT_VIEW]), {
      domains: ['recentActivity'],
      limit: 10_000,
    });
    await service.snapshot(user([PERMISSIONS.AUDIT_VIEW]), {
      domains: ['recentActivity'],
      limit: 0,
    });
    await service.snapshot(user([PERMISSIONS.AUDIT_VIEW]), { domains: ['recentActivity'] });

    // Over the cap clamps down; zero/negative clamps up to 1; absent takes the
    // default. A client cannot ask this endpoint for a library scan.
    expect(seen).toEqual([MAX_ITEM_CAP, 1, DEFAULT_ITEM_CAP]);
  });

  it('stamps the contract version and its own cost', async () => {
    const { service } = makeService();
    const snapshot = await service.snapshot(user([PERMISSIONS.CONSOLE_VIEW]), { domains: ['alerts'] });
    expect(snapshot.contractVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof snapshot.durationMs).toBe('number');
    expect(new Date(snapshot.generatedAt).toString()).not.toBe('Invalid Date');
  });
});


describe('operations snapshot — torrents are read, never re-fetched', () => {
  const reading = (engineId: string, torrents: unknown[]) => ({
    engineId,
    at: '2026-08-22T22:47:00.000Z',
    torrents,
    stats: { downloadRate: 100, uploadRate: 50 },
  });

  const torrent = (over: Record<string, unknown> = {}) => ({
    hash: 'abc',
    name: 'Some.Release',
    engineId: 'e1',
    state: 'downloading',
    progress: 0.5,
    size: 100,
    downloadRate: 10,
    uploadRate: 0,
    ratio: 0,
    eta: 60,
    seedsConnected: 2,
    peersConnected: 3,
    addedAt: null,
    completedAt: null,
    message: null,
    ...over,
  });

  it('never asks the engine for its torrents', async () => {
    /*
     * The point of the cache. A provider whose listTorrents() throws proves the
     * collector does not reach for it — this used to be 474ms of a real
     * install's snapshot, once per console per poll.
     */
    const provider = {
      engineId: 'e1',
      kind: 'qbittorrent',
      listTorrents: () => {
        throw new Error('the snapshot must not call this');
      },
      getGlobalStats: () => {
        throw new Error('the snapshot must not call this either');
      },
    };
    const { service } = makeService({
      registry: { list: () => [provider] },
      torrentCache: { get: () => reading('e1', [torrent()]) },
      dashboard: { summary: async () => ({ totalDownloaded: 5, totalUploaded: 6, ratio: 1.2 }) },
      parking: { annotate: async (_e: string, list: unknown[]) => list },
      prisma: { mediaIntakeJob: { findMany: async () => [] } },
    });

    const snapshot = await service.snapshot(user([PERMISSIONS.TORRENTS_VIEW]), {
      domains: ['torrents'],
    });

    expect(snapshot.domains.torrents?.available).toBe(true);
    const data = (snapshot.domains.torrents as { available: true; data: OperationsTorrents }).data;
    expect(data.counts).toMatchObject({ total: 1, downloading: 1 });
    expect(data.rates).toMatchObject({ downloadRate: 100, uploadRate: 50, totalDownloaded: 5 });
  });

  it('reports when the picture was taken, using the OLDEST engine', async () => {
    // One figure for a merged list must show its worst staleness: an engine that
    // stopped answering must not hide behind one polled a second ago.
    const stale = { ...reading('e1', [torrent()]), at: '2026-08-22T21:00:00.000Z' };
    const fresh = reading('e2', [torrent({ engineId: 'e2' })]);
    const byId: Record<string, unknown> = { e1: stale, e2: fresh };

    const { service } = makeService({
      registry: { list: () => [{ engineId: 'e1' }, { engineId: 'e2' }] },
      torrentCache: { get: (id: string) => byId[id] ?? null },
      dashboard: { summary: async () => null },
      parking: { annotate: async (_e: string, list: unknown[]) => list },
      prisma: { mediaIntakeJob: { findMany: async () => [] } },
    });

    const snapshot = await service.snapshot(user([PERMISSIONS.TORRENTS_VIEW]), {
      domains: ['torrents'],
    });
    const data = (snapshot.domains.torrents as { available: true; data: OperationsTorrents }).data;
    expect(data.observedAt).toBe('2026-08-22T21:00:00.000Z');
  });

  it('ignores a reading for an engine the registry no longer knows', async () => {
    // A removed engine must not keep contributing torrents to the picture.
    const { service } = makeService({
      registry: { list: () => [] },
      torrentCache: {
        get: () => {
          throw new Error('should not be consulted for an unknown engine');
        },
      },
      dashboard: { summary: async () => null },
    });

    const snapshot = await service.snapshot(user([PERMISSIONS.TORRENTS_VIEW]), {
      domains: ['torrents'],
    });
    const data = (snapshot.domains.torrents as { available: true; data: OperationsTorrents }).data;
    expect(data.counts.total).toBe(0);
    expect(data.observedAt).toBeNull();
  });

  it('shows nothing rather than zero when no engine has been polled yet', async () => {
    const { service } = makeService({
      registry: { list: () => [{ engineId: 'e1' }] },
      torrentCache: { get: () => null },
      dashboard: { summary: async () => null },
    });

    const snapshot = await service.snapshot(user([PERMISSIONS.TORRENTS_VIEW]), {
      domains: ['torrents'],
    });
    const data = (snapshot.domains.torrents as { available: true; data: OperationsTorrents }).data;
    expect(data.observedAt).toBeNull();
  });
});
