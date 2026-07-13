import { TorrentSyncService } from './torrent-sync.service';

/**
 * The sync tick derives a transition by diffing the engine against the last
 * snapshot. If it ACTS on a transition before recording the new state, then a
 * side-effect that is slow — or that hangs — leaves the snapshot unwritten, and the
 * SAME transition is detected again on the next tick.
 *
 * That deadlock was live: a torrent sitting at 0.9999570 in the snapshot while the
 * engine reported 1.0 re-fired `torrent.completed` every 2 seconds, each time
 * awaiting the full post-download media pipeline, until it had run 5,284 times and
 * finally blocked on an external metadata fetch. The tick's re-entrancy guard is
 * cleared in a `finally`, so that one stuck await killed the whole sync loop — no
 * torrent updates, no automation, no name repair — until the process restarted.
 */
describe('TorrentSyncService — the completed-torrent deadlock', () => {
  const HASH = 'a'.repeat(40);

  const torrent = (progress: number) => ({
    hash: HASH,
    name: 'Show.S01E01.mkv',
    state: progress >= 1 ? 'seeding' : 'downloading',
    progress,
    size: 100,
    downloaded: 100 * progress,
    uploaded: 0,
    ratio: 0,
    downloadRate: 0,
    uploadRate: 0,
    savePath: '/downloads',
    label: null,
    engineId: 'e1',
  });

  function build(opts: { priorProgress: number; mediaHangs?: boolean } = { priorProgress: 0.99 }) {
    const calls: string[] = [];

    const prisma = {
      torrentSnapshot: {
        findMany: jest.fn(async () => {
          calls.push('readPrior');
          return [{ hash: HASH, progress: opts.priorProgress, ratio: 0 }];
        }),
        upsert: jest.fn(),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      // persistSnapshots wraps its upserts in a transaction.
      $transaction: jest.fn(async () => { calls.push('persistSnapshots'); return []; }),
    };
    const mediaProcessing = {
      handleTorrentCompleted: jest.fn(() => {
        calls.push('mediaPipeline');
        // The real pipeline runs for minutes and hits external providers.
        return opts.mediaHangs ? new Promise(() => {}) : Promise.resolve();
      }),
    };
    const automation = {
      evaluate: jest.fn(async () => { calls.push('automation'); }),
      evaluateMany: jest.fn(async () => {}),
      reconcileCompleted: jest.fn(async () => {}),
    };
    const notifications = { dispatch: jest.fn(async () => { calls.push('notify'); }) };
    const nameRepair = { repair: jest.fn(async () => { calls.push('nameRepair'); }) };
    const provider = {
      engineId: 'e1',
      listTorrents: jest.fn(async () => [torrent(1)]), // engine says COMPLETE
      getGlobalStats: jest.fn(async () => ({})),
    };
    const registry = { list: () => [provider] };
    const realtime = { broadcast: jest.fn() };
    const eventBus = { emit: jest.fn() };

    const svc = new TorrentSyncService(
      prisma as any, registry as any, realtime as any, automation as any,
      notifications as any, mediaProcessing as any, eventBus as any, nameRepair as any,
    );
    return { svc, calls, prisma, mediaProcessing, automation, nameRepair };
  }

  it('records the new state BEFORE acting on the transition', async () => {
    const { svc, calls } = build({ priorProgress: 0.9999570 });
    await svc.sync();

    // The snapshot must be written before the side-effects, so the edge cannot
    // re-arm itself if a side-effect is slow or never returns.
    expect(calls.indexOf('persistSnapshots')).toBeLessThan(calls.indexOf('mediaPipeline'));
    expect(calls.indexOf('readPrior')).toBeLessThan(calls.indexOf('persistSnapshots'));
  });

  it('does NOT await the media pipeline — a hanging one cannot wedge the tick', async () => {
    const { svc, calls, mediaProcessing } = build({ priorProgress: 0.9999570, mediaHangs: true });

    // The pipeline never resolves. The tick must still complete.
    await expect(svc.sync()).resolves.toBeUndefined();

    expect(mediaProcessing.handleTorrentCompleted).toHaveBeenCalledTimes(1);
    // …and everything after it still ran. Before the fix, the name repair (which is
    // last) never executed at all: 15 repairable torrents sat broken indefinitely.
    expect(calls).toContain('nameRepair');
  });

  it('the sync loop survives a hanging pipeline and keeps ticking', async () => {
    const { svc, prisma } = build({ priorProgress: 0.9999570, mediaHangs: true });

    await svc.sync();
    await svc.sync();
    await svc.sync();

    // The re-entrancy guard is cleared in a `finally`; if the tick had hung, the
    // 2nd and 3rd calls would have returned immediately and written nothing.
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('fires nothing when the torrent was already complete at the last snapshot', async () => {
    const { svc, mediaProcessing, automation } = build({ priorProgress: 1 });
    await svc.sync();
    expect(mediaProcessing.handleTorrentCompleted).not.toHaveBeenCalled();
    expect(automation.evaluate).not.toHaveBeenCalled();
  });

  it('still fires the completion side-effects on a genuine edge', async () => {
    const { svc, calls, mediaProcessing } = build({ priorProgress: 0.5 });
    await svc.sync();
    expect(mediaProcessing.handleTorrentCompleted).toHaveBeenCalledTimes(1);
    expect(calls).toContain('notify');
    expect(calls).toContain('automation');
  });
});
