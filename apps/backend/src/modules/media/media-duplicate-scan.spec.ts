import { MediaDuplicateService } from './media-duplicate.service';
import { JobCancelledError } from './media-processing-queue.service';

/**
 * Detection as a background job: what it costs, what it skips, and what it says it
 * did.
 *
 * Measured on a live 29,558-item library the old implementation took **10.5 s**
 * inside the HTTP request, most of it spent on ~2,000 sequential writes it made
 * whether or not anything had changed. These tests pin the three properties that
 * fixed: batched writes, a skipped write phase when the input is identical, and a
 * result that reports the run rather than a page of rows.
 */
function makePrisma(items: any[]) {
  const state: any = { digest: null as string | null, transactions: [] as any[][], statements: 0, groups: [] as any[] };
  const chainable = (fn: (args: any) => any) =>
    jest.fn((args: any) => {
      state.statements++;
      return Promise.resolve(fn(args));
    });

  const prisma: any = {
    state,
    mediaItem: {
      findMany: jest.fn(async ({ skip = 0, take = items.length }: any) => items.slice(skip, skip + take)),
      updateMany: chainable(() => ({ count: 0 })),
      count: jest.fn(async () => items.length),
    },
    // Stateful: a rescan has to be observable against rows that already exist,
    // which is the whole question behind "does an ignored group stay ignored".
    mediaDuplicateGroup: {
      findMany: jest.fn(async ({ where }: any) =>
        state.groups.filter((g: any) => (where?.groupKey?.in ?? []).includes(g.groupKey)),
      ),
      createMany: chainable(({ data }: any) => {
        for (const g of data) state.groups.push({ status: 'open', version: 0, ...g });
        return { count: data.length };
      }),
      update: chainable(({ where, data }: any) => {
        const g = state.groups.find((x: any) => x.id === where.id);
        if (g) Object.assign(g, { ...data, version: (g.version ?? 0) + 1 });
        return g ?? {};
      }),
      deleteMany: chainable(({ where }: any) => {
        const keep = state.groups.filter(
          (g: any) => (where?.id?.notIn ?? []).includes(g.id) || g.status !== where?.status,
        );
        const removed = state.groups.length - keep.length;
        state.groups = keep;
        return { count: removed };
      }),
      count: jest.fn(async ({ where }: any = {}) =>
        state.groups.filter((g: any) => (!where?.status || g.status === where.status)).length,
      ),
    },
    mediaDuplicateCandidate: {
      deleteMany: chainable(() => ({ count: 0 })),
      createMany: chainable(() => ({ count: 0 })),
    },
    mediaDuplicateScanState: {
      findUnique: jest.fn(async () => (state.digest ? { id: 'global', inputDigest: state.digest } : null)),
      upsert: jest.fn(async ({ create, update }: any) => {
        state.digest = (update?.inputDigest ?? create.inputDigest) as string;
        return { id: 'global', inputDigest: state.digest };
      }),
    },
    // The digest is computed in SQL against the live rows, so the stand-in derives
    // it from the same `items` the queries return — a test that hard-coded it would
    // pass whether or not a change actually moved the digest.
    $queryRaw: jest.fn(async () => [
      {
        digest: items
          .map((i: any) =>
            [
              i.id, i.mediaType, i.title, i.year ?? '', i.season ?? '', i.episode ?? '', i.path,
              i.files.reduce((n: number, f: any) => n + Number(f.size), 0),
              i.externalIds.map((e: any) => `${e.provider}:${e.externalId}`).sort().join(','),
            ].join('|'),
          )
          .sort()
          .join('\n'),
      },
    ]),
    // Array transactions are how the batching works: one round trip per batch of
    // groups instead of four statements per group.
    $transaction: jest.fn(async (ops: any[]) => {
      state.transactions.push(ops);
      return Promise.all(ops);
    }),
  };
  return prisma;
}

/** Inert stand-ins: what is broadcast is asserted in the events spec, not here. */
const realtime = () => ({ broadcast: jest.fn() }) as any;
const bus = () => ({ emit: jest.fn() }) as any;

/** Two items that are the same movie — one duplicate group. */
const pair = (n: number) => [
  {
    id: `a${n}`, mediaType: 'movie', title: `Movie ${n}`, year: 2019, season: null, episode: null,
    path: `/m/${n}-a.mkv`, updatedAt: new Date('2026-01-01'), externalIds: [],
    files: [{ size: BigInt(1000), height: 1080, width: 1920, bitrateKbps: 5000, durationSec: 6000, audioChannels: 6, resolution: '1080p', videoCodec: 'x265' }],
  },
  {
    id: `b${n}`, mediaType: 'movie', title: `Movie ${n}`, year: 2019, season: null, episode: null,
    path: `/m/${n}-b.mkv`, updatedAt: new Date('2026-01-01'), externalIds: [],
    files: [{ size: BigInt(500), height: 720, width: 1280, bitrateKbps: 2000, durationSec: 6000, audioChannels: 2, resolution: '720p', videoCodec: 'x264' }],
  },
];

