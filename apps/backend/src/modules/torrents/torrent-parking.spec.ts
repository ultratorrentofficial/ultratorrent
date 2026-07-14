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
      // Honours orderBy/take on purpose: a query that ranks its candidates and then
      // truncates them must be able to starve here exactly as it would against a real
      // database, or the starvation bug is invisible to these tests.
      findMany: jest.fn(({ where, orderBy, take }: any = {}) => {
        let out = rows.filter((r) =>
          where?.probingSince?.not !== undefined ? r.probingSince != null
          : where?.probingSince === null ? r.probingSince == null
          : true);
        const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        for (const clause of [...clauses].reverse()) { // last key first → stable multi-key sort
          const [field, spec] = Object.entries(clause)[0] as [string, any];
          const dir = (typeof spec === 'string' ? spec : spec.sort) === 'desc' ? -1 : 1;
          const nullsFirst = typeof spec === 'object' && spec?.nulls === 'first';
          out = [...out].sort((a, b) => {
            const av = a[field], bv = b[field];
            if (av == null && bv == null) return 0;
            if (av == null) return nullsFirst ? -1 : 1;
            if (bv == null) return nullsFirst ? 1 : -1;
            return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
          });
        }
        return Promise.resolve(take ? out.slice(0, take) : out);
      }),
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

describe('TorrentParkingService.deadReason', () => {
  it('flags an active torrent with no seeders, no peers and no progress', () => {
    const { svc } = build();
    expect(svc.deadReason(dead(), RULES)).toBe('no_seeders');
  });

  it('spares a torrent still inside its grace period', () => {
    const { svc } = build();
    expect(svc.deadReason(dead({ addedAt: JUST_NOW }), RULES)).toBeNull();
  });

  it('spares a torrent that is actually moving bytes, however slowly', () => {
    const { svc } = build();
    expect(svc.deadReason(dead({ downloadRate: 5000 }), RULES)).toBeNull();
  });

  it('spares a torrent with a seed actually connected — it can still deliver', () => {
    const { svc } = build();
    expect(svc.deadReason(dead({ seedsConnected: 1 }), RULES)).toBeNull();
  });

  it('never touches a QUEUED torrent — it costs no slot and has not announced', () => {
    const { svc } = build();
    expect(svc.deadReason(dead({ state: TorrentState.QUEUED }), RULES)).toBeNull();
  });

  it('never touches a PAUSED torrent — somebody paused that on purpose', () => {
    const { svc } = build();
    expect(svc.deadReason(dead({ state: TorrentState.PAUSED }), RULES)).toBeNull();
  });

  it('never touches a completed/seeding torrent', () => {
    const { svc } = build();
    expect(svc.deadReason(dead({ state: TorrentState.SEEDING, progress: 1 }), RULES)).toBeNull();
  });
});

