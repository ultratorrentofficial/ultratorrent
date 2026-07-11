import { TorrentState } from '@ultratorrent/shared';
import { TorrentParkingService, DEFAULT_PARKING_RULES } from './torrent-parking.service';

const RULES = { ...DEFAULT_PARKING_RULES, enabled: true };
const HOUR_AGO = new Date(Date.now() - 3600_000).toISOString();
const JUST_NOW = new Date().toISOString();

/** A dead magnet: active, nothing connected, no seeders, past the grace period. */
const dead = (over: Record<string, unknown> = {}) => ({
  hash: 'aaa',
  name: 'Chicago Fire S04E14',
  state: TorrentState.DOWNLOADING, // qBittorrent maps metaDL/stalledDL to this
  progress: 0,
  downloadRate: 0,
  seedsConnected: 0,
  seedsTotal: 0,
  peersConnected: 0,
  peersTotal: 0,
  addedAt: HOUR_AGO,
  engineId: 'e1',
  ...over,
}) as any;

function build(torrents: any[] = [], parked: any[] = []) {
  const provider = {
    engineId: 'e1',
    listTorrents: jest.fn().mockResolvedValue(torrents),
    pauseTorrent: jest.fn().mockResolvedValue(undefined),
    resumeTorrent: jest.fn().mockResolvedValue(undefined),
    forceStart: jest.fn().mockResolvedValue(undefined),
  };
  const rows = [...parked];
  const prisma = {
    parkedTorrent: {
      findMany: jest.fn(({ where }: any = {}) =>
        Promise.resolve(
          rows.filter((r) =>
            where?.probingSince?.not !== undefined ? r.probingSince != null
            : where?.probingSince === null ? r.probingSince == null
            : true),
        ),
      ),
      create: jest.fn(({ data }: any) => { rows.push({ probingSince: null, lastProbedAt: null, probeCount: 0, ...data }); return Promise.resolve(data); }),
      update: jest.fn(({ where, data }: any) => {
        const r = rows.find((x) => x.hash === where.engineId_hash.hash);
        Object.assign(r, data, data.probeCount?.increment ? { probeCount: r.probeCount + 1 } : {});
        return Promise.resolve(r);
      }),
      delete: jest.fn(({ where }: any) => {
        const i = rows.findIndex((x) => x.hash === where.engineId_hash.hash);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve({});
      }),
    },
  };
  const registry = { list: () => [provider], resolve: async () => provider };
  const settings = { get: jest.fn().mockResolvedValue(RULES), set: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  const svc = new TorrentParkingService(
    prisma as any, registry as any, settings as any, audit as any, realtime as any,
  );
  return { svc, provider, prisma, rows, settings };
}

describe('TorrentParkingService.isDead', () => {
  it('flags an active torrent with no seeders, no peers and no progress', () => {
    const { svc } = build();
    expect(svc.isDead(dead(), RULES)).toBe(true);
  });

  it('spares a torrent still inside its grace period', () => {
    const { svc } = build();
    expect(svc.isDead(dead({ addedAt: JUST_NOW }), RULES)).toBe(false);
  });

  it('spares a torrent whose tracker reports seeders (the swarm exists; give it time)', () => {
    const { svc } = build();
    expect(svc.isDead(dead({ seedsTotal: 3 }), RULES)).toBe(false);
  });

  it('spares a torrent that is actually moving bytes', () => {
    const { svc } = build();
    expect(svc.isDead(dead({ downloadRate: 5000 }), RULES)).toBe(false);
    expect(svc.isDead(dead({ seedsConnected: 1 }), RULES)).toBe(false);
    expect(svc.isDead(dead({ peersConnected: 2 }), RULES)).toBe(false);
  });

  it('never touches a QUEUED torrent — it costs no slot and has not announced', () => {
    const { svc } = build();
    expect(svc.isDead(dead({ state: TorrentState.QUEUED }), RULES)).toBe(false);
  });

  it('never touches a PAUSED torrent — somebody paused that on purpose', () => {
    const { svc } = build();
    expect(svc.isDead(dead({ state: TorrentState.PAUSED }), RULES)).toBe(false);
  });

  it('never touches a completed/seeding torrent', () => {
    const { svc } = build();
    expect(svc.isDead(dead({ state: TorrentState.SEEDING, progress: 1 }), RULES)).toBe(false);
  });
});

describe('TorrentParkingService — parking', () => {
  it('pauses a dead torrent and records it, freeing its active slot', async () => {
    const { svc, provider, rows } = build([dead()]);

    const summary = await svc.tick();

    expect(provider.pauseTorrent).toHaveBeenCalledWith('aaa');
    expect(summary.parked).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('leaves a healthy torrent alone', async () => {
    const { svc, provider, rows } = build([dead({ seedsTotal: 10, downloadRate: 900 })]);

    const summary = await svc.tick();

    expect(provider.pauseTorrent).not.toHaveBeenCalled();
    expect(summary.parked).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it('does nothing at all when disabled', async () => {
    const { svc, provider, settings } = build([dead()]);
    settings.get.mockResolvedValue({ ...RULES, enabled: false });

    const summary = await svc.tick();

    expect(provider.listTorrents).not.toHaveBeenCalled();
    expect(summary.parked).toBe(0);
  });

  it('does not re-park something already parked', async () => {
    const { svc, provider } = build([dead()], [{ hash: 'aaa', engineId: 'e1', probingSince: null, lastProbedAt: null, probeCount: 0 }]);

    const summary = await svc.tick();

    expect(summary.parked).toBe(0);
    expect(provider.pauseTorrent).not.toHaveBeenCalled();
  });
});

describe('TorrentParkingService — probing and revival', () => {
  it('force-starts a parked torrent to probe it (a plain resume would just re-queue it, never announcing)', async () => {
    const { svc, provider, rows } = build(
      [dead({ state: TorrentState.PAUSED })],
      [{ hash: 'aaa', engineId: 'e1', name: 'x', probingSince: null, lastProbedAt: null, probeCount: 0 }],
    );

    const summary = await svc.tick();

    expect(provider.forceStart).toHaveBeenCalledWith('aaa', true);
    expect(summary.probed).toBe(1);
    expect(rows[0].probingSince).toBeInstanceOf(Date);
  });

  it('releases a probed torrent back into the queue once seeders reappear', async () => {
    // Mid-probe (force-started), and the tracker now reports seeders.
    const { svc, provider, rows } = build(
      [dead({ seedsTotal: 4 })],
      [{ hash: 'aaa', engineId: 'e1', name: 'x', probingSince: new Date(), lastProbedAt: null, probeCount: 0 }],
    );

    const summary = await svc.tick();

    expect(summary.revived).toBe(1);
    expect(provider.forceStart).toHaveBeenCalledWith('aaa', false); // back to normal queueing
    expect(provider.resumeTorrent).toHaveBeenCalledWith('aaa');
    expect(rows).toHaveLength(0); // no longer parked
  });

  it('re-parks a probed torrent that is still dead, and counts the failure for backoff', async () => {
    const { svc, provider, rows } = build(
      [dead()],
      [{ hash: 'aaa', engineId: 'e1', name: 'x', probingSince: new Date(), lastProbedAt: null, probeCount: 0 }],
    );

    const summary = await svc.tick();

    expect(summary.stillDead).toBe(1);
    expect(summary.revived).toBe(0);
    expect(provider.pauseTorrent).toHaveBeenCalledWith('aaa');
    expect(rows[0].probeCount).toBe(1);
    expect(rows[0].probingSince).toBeNull();
  });

  it('forgets a parked torrent the user deleted from the client', async () => {
    const { svc, rows } = build(
      [], // gone from the engine
      [{ hash: 'aaa', engineId: 'e1', name: 'x', probingSince: new Date(), lastProbedAt: null, probeCount: 0 }],
    );

    await svc.tick();

    expect(rows).toHaveLength(0);
  });
});

describe('TorrentParkingService.isProbeDue — backoff', () => {
  const svc = build().svc;

  it('probes a never-probed torrent immediately', () => {
    expect(svc.isProbeDue({ lastProbedAt: null, probeCount: 0 }, RULES)).toBe(true);
  });

  it('waits the base interval after the first failure', () => {
    const now = Date.now();
    const justProbed = new Date(now - 10 * 60_000); // 10 min ago, interval is 60
    expect(svc.isProbeDue({ lastProbedAt: justProbed, probeCount: 1 }, RULES, now)).toBe(false);
    const longAgo = new Date(now - 61 * 60_000);
    expect(svc.isProbeDue({ lastProbedAt: longAgo, probeCount: 1 }, RULES, now)).toBe(true);
  });

  it('backs off exponentially, so a long-dead torrent stops churning the engine', () => {
    const now = Date.now();
    // 4 failures -> 60 * 2^3 = 480 min.
    const h5 = new Date(now - 5 * 3600_000);
    expect(svc.isProbeDue({ lastProbedAt: h5, probeCount: 4 }, RULES, now)).toBe(false);
    const h9 = new Date(now - 9 * 3600_000);
    expect(svc.isProbeDue({ lastProbedAt: h9, probeCount: 4 }, RULES, now)).toBe(true);
  });

  it('caps the backoff so a torrent is never abandoned forever', () => {
    const now = Date.now();
    const twoDays = new Date(now - 48 * 3600_000);
    expect(svc.isProbeDue({ lastProbedAt: twoDays, probeCount: 99 }, RULES, now)).toBe(true);
  });
});