describe('Duplicate detection — scan cost and reporting', () => {
  it('reports what the run did, not a page of results', async () => {
    const prisma = makePrisma(pair(1));
    const svc = new MediaDuplicateService(prisma, realtime(), bus());

    const m = await svc.detect();

    // Detection is a command. Returning page 1 of a listing meant a caller could
    // not tell whether anything had been detected, created or removed.
    expect(m.itemsScanned).toBe(2);
    expect(m.groupsDetected).toBe(1);
    expect(m.groupsCreated).toBe(1);
    expect(m.unchanged).toBe(false);
    expect(typeof m.durationMs).toBe('number');
  });

  it('batches group writes into transactions instead of a statement per group', async () => {
    // 60 groups → two batches of 50/10, not 240 sequential round trips.
    const prisma = makePrisma(Array.from({ length: 60 }, (_, i) => pair(i)).flat());
    const svc = new MediaDuplicateService(prisma, realtime(), bus());

    const m = await svc.detect();

    expect(m.groupsDetected).toBe(60);
    expect(prisma.state.transactions).toHaveLength(2);
    expect(prisma.state.transactions[0]).toHaveLength(50 * 4);
    expect(prisma.state.transactions[1]).toHaveLength(10 * 4);
  });

  it('skips the whole write phase when nothing detection reads has changed', async () => {
    const prisma = makePrisma(pair(1));
    const svc = new MediaDuplicateService(prisma, realtime(), bus());

    await svc.detect();
    const writesAfterFirst = prisma.state.statements;
    prisma.state.transactions.length = 0;

    prisma.mediaItem.findMany.mockClear();
    const second = await svc.detect();

    expect(second.unchanged).toBe(true);
    // Not one write, not one transaction — the second run only read.
    expect(prisma.state.transactions).toHaveLength(0);
    expect(prisma.state.statements).toBe(writesAfterFirst);
    expect(prisma.mediaDuplicateScanState.upsert).toHaveBeenCalledTimes(1);
    // And it never loaded the items at all: the digest is answered by the database,
    // which is the whole reason it is computed there rather than over loaded rows.
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it('re-detects once an item changes in a way that can move a group', async () => {
    const items = pair(1);
    const prisma = makePrisma(items);
    const svc = new MediaDuplicateService(prisma, realtime(), bus());
    await svc.detect();

    // A file replaced by a bigger copy changes which one is recommended.
    items[1].files[0].size = BigInt(9000);
    const second = await svc.detect();

    expect(second.unchanged).toBe(false);
    expect(prisma.state.transactions.length).toBeGreaterThan(0);
  });

  it('leaves the digest alone when a run is cancelled, so the next one still works', async () => {
    // Recording the digest for a run that never finished writing would convince the
    // next run that the database already matched the input.
    const prisma = makePrisma(Array.from({ length: 60 }, (_, i) => pair(i)).flat());
    const svc = new MediaDuplicateService(prisma, realtime(), bus());

    let batches = 0;
    const signal = {
      isCancelled: () => batches > 0,
      throwIfCancelled: () => {
        if (batches++ > 0) throw new JobCancelledError();
      },
    };

    await expect(svc.detect(undefined, signal)).rejects.toBeInstanceOf(JobCancelledError);
    expect(prisma.mediaDuplicateScanState.upsert).not.toHaveBeenCalled();
  });

  it('keeps an ignored group ignored across a rescan, and does not re-create it', async () => {
    // The point of persisting an ignore. If a rescan resurrected the group — or
    // filed the same pair under a fresh id — "this is not a duplicate" would be a
    // decision the operator has to re-make after every scan, which is the same as
    // not having it. The group id must survive too: it is what the ignore is on.
    const items = pair(1);
    const prisma = makePrisma(items);
    const svc = new MediaDuplicateService(prisma, realtime(), bus());

    await svc.detect();
    expect(prisma.state.groups).toHaveLength(1);
    const [g] = prisma.state.groups;
    g.status = 'ignored';
    g.ignoredReason = 'different cuts, not duplicates';

    // Force a real run rather than the unchanged fast path.
    items[1].files[0].size = BigInt(4242);
    const second = await svc.detect();

    expect(second.unchanged).toBe(false);
    expect(prisma.state.groups).toHaveLength(1);
    expect(prisma.state.groups[0].id).toBe(g.id);
    expect(prisma.state.groups[0].status).toBe('ignored');
    expect(prisma.state.groups[0].ignoredReason).toBe('different cuts, not duplicates');
    expect(second.groupsCreated).toBe(0);
  });

  it('drops a group detection no longer produces, but only if nobody touched it', async () => {
    // An open group that stopped being detected is stale and goes. An ignored or
    // resolved one is a human decision and is history — deleting it would lose the
    // record and let the false positive return.
    const items = pair(1);
    const prisma = makePrisma(items);
    const svc = new MediaDuplicateService(prisma, realtime(), bus());
    await svc.detect();

    prisma.state.groups.push(
      { id: 'stale-open', groupKey: 'ty:gone:2001', status: 'open', version: 1 },
      { id: 'stale-ignored', groupKey: 'ty:dismissed:2002', status: 'ignored', version: 1 },
    );

    items[1].files[0].size = BigInt(777);
    await svc.detect();

    const ids = prisma.state.groups.map((g: any) => g.id);
    expect(ids).not.toContain('stale-open');
    expect(ids).toContain('stale-ignored');
  });

  it('streams progress so a ten-second scan is not a blank spinner', async () => {
    const prisma = makePrisma(pair(1));
    const svc = new MediaDuplicateService(prisma, realtime(), bus());
    const seen: number[] = [];

    await svc.detect(async (p) => { seen.push(p); });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(100);
    // Monotonic — progress that goes backwards reads as a stuck job.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});
