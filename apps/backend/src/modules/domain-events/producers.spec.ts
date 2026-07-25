import { DOMAIN_EVENTS } from '@ultratorrent/shared';
import { EdgeDetector } from './edge-detector';
import { StorageWatchService } from '../system/storage-watch.service';
import { ProviderWatchService } from '../engine/provider-watch.service';

jest.mock('node:fs/promises', () => ({ statfs: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { statfs } = require('node:fs/promises') as { statfs: jest.Mock };

/* ------------------------------------------------------------ edge detector */

describe('EdgeDetector', () => {
  it('never reports an edge on the FIRST observation', () => {
    // Otherwise a restart announces everything already broken as if it just
    // broke — a flood about things that failed while nobody was watching.
    const d = new EdgeDetector();
    expect(d.observe('a', true)).toBeNull();
    expect(d.observe('b', false)).toBeNull();
  });

  it('reports rising and falling once each', () => {
    const d = new EdgeDetector();
    d.observe('a', false);
    expect(d.observe('a', true)).toBe('rising');
    expect(d.observe('a', true)).toBeNull(); // still true — not an event
    expect(d.observe('a', false)).toBe('falling');
    expect(d.observe('a', false)).toBeNull();
  });

  it('tracks keys independently', () => {
    const d = new EdgeDetector();
    d.observe('a', false);
    d.observe('b', false);
    expect(d.observe('a', true)).toBe('rising');
    expect(d.observe('b', true)).toBe('rising');
  });

  it('treats a forgotten key as new rather than comparing to a stale state', () => {
    const d = new EdgeDetector();
    d.observe('a', true);
    d.forget('a');
    // A removed-then-readded thing must not fire a spurious edge.
    expect(d.observe('a', false)).toBeNull();
  });

  it('retainOnly bounds the map to things that still exist', () => {
    const d = new EdgeDetector();
    d.observe('a', true);
    d.observe('b', true);
    d.observe('c', true);
    d.retainOnly(['a']);
    expect(d.size).toBe(1);
    expect(d.peek('b')).toBeUndefined();
  });
});

/* ----------------------------------------------------------- storage watch */

describe('StorageWatchService', () => {
  const build = (roots: string[]) => {
    const published: any[] = [];
    const bus: any = { publish: jest.fn((e: any) => { published.push(e); return { published: true }; }) };
    const config: any = { get: () => roots };
    return { svc: new StorageWatchService(config, bus), published };
  };

  /** statfs returns blocks/bsize; free% is bavail-based. */
  const disk = (freePercent: number) => ({
    blocks: 100, bsize: 1, bavail: freePercent, bfree: freePercent + 5,
  });

  beforeEach(() => statfs.mockReset());

  it('says nothing on the first observation', async () => {
    const { svc, published } = build(['/mnt/a']);
    statfs.mockResolvedValue(disk(2)); // already critical
    await svc.check();
    // Startup must not announce a disk that was already full.
    expect(published).toHaveLength(0);
  });

  it('publishes a warning when free space first crosses the threshold', async () => {
    const { svc, published } = build(['/mnt/a']);
    statfs.mockResolvedValue(disk(40));
    await svc.check();
    statfs.mockResolvedValue(disk(12));
    await svc.check();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      eventKey: DOMAIN_EVENTS.SYSTEM_STORAGE_WARNING,
      resourceId: '/mnt/a',
      payload: { path: '/mnt/a', freePercent: 12 },
    });
  });

  it('escalates to critical without repeating the warning', async () => {
    const { svc, published } = build(['/mnt/a']);
    statfs.mockResolvedValue(disk(40));
    await svc.check();
    statfs.mockResolvedValue(disk(12));
    await svc.check();
    statfs.mockResolvedValue(disk(3));
    await svc.check();

    expect(published.map((e) => e.eventKey)).toEqual([
      DOMAIN_EVENTS.SYSTEM_STORAGE_WARNING,
      DOMAIN_EVENTS.SYSTEM_STORAGE_CRITICAL,
    ]);
  });

  it('does not re-announce a disk that stays full', async () => {
    const { svc, published } = build(['/mnt/a']);
    statfs.mockResolvedValue(disk(40));
    await svc.check();
    statfs.mockResolvedValue(disk(2));
    for (let i = 0; i < 5; i += 1) await svc.check();

    // A full disk stays full; repeating is how a channel gets muted.
    expect(published).toHaveLength(1);
    expect(published[0].eventKey).toBe(DOMAIN_EVENTS.SYSTEM_STORAGE_CRITICAL);
  });

  it('does not claim recovery while still inside the warning band', async () => {
    const { svc, published } = build(['/mnt/a']);
    statfs.mockResolvedValue(disk(40));
    await svc.check();
    statfs.mockResolvedValue(disk(2));
    await svc.check();
    statfs.mockResolvedValue(disk(8)); // out of critical, still warning
    await svc.check();

    // "Recovered" at 8% free would be false.
    expect(published.map((e) => e.eventKey)).not.toContain(DOMAIN_EVENTS.SYSTEM_STORAGE_RECOVERED);
  });

  it('publishes recovery once the disk leaves the warning band entirely', async () => {
    const { svc, published } = build(['/mnt/a']);
    statfs.mockResolvedValue(disk(40));
    await svc.check();
    statfs.mockResolvedValue(disk(8));
    await svc.check();
    statfs.mockResolvedValue(disk(50));
    await svc.check();

    expect(published.at(-1)).toMatchObject({
      eventKey: DOMAIN_EVENTS.SYSTEM_STORAGE_RECOVERED,
      payload: { freePercent: 50 },
    });
  });

  it('stays quiet about an unreadable root rather than guessing', async () => {
    const { svc, published } = build(['/mnt/gone']);
    statfs.mockRejectedValue(new Error('ENOENT'));
    await svc.check();
    await svc.check();
    // An unmounted root is not a disk-space problem.
    expect(published).toHaveLength(0);
  });

  it('uses bavail, not bfree — reserved blocks are not usable space', async () => {
    const { svc, published } = build(['/mnt/a']);
    statfs.mockResolvedValue({ blocks: 100, bsize: 1, bavail: 40, bfree: 45 });
    await svc.check();
    // bavail 4% would be critical; bfree 9% would only warn.
    statfs.mockResolvedValue({ blocks: 100, bsize: 1, bavail: 4, bfree: 9 });
    await svc.check();

    expect(published[0].eventKey).toBe(DOMAIN_EVENTS.SYSTEM_STORAGE_CRITICAL);
  });
});

/* ---------------------------------------------------------- provider watch */

describe('ProviderWatchService', () => {
  const build = (engines: any[], health: (id: string) => any) => {
    const published: any[] = [];
    const bus: any = { publish: jest.fn((e: any) => { published.push(e); return { published: true }; }) };
    const prisma: any = { torrentEngine: { findMany: jest.fn(async () => engines) } };
    const registry: any = {
      resolve: jest.fn(async (id: string) => ({ healthCheck: async () => health(id) })),
    };
    return { svc: new ProviderWatchService(prisma, registry, bus), published };
  };

  const ENGINES = [{ id: 'e1', name: 'qBittorrent', kind: 'qbittorrent' }];

  it('says nothing on the first observation', async () => {
    const { svc, published } = build(ENGINES, () => ({ online: false }));
    await svc.check();
    expect(published).toHaveLength(0);
  });

  it('publishes offline once when an engine goes down', async () => {
    let online = true;
    const { svc, published } = build(ENGINES, () => ({ online, error: online ? null : 'refused' }));
    await svc.check();
    online = false;
    await svc.check();
    await svc.check();
    await svc.check();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      eventKey: DOMAIN_EVENTS.PROVIDER_OFFLINE,
      payload: { providerName: 'qBittorrent', reason: 'refused' },
    });
  });

  it('publishes recovery when it comes back', async () => {
    let online = true;
    const { svc, published } = build(ENGINES, () => ({ online }));
    await svc.check();
    online = false;
    await svc.check();
    online = true;
    await svc.check();

    expect(published.map((e) => e.eventKey)).toEqual([
      DOMAIN_EVENTS.PROVIDER_OFFLINE,
      DOMAIN_EVENTS.PROVIDER_RECOVERED,
    ]);
  });

  it('treats a thrown health check as offline', async () => {
    let fail = false;
    const { svc, published } = build(ENGINES, () => {
      if (fail) throw new Error('unreachable');
      return { online: true };
    });
    await svc.check();
    fail = true;
    await svc.check();

    expect(published[0]).toMatchObject({
      eventKey: DOMAIN_EVENTS.PROVIDER_OFFLINE,
      payload: { reason: 'unreachable' },
    });
  });

  it('only watches enabled engines', async () => {
    const { svc } = build(ENGINES, () => ({ online: true }));
    await svc.check();
    const where = (svc as any).prisma.torrentEngine.findMany.mock.calls[0][0].where;
    // A disabled engine is offline on purpose; saying so is noise.
    expect(where).toMatchObject({ isEnabled: true });
  });
});
