import { NotFoundException } from '@nestjs/common';
import { MediaDuplicateService } from './media-duplicate.service';

/**
 * Prisma stand-in for the Duplicate Center read paths. Captures the `where` and
 * `orderBy` the service builds, because the filtering contract IS the feature here —
 * a filter that silently does nothing looks identical to one that works until an
 * operator trusts a count that was never filtered.
 */
function makePrisma(groups: any[] = []) {
  const calls: any = { findMany: [], count: [], update: [] };
  return {
    calls,
    mediaDuplicateGroup: {
      findMany: jest.fn(async (args: any) => { calls.findMany.push(args); return groups; }),
      count: jest.fn(async (args: any) => { calls.count.push(args); return groups.length; }),
      findUnique: jest.fn(async ({ where }: any) => groups.find((g) => g.id === where.id) ?? null),
      update: jest.fn(async (args: any) => { calls.update.push(args); return { ...args.where, ...args.data }; }),
      groupBy: jest.fn(async ({ by }: any) => {
        if (by[0] === 'status') return [{ status: 'open', _count: { _all: 3 } }, { status: 'ignored', _count: { _all: 2 } }];
        if (by[0] === 'groupType') return [{ groupType: 'file', _count: { _all: 4 } }, { groupType: 'show_folder', _count: { _all: 1 } }];
        return [{ reason: 'title_year', _count: { _all: 5 } }];
      }),
      aggregate: jest.fn(async () => ({ _sum: { potentialSavingsBytes: BigInt(2048) } })),
      findFirst: jest.fn(async () => ({ createdAt: new Date('2026-07-20T00:00:00Z') })),
    },
    mediaDuplicateResolution: {
      groupBy: jest.fn(async () => [{ status: 'completed', _count: { _all: 7 } }]),
    },
  } as any;
}

const item = (over: any = {}) => ({
  id: 'i1', title: 'Hotel Mumbai', year: 2019, season: null, episode: null,
  mediaType: 'movie', matchStatus: 'matched', libraryId: 'lib1', path: '/m/a.mkv',
  createdAt: new Date(), updatedAt: new Date(), externalIds: [], library: { id: 'lib1', name: 'Movies' },
  files: [{ size: BigInt(100), resolution: '1080p', videoCodec: 'x265' }], ...over,
});

const group = (over: any = {}) => ({
  id: 'g1', groupKey: 'ty:hotel mumbai:2019', groupType: 'file', reason: 'title_year',
  status: 'open', confidence: 0, requiresReview: false, version: 1,
  potentialSavingsBytes: BigInt(0), recommendedItemId: null, recommendation: null,
  warnings: null, ignoredReason: null, ignoredAt: null, resolvedAt: null,
  createdAt: new Date(), items: [item(), item({ id: 'i2', path: '/m/b.mkv' })], ...over,
});

describe('Duplicate Center — list filtering', () => {
  it('defaults to OPEN groups only', async () => {
    const prisma = makePrisma([group()]);
    await new MediaDuplicateService(prisma).list(undefined, undefined, {});
    expect(prisma.calls.findMany[0].where.status).toBe('open');
    // The count must use the SAME filter, or the total contradicts the rows.
    expect(prisma.calls.count[0].where.status).toBe('open');
  });

  it('reaches through membership for library, media type and search', async () => {
    const prisma = makePrisma([group()]);
    await new MediaDuplicateService(prisma).list(undefined, undefined, {
      libraryId: 'lib1', mediaType: 'movie', q: 'mumbai',
    });
    const some = prisma.calls.findMany[0].where.items.some;
    expect(some.libraryId).toBe('lib1');
    expect(some.mediaType).toBe('movie');
    expect(some.OR).toEqual([
      { title: { contains: 'mumbai', mode: 'insensitive' } },
      { path: { contains: 'mumbai', mode: 'insensitive' } },
    ]);
  });

  it('adds no membership filter when none was asked for', async () => {
    const prisma = makePrisma([group()]);
    await new MediaDuplicateService(prisma).list(undefined, undefined, {});
    expect(prisma.calls.findMany[0].where.items).toBeUndefined();
  });

  it('defaults to needs-review first, then biggest reclaim', async () => {
    const prisma = makePrisma([group()]);
    await new MediaDuplicateService(prisma).list(undefined, undefined, {});
    expect(prisma.calls.findMany[0].orderBy[0]).toEqual({ requiresReview: 'desc' });
    expect(prisma.calls.findMany[0].orderBy[1]).toEqual({ potentialSavingsBytes: 'desc' });
  });

  it('honours an explicit sort', async () => {
    const prisma = makePrisma([group()]);
    await new MediaDuplicateService(prisma).list(undefined, undefined, { sort: 'confidence_asc' });
    expect(prisma.calls.findMany[0].orderBy[0]).toEqual({ confidence: 'asc' });
  });

  it('caps the page size so a client cannot ask for the whole table', async () => {
    const prisma = makePrisma([group()]);
    const res = await new MediaDuplicateService(prisma).list(undefined, '99999', {});
    expect(res.pageSize).toBeLessThanOrEqual(200);
    expect(prisma.calls.findMany[0].take).toBeLessThanOrEqual(200);
  });
});