describe('TorrentParkingService.deadReason — the stall rule (trackers lie)', () => {
  // The synoplex case: 66 of 100 slots held by torrents whose tracker advertised a
  // seeder while they sat at 0 bytes for 24h. minSeeders alone can never free those.
  const claimsSeeders = { seedsTotal: 3, peersConnected: 1 };

  it('spares a tracker-claims-seeders torrent early on — it may yet connect', () => {
    const { svc } = build();
    const oneHourOld = new Date(Date.now() - 3600_000).toISOString();
    expect(svc.deadReason(dead({ ...claimsSeeders, addedAt: oneHourOld }), RULES)).toBeNull();
  });

  it('parks it as stalled once it has moved nothing for hours despite the claim', () => {
    const { svc } = build();
    const day = new Date(Date.now() - 24 * 3600_000).toISOString();
    expect(svc.deadReason(dead({ ...claimsSeeders, addedAt: day }), RULES)).toBe('stalled');
  });

  it('still spares a long-lived torrent that is genuinely downloading', () => {
    const { svc } = build();
    const day = new Date(Date.now() - 24 * 3600_000).toISOString();
    expect(svc.deadReason(dead({ ...claimsSeeders, addedAt: day, downloadRate: 1 }), RULES)).toBeNull();
    expect(svc.deadReason(dead({ ...claimsSeeders, addedAt: day, seedsConnected: 1 }), RULES)).toBeNull();
  });

  it('honours stalledAfterMinutes=0 as "rule off"', () => {
    const { svc } = build();
    const day = new Date(Date.now() - 24 * 3600_000).toISOString();
    const off = { ...RULES, stalledAfterMinutes: 0 };
    expect(svc.deadReason(dead({ ...claimsSeeders, addedAt: day }), off)).toBeNull();
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

  it('releases a probed torrent back into the queue once a seed actually connects', async () => {
    // Mid-probe (force-started), and a real seed is now connected.
    const { svc, provider, rows } = build(
      [dead({ seedsConnected: 2 })],
      [{ hash: 'aaa', engineId: 'e1', name: 'x', probingSince: new Date(), lastProbedAt: null, probeCount: 0 }],
    );

    const summary = await svc.tick();

    expect(summary.revived).toBe(1);
    expect(provider.forceStart).toHaveBeenCalledWith('aaa', false); // back to normal queueing
    expect(provider.resumeTorrent).toHaveBeenCalledWith('aaa');
    expect(rows).toHaveLength(0); // no longer parked
  });

  it('does NOT revive on the tracker\'s claim alone — that is the number that lies', async () => {
    // Tracker says 4 seeders, but nothing is connected and nothing is moving. Reviving
    // here would re-park it next tick, forever.
    const { svc, provider, rows } = build(
      [dead({ seedsTotal: 4 })],
      [{ hash: 'aaa', engineId: 'e1', name: 'x', probingSince: new Date(), lastProbedAt: null, probeCount: 0 }],
    );

    const summary = await svc.tick();

    expect(summary.revived).toBe(0);
    expect(summary.stillDead).toBe(1);
    expect(provider.resumeTorrent).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1); // still parked
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

/**
 * The probe queue must be ranked by *when the next probe falls due*, never by how
 * long ago the last one ran. Backoff grows with `probeCount`, so those two orders
 * are opposites at the head: the torrents probed longest ago are the ones with the
 * longest backoff, and they are never due. Rank by `lastProbedAt` and truncate, and
 * they squat on the whole window forever while the due torrents behind them starve.
 * Production (synoplex): 510 parked, 90 due, 0 probed per tick, for days.
 */
describe('TorrentParkingService — probe selection must not starve', () => {
  const H = 3600_000;

  const parkedRow = (over: Record<string, unknown>) => ({
    probingSince: null,
    engineId: 'e1',
    reason: 'no_seeders',
    ...over,
  }) as any;

  it('probes a due torrent that a fixed window ordered by lastProbedAt would never reach', async () => {
    const now = Date.now();
    // 80 torrents dead for the 7th time. Probed 10h ago — the OLDEST lastProbedAt in
    // the table — but their backoff is capped at 24h, so not one of them is due.
    const longDead = Array.from({ length: 80 }, (_, i) =>
      parkedRow({
        hash: `dead${i}`,
        name: `Long Dead ${i}`,
        lastProbedAt: new Date(now - 10 * H),
        probeCount: 7,
        parkedAt: new Date(now - 100 * H),
      }),
    );
    // Parked once, probed 2h ago against a 1h backoff → due. But its lastProbedAt is
    // the NEWEST, so ordering by lastProbedAt sorts it dead last, behind all 80.
    const fresh = parkedRow({
      hash: 'fresh',
      name: 'Slow Horses S03E05',
      lastProbedAt: new Date(now - 2 * H),
      probeCount: 1,
      parkedAt: new Date(now - 3 * H),
    });

    const inEngine = [...longDead, fresh].map((r) =>
      dead({ hash: r.hash, name: r.name, state: TorrentState.PAUSED }),
    );
    const { svc, provider } = build(inEngine, [...longDead, fresh]);

    const summary = await svc.tick();

    expect(summary.probed).toBe(1);
    expect(provider.forceStart).toHaveBeenCalledWith('fresh', true);
  });

  it('spends a full batch on the most overdue torrents when more are due than fit', async () => {
    const now = Date.now();
    // 30 due torrents, all probed once (1h backoff), overdue by 2h..31h.
    const due = Array.from({ length: 30 }, (_, i) =>
      parkedRow({
        hash: `due${i}`,
        name: `Due ${i}`,
        lastProbedAt: new Date(now - (i + 2) * H), // higher i → more overdue
        probeCount: 1,
        parkedAt: new Date(now - 50 * H),
      }),
    );
    const inEngine = due.map((r) => dead({ hash: r.hash, name: r.name, state: TorrentState.PAUSED }));
    const { svc, provider } = build(inEngine, due);

    const summary = await svc.tick();

    expect(summary.probed).toBe(RULES.probeBatchSize); // 20
    // The most overdue (due29, 31h) is probed; the least (due0, 2h) waits its turn.
    expect(provider.forceStart).toHaveBeenCalledWith('due29', true);
    expect(provider.forceStart).not.toHaveBeenCalledWith('due0', true);
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
