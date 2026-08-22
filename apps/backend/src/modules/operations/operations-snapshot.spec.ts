import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
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