describe('Duplicate Center — group detail', () => {
  it('separates measured technical data from filename-parsed claims', async () => {
    // The parsed fields are null on ~96% of a renamed library because the renamer
    // strips those tokens. Merging them with measured values would present absent
    // evidence as missing data.
    const prisma = makePrisma([group({
      items: [item({ files: [{ size: BigInt(10), resolution: '1080p', videoCodec: null, width: 1920, height: 1080, bitrateKbps: 4200 }] })],
    })]);
    const detail = await new MediaDuplicateService(prisma).get('g1');
    expect(detail.candidates[0].parsed.resolution).toBe('1080p');
    expect(detail.candidates[0].parsed.videoCodec).toBeNull();
    expect(detail.candidates[0].measured.width).toBe(1920);
    expect(detail.candidates[0].measured.bitrateKbps).toBe(4200);
  });

  it('404s an unknown group instead of returning an empty shell', async () => {
    await expect(new MediaDuplicateService(makePrisma([])).get('nope')).rejects.toThrow(NotFoundException);
  });

  it('exposes the version so a preview can be pinned to it', async () => {
    const detail = await new MediaDuplicateService(makePrisma([group({ version: 7 })])).get('g1');
    expect(detail.version).toBe(7);
  });
});

describe('Duplicate Center — ignore and reopen', () => {
  it('records who ignored it and why', async () => {
    const prisma = makePrisma([group()]);
    await new MediaDuplicateService(prisma).ignore('g1', '  different cuts  ', 'user-9');
    const data = prisma.calls.update[0].data;
    expect(data.status).toBe('ignored');
    expect(data.ignoredReason).toBe('different cuts');
    expect(data.ignoredById).toBe('user-9');
    expect(data.ignoredAt).toBeInstanceOf(Date);
  });

  it('stores no reason rather than an empty string', async () => {
    const prisma = makePrisma([group()]);
    await new MediaDuplicateService(prisma).ignore('g1', '   ', undefined);
    expect(prisma.calls.update[0].data.ignoredReason).toBeNull();
  });

  it('clears both ignore and resolve state on reopen', async () => {
    const prisma = makePrisma([group({ status: 'ignored' })]);
    await new MediaDuplicateService(prisma).reopen('g1');
    const data = prisma.calls.update[0].data;
    expect(data.status).toBe('open');
    expect(data.ignoredReason).toBeNull();
    expect(data.ignoredAt).toBeNull();
    expect(data.resolvedAt).toBeNull();
  });

  it('404s an unknown group', async () => {
    await expect(new MediaDuplicateService(makePrisma([])).ignore('nope', undefined)).rejects.toThrow(NotFoundException);
  });
});

describe('Duplicate Center — overview', () => {
  it('aggregates rather than counting loaded rows', async () => {
    const prisma = makePrisma([group()]);
    const o = await new MediaDuplicateService(prisma).overview();
    expect(o.groups).toEqual({ total: 5, open: 3, ignored: 2, resolved: 0 });
    expect(o.byType).toEqual({ file: 4, showFolder: 1 });
    expect(o.potentialSavingsBytes).toBe(2048);
    expect(o.resolutions).toEqual({ completed: 7 });
    // No group rows were pulled to build the summary.
    expect(prisma.calls.findMany).toHaveLength(0);
  });
});
