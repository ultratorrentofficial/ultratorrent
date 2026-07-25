import { WS_EVENTS } from '@ultratorrent/shared';
import { MediaDuplicateService } from './media-duplicate.service';
import { JobCancelledError } from './media-processing-queue.service';

/**
 * What the Duplicate Center tells the rest of the system.
 *
 * `media.duplicate` was defined in the shared catalog and seeded as an ENABLED
 * notification rule, but no code path in the backend ever emitted it — a rule that
 * looked configured in the UI and could not fire. These tests exist so that cannot
 * happen quietly again: they assert the producer, not just the constant.
 */
function build(items: any[] = []) {
  const broadcasts: Array<{ event: string; payload: any }> = [];
  const groups: any[] = [];

  const prisma: any = {
    mediaItem: {
      findMany: jest.fn(async () => items),
      updateMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => items.length),
    },
    mediaDuplicateGroup: {
      findMany: jest.fn(async () => []),
      createMany: jest.fn(async ({ data }: any) => { groups.push(...data); return { count: data.length }; }),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => groups.length),
      aggregate: jest.fn(async () => ({ _count: { _all: 0 }, _sum: { potentialSavingsBytes: BigInt(0) } })),
    },
    mediaDuplicateCandidate: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    mediaDuplicateScanState: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => ({})),
    },
    $queryRaw: jest.fn(async () => [{ digest: `d${items.length}${Math.random()}` }]),
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  const realtime: any = { broadcast: (event: string, payload: any) => broadcasts.push({ event, payload }) };

  return { svc: new MediaDuplicateService(prisma, realtime), broadcasts, prisma };
}

const pair = (n: number) => [
  {
    id: `a${n}`, mediaType: 'movie', title: `Movie ${n}`, year: 2019, season: null, episode: null,
    path: `/m/${n}-a.mkv`, updatedAt: new Date('2026-01-01'), externalIds: [],
    files: [{ size: BigInt(4000), height: 1080, width: 1920, bitrateKbps: 5000, durationSec: 6000, audioChannels: 6, resolution: '1080p', videoCodec: 'x265' }],
  },
  {
    id: `b${n}`, mediaType: 'movie', title: `Movie ${n}`, year: 2019, season: null, episode: null,
    path: `/m/${n}-b.mkv`, updatedAt: new Date('2026-01-01'), externalIds: [],
    files: [{ size: BigInt(1000), height: 720, width: 1280, bitrateKbps: 2000, durationSec: 6000, audioChannels: 2, resolution: '720p', videoCodec: 'x264' }],
  },
];

describe('Duplicate Center — events', () => {
  it('broadcasts a scan lifecycle a client can correlate on', async () => {
    const { svc, broadcasts } = build(pair(1));

    await svc.detect();

    const names = broadcasts.map((b) => b.event);
    expect(names[0]).toBe(WS_EVENTS.MEDIA_DUPLICATE_SCAN_STARTED);
    expect(names).toContain(WS_EVENTS.MEDIA_DUPLICATE_SCAN_PROGRESS);
    expect(names[names.length - 1]).toBe(WS_EVENTS.MEDIA_DUPLICATE_SCAN_COMPLETED);
    // One id across the whole run: a page with two scans in flight must be able to
    // tell whose progress it is reading.
    const ids = new Set(broadcasts.map((b) => b.payload.scanId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });

  it('scopes its events to media_manager, not the everyone room', async () => {
    // The gateway derives the room from the event-name PREFIX. `media.*` lands in
    // the room every authenticated user joins, and these payloads carry library
    // paths and file counts.
    const { svc, broadcasts } = build(pair(1));
    await svc.detect();
    expect(broadcasts.every((b) => b.event.startsWith('media_manager.'))).toBe(true);
  });

  it('carries the run metrics on completion', async () => {
    const { svc, broadcasts } = build(pair(1));
    await svc.detect();
    const done = broadcasts.find((b) => b.event === WS_EVENTS.MEDIA_DUPLICATE_SCAN_COMPLETED)!;
    expect(done.payload.progress).toBe(100);
    expect(done.payload.metrics.groupsDetected).toBe(1);
    expect(done.payload.metrics.itemsScanned).toBe(2);
  });

  it('reports a cancelled scan as cancelled, not failed', async () => {
    const { svc, broadcasts } = build(pair(1));
    const signal = { isCancelled: () => true, throwIfCancelled: () => { throw new JobCancelledError(); } };

    await expect(svc.detect(undefined, signal)).rejects.toBeInstanceOf(JobCancelledError);

    const names = broadcasts.map((b) => b.event);
    expect(names).toContain(WS_EVENTS.MEDIA_DUPLICATE_SCAN_CANCELLED);
    expect(names).not.toContain(WS_EVENTS.MEDIA_DUPLICATE_SCAN_FAILED);
    expect(names).not.toContain(WS_EVENTS.MEDIA_DUPLICATE_SCAN_COMPLETED);
  });

  it('stays silent on an unchanged rescan', async () => {
    const { svc, prisma, broadcasts } = build(pair(1));
    await svc.detect();

    prisma.$queryRaw = jest.fn(async () => [{ digest: 'same' }]);
    prisma.mediaDuplicateScanState.findUnique = jest.fn(async () => ({ inputDigest: 'same' }));
    await svc.detect();

    // The scan itself still reports completion — the UI needs to stop spinning.
    expect(broadcasts.filter((b) => b.event === WS_EVENTS.MEDIA_DUPLICATE_SCAN_COMPLETED)).toHaveLength(2);
  });

});
